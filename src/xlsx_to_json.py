"""予測レポート (RES.xlsx) + 実績在庫 (_1.xlsx) + 実行ログ を JSON dict に変換.

フロントエンド (forecast.json shape) に互換な構造を返す.
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from src.io_reader import read_inventory, read_forecast_result


# 形式1 (旧テストフィクスチャ): "ホールドアウト MAPE [%] (制約あり): 67.3"
# 形式2 (実ログ):              "  - MAPE (制約あり): 66.7%"
_MAPE_RE = re.compile(r"MAPE[^:\n]*\(制約あり\)[^:]*:\s*([0-9.]+)")
_WARN_COUNT_RE = re.compile(r"警告数:\s*([0-9]+)")
_WARN_LINE_RE = re.compile(r"^\[WARNING\]", re.MULTILINE)


def _parse_sku_id(sku_id: str) -> tuple[str, str, str]:
    parts = sku_id.split("_")
    brand = parts[0] if parts else sku_id
    diameter = parts[1] if len(parts) > 1 else ""
    form = "_".join(p for p in parts[2:] if p) if len(parts) > 2 else ""
    return brand, diameter, form


def _display_name(brand: str, diameter: str, form: str) -> str:
    s = brand
    if diameter:
        s += f" φ{diameter}"
    if form:
        s += f" / {form}kg"
    return s


def _parse_log(log_text: str) -> dict[str, Any]:
    mape: float | None = None
    m = _MAPE_RE.search(log_text)
    if m:
        try:
            mape = float(m.group(1))
        except ValueError:
            pass
    warnings: int | None = None
    wm = _WARN_COUNT_RE.search(log_text)
    if wm:
        try:
            warnings = int(wm.group(1))
        except ValueError:
            pass
    if warnings is None:
        n = len(_WARN_LINE_RE.findall(log_text))
        warnings = n if n > 0 else None
    return {"mape_constrained": mape, "warnings": warnings}


def _is_nan(v: Any) -> bool:
    return isinstance(v, float) and math.isnan(v)


def _scalar(v: Any) -> Any:
    """pandas が複数行マッチ時 Series を返すケースの平坦化."""
    if hasattr(v, "iloc"):
        v = v.iloc[0]
    return v


def convert_to_dict(
    res_path: str | Path,
    actual_path: str | Path | None = None,
    log_path: str | Path | None = None,
) -> dict[str, Any]:
    """RES.xlsx + _1.xlsx + ログ → フロント用 dict."""
    res_df = read_forecast_result(str(res_path))
    if len(res_df) == 0:
        raise ValueError(f"RES.xlsx にデータがありません: {res_path}")

    months: list[str] = sorted(res_df["year_month"].unique().tolist())

    sku_records: list[dict[str, Any]] = []
    for sku_id, grp in res_df.groupby("sku_id"):
        by_ym = grp.set_index("year_month")

        def _arr(col: str, *, as_int: bool = False) -> list[Any]:
            out: list[Any] = []
            for ym in months:
                if ym not in by_ym.index:
                    out.append(None)
                    continue
                v = _scalar(by_ym.loc[ym, col])
                if v is None or _is_nan(v):
                    out.append(None)
                elif as_int:
                    out.append(int(v))
                else:
                    out.append(float(v))
            return out

        order = [v if v is not None else 0.0 for v in _arr("入庫_予測")]
        forecast = [v if v is not None else 0.0 for v in _arr("出庫_予測")]
        stock = _arr("在庫_予測")
        stock_eval = _arr("在庫評価", as_int=True)
        confirmed = _arr("発注済量")
        brand, diameter, form = _parse_sku_id(sku_id)
        sku_records.append({
            "sku": sku_id,
            "display_name": _display_name(brand, diameter, form),
            "brand": brand,
            "diameter": diameter,
            "form": form,
            "monthly_order": [round(v, 1) for v in order],
            "monthly_forecast": [round(v, 1) for v in forecast],
            "monthly_stock": [round(v, 1) if v is not None else None for v in stock],
            "monthly_stock_eval": stock_eval,
            "monthly_confirmed_kg": [round(v, 1) if v is not None else None for v in confirmed],
            "total_forecast_12m": round(sum(forecast), 1),
            "total_order_12m": round(sum(order), 1),
            "has_real_forecast": any(v != 0.0 for v in forecast),
            "stock_evaluation_yama": None,
            "stock_evaluation_ym": None,
            "current_stock_kg": None,
        })

    sku_records.sort(key=lambda s: s["total_forecast_12m"], reverse=True)

    # 実績 _1.xlsx から current_stock_kg / 最新在庫評価 / series(actual)
    actual_series: dict[str, float] = {}
    if actual_path is not None and Path(actual_path).exists():
        actual_df = read_inventory(str(actual_path))
        if len(actual_df) > 0:
            for sku_id, grp in actual_df.groupby("sku_id"):
                stock_rows = grp[grp["在庫"].notna()].sort_values("year_month")
                eval_rows = grp[grp["在庫評価"].notna()].sort_values("year_month")
                current = float(stock_rows.iloc[-1]["在庫"]) if len(stock_rows) > 0 else None
                latest_eval = eval_rows.iloc[-1] if len(eval_rows) > 0 else None
                for rec in sku_records:
                    if rec["sku"] == sku_id:
                        rec["current_stock_kg"] = current
                        if latest_eval is not None:
                            rec["stock_evaluation_yama"] = int(latest_eval["在庫評価"])
                            rec["stock_evaluation_ym"] = str(latest_eval["year_month"])
                        break
            by_ym = actual_df.groupby("year_month")["出庫"].sum()
            for ym, val in by_ym.items():
                actual_series[str(ym)] = float(val)

    series: list[dict[str, Any]] = []
    for ym in sorted(actual_series.keys()):
        if ym in months:
            continue
        series.append({
            "ym": ym,
            "actual": round(actual_series[ym], 1),
            "forecast": None,
        })

    forecast_by_ym: dict[str, float] = {ym: 0.0 for ym in months}
    for rec in sku_records:
        for i, ym in enumerate(months):
            forecast_by_ym[ym] += rec["monthly_forecast"][i]
    for ym in months:
        series.append({
            "ym": ym,
            "actual": None,
            "forecast": round(forecast_by_ym[ym], 1),
        })

    summary: dict[str, Any] = {
        "total_forecast_kg": round(sum(forecast_by_ym.values())),
        "warnings": None,
        "mape_constrained": None,
        "eval_match_rate": None,
    }
    if log_path is not None and Path(log_path).exists():
        log_text = Path(log_path).read_text(encoding="utf-8", errors="replace")
        summary.update(_parse_log(log_text))

    return {
        "generated_at": datetime.fromtimestamp(
            Path(res_path).stat().st_mtime
        ).strftime("%Y-%m-%d %H:%M:%S"),
        "period_start": months[0],
        "period_end": months[-1],
        "months": months,
        "summary": summary,
        "series": series,
        "skus": sku_records,
    }
