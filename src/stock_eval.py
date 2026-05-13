"""在庫評価1-5の自動判別."""
import pandas as pd
from typing import Optional


_BANDS = [
    (1.00, 1),
    (1.75, 2),
    (2.25, 3),
    (2.75, 4),
    (float("inf"), 5),
]


def classify_stock_score(stock: float, avg_m: float) -> Optional[int]:
    """在庫/過去3ヶ月平均使用量から1-5を判別.

    Args:
        stock: 当月末在庫量
        avg_m: 過去3ヶ月の月平均使用量
    Returns: 1-5 のスコア、avg_mが0なら None
    """
    if avg_m is None or avg_m <= 0:
        return None
    ratio = stock / avg_m
    for upper, score in _BANDS:
        if ratio <= upper:
            return score
    return 5


def _prior_three_months(ym: str) -> list:
    """ym の直前3ヶ月の 'YYYY-MM' を返す (新→旧の順)."""
    y, m = int(ym[:4]), int(ym[5:7])
    result = []
    for _ in range(3):
        m -= 1
        if m == 0:
            m = 12
            y -= 1
        result.append(f"{y:04d}-{m:02d}")
    return result


def compute_stock_evaluation(
    inventory: pd.DataFrame,
    consumption: pd.DataFrame,
) -> pd.DataFrame:
    """各 (sku_id, year_month) の在庫評価を計算.

    拠点 (大西/波止浜等) は sku × year_month で在庫合算してから評価する.
    過去3ヶ月 (当月除く) の月平均使用量 = M
    Returns: columns: sku_id, year_month, 在庫, 過去3ヶ月平均, 評価 (1-5 or None)
    """
    if len(inventory) == 0:
        return pd.DataFrame(columns=["sku_id", "year_month", "在庫", "過去3ヶ月平均", "評価"])
    inv_agg = (
        inventory.groupby(["sku_id", "year_month"], as_index=False)
        .agg({"在庫": "sum"})
    )
    cons_idx = consumption.set_index(["sku_id", "year_month"])["qty_kg"].to_dict()
    records = []
    for _, ir in inv_agg.iterrows():
        sku = ir["sku_id"]
        ym = ir["year_month"]
        prior = _prior_three_months(ym)
        vals = [cons_idx.get((sku, p), 0.0) for p in prior]
        avg = sum(vals) / 3.0
        score = classify_stock_score(ir["在庫"], avg)
        records.append({
            "sku_id": sku,
            "year_month": ym,
            "在庫": ir["在庫"],
            "過去3ヶ月平均": avg,
            "評価": score,
        })
    return pd.DataFrame(records)


def compute_forecast_stock_evaluation(
    forecast_monthly: pd.DataFrame,
    consumption_history: pd.DataFrame,
    current_stock: pd.DataFrame,
) -> pd.DataFrame:
    """予測使用量から将来在庫評価を計算.

    Args:
        forecast_monthly: columns: year_month, sku_id, 予測使用量
        consumption_history: 過去実績 columns: year_month, sku_id, qty_kg
        current_stock: 現在在庫 columns: sku_id, 在庫
    Returns: year_month, sku_id, 予測在庫, 過去3ヶ月平均, 予測在庫評価
    """
    if len(forecast_monthly) == 0:
        return pd.DataFrame(columns=["year_month", "sku_id", "予測在庫評価"])
    history = pd.concat([
        consumption_history.rename(columns={"qty_kg": "qty"})[["year_month", "sku_id", "qty"]],
        forecast_monthly.rename(columns={"予測使用量": "qty"})[["year_month", "sku_id", "qty"]],
    ], ignore_index=True)
    history_idx = history.set_index(["sku_id", "year_month"])["qty"].to_dict()

    stock_map = dict(zip(current_stock["sku_id"], current_stock["在庫"]))
    fc_sorted = forecast_monthly.sort_values(["sku_id", "year_month"])
    records = []
    for sku, g in fc_sorted.groupby("sku_id"):
        running = stock_map.get(sku, 0.0) or 0.0
        for _, row in g.iterrows():
            ym = row["year_month"]
            usage = row["予測使用量"]
            running = running - usage
            prior = _prior_three_months(ym)
            vals = [history_idx.get((sku, p), 0.0) for p in prior]
            avg = sum(vals) / 3.0
            score = classify_stock_score(running, avg)
            records.append({
                "year_month": ym,
                "sku_id": sku,
                "予測在庫": running,
                "過去3ヶ月平均": avg,
                "予測在庫評価": score,
            })
    return pd.DataFrame(records)


def compare_with_existing_evaluation(
    computed: pd.DataFrame,
    existing_inventory: pd.DataFrame,
) -> dict:
    """compute_stock_evaluation の結果と、入力Excelの「在庫評価」列を比較.

    Returns:
        {
            "total": int,
            "matched": int,
            "match_rate": float (0-1),
            "mismatches": pd.DataFrame
        }
    """
    if len(computed) == 0 or "在庫評価" not in existing_inventory.columns:
        return {"total": 0, "matched": 0, "match_rate": float("nan"),
                "mismatches": pd.DataFrame()}
    ex = existing_inventory[existing_inventory["在庫評価"].notna()].copy()
    ex_by_key = (
        ex.groupby(["sku_id", "year_month"])["在庫評価"]
        .first()
        .reset_index()
        .rename(columns={"在庫評価": "existing_score"})
    )
    merged = computed.merge(ex_by_key, on=["sku_id", "year_month"], how="inner")
    merged = merged[merged["評価"].notna()]
    if len(merged) == 0:
        return {"total": 0, "matched": 0, "match_rate": float("nan"),
                "mismatches": pd.DataFrame()}
    merged["match"] = merged["評価"].astype(int) == merged["existing_score"].astype(int)
    total = len(merged)
    matched = int(merged["match"].sum())
    mismatches = merged[~merged["match"]][["sku_id", "year_month", "評価", "existing_score"]]
    return {
        "total": total,
        "matched": matched,
        "match_rate": matched / total,
        "mismatches": mismatches.rename(
            columns={"評価": "computed", "existing_score": "existing"}
        ),
    }
