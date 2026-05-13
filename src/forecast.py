"""月次予測使用量の生成 (SKU区分別 shape 適用版)."""
from calendar import monthrange
import numpy as np
import pandas as pd

from src.ship_window import _iter_months, _month_overlap_days
from src.shape_curve import compute_rel_month


def apply_ratio_constraint(
    forecast: pd.DataFrame,
    consumption_history: pd.DataFrame,
    lookback_months: int = 12,
    target_ratio: float = 1.0,
    tol: float = 0.10,
    mode: str = "match",
) -> pd.DataFrame:
    """forecast 期間の SKU 別総量を過去 lookback_months と比較し scale 調整.

    mode:
      - "match": 予測総量 ≠ target_total なら target に強制
      - "floor": 予測総量 < target_total × (1-tol) の場合のみ scale up (下限保証)
      - "ceiling": 予測総量 > target_total × (1+tol) の場合のみ scale down (上限制約)

    Returns: 同じ schema の DataFrame、 予測使用量が補正済み.
    """
    if mode not in ("match", "floor", "ceiling"):
        raise ValueError(f"unknown mode: {mode}")
    if len(forecast) == 0 or len(consumption_history) == 0:
        return forecast.copy()
    fc = forecast.copy()
    n_fc = fc["year_month"].nunique()
    if n_fc == 0:
        return fc

    recent_months = sorted(consumption_history["year_month"].unique())[-lookback_months:]
    if not recent_months:
        return fc
    past = (
        consumption_history[consumption_history["year_month"].isin(recent_months)]
        .groupby("sku_id")["qty_kg"].sum().rename("past_total").reset_index()
    )
    actual_lookback = len(recent_months)
    past["target_total"] = past["past_total"] / actual_lookback * n_fc * target_ratio

    fc_total = fc.groupby("sku_id")["予測使用量"].sum().rename("fc_total").reset_index()
    merged = fc_total.merge(past, on="sku_id", how="left")
    merged["scale"] = 1.0
    valid = (merged["fc_total"] > 0) & (merged["target_total"].notna()) & (merged["target_total"] > 0)

    if mode == "match":
        merged.loc[valid, "scale"] = merged.loc[valid, "target_total"] / merged.loc[valid, "fc_total"]
        lo, hi = (1.0 - tol), (1.0 + tol)
        in_band = (merged["scale"] >= lo) & (merged["scale"] <= hi)
        merged.loc[in_band, "scale"] = 1.0
    elif mode == "floor":
        # forecast が target × (1-tol) 未満なら、 target まで引き上げ
        floor_threshold = (1.0 - tol)
        below = valid & (merged["fc_total"] < merged["target_total"] * floor_threshold)
        merged.loc[below, "scale"] = merged.loc[below, "target_total"] / merged.loc[below, "fc_total"]
    elif mode == "ceiling":
        # forecast が target × (1+tol) 超過なら、 target まで引き下げ
        ceil_threshold = (1.0 + tol)
        above = valid & (merged["fc_total"] > merged["target_total"] * ceil_threshold)
        merged.loc[above, "scale"] = merged.loc[above, "target_total"] / merged.loc[above, "fc_total"]

    fc = fc.merge(merged[["sku_id", "scale"]], on="sku_id", how="left").fillna({"scale": 1.0})
    fc["予測使用量"] = fc["予測使用量"] * fc["scale"]
    return fc.drop(columns=["scale"])


def _build_weights_with_category_shape(
    ships: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    rel_month_length: int,
) -> pd.DataFrame:
    """各 (s_no, year_month) で active_ratio と rel_month を計算.

    shape factor は SKU 区分依存なので、ここでは付与しない。SKU 結合後に付与する。
    """
    months = list(_iter_months(start_ym, end_ym))
    records = []
    for _, ship in ships.iterrows():
        cs = ship["consume_start"]
        ce = ship["consume_end"]
        st = ship["ship_type"]
        for ym in months:
            y, m = int(ym[:4]), int(ym[5:7])
            days = monthrange(y, m)[1]
            overlap = _month_overlap_days(cs, ce, y, m)
            if overlap == 0:
                continue
            active_ratio = overlap / days
            rel_m = compute_rel_month(cs, ce, ym, rel_month_length)
            if rel_m == 0:
                continue
            records.append({
                "s_no": ship["s_no"],
                "ship_type": st,
                "year_month": ym,
                "rel_month": rel_m,
                "active_ratio": active_ratio,
            })
    if not records:
        return pd.DataFrame(columns=["s_no", "ship_type", "year_month", "rel_month", "active_ratio"])
    return pd.DataFrame(records)


def _apply_shape_to_row(row, sku_id_to_cat, shape, rel_month_length):
    """1行分の shape factor を計算."""
    cat = sku_id_to_cat.get(row["sku_id"])
    arr = shape.get(cat) if cat else None
    if arr is None or len(arr) == 0:
        return 1.0 / rel_month_length
    return float(arr[row["rel_month"] - 1])


def generate_monthly_forecast(
    ships: pd.DataFrame,
    unit_consumption: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    materials: pd.DataFrame | None = None,
    shape: dict | None = None,
    rel_month_length: int = 20,
) -> pd.DataFrame:
    """SKU区分別 shape を用いた月次予測.

    Returns: forecast_monthly DataFrame
      columns: year_month, sku_id, 予測使用量
    """
    if len(ships) == 0 or len(unit_consumption) == 0:
        return pd.DataFrame(columns=["year_month", "sku_id", "予測使用量"])
    weights = _build_weights_with_category_shape(
        ships, start_ym, end_ym, rel_month_length,
    )
    if len(weights) == 0:
        return pd.DataFrame(columns=["year_month", "sku_id", "予測使用量"])
    if materials is None:
        sku_id_to_cat = {}
    else:
        sku_id_to_cat = dict(zip(materials["sku_id"], materials["区分"]))
    shape_dict = shape or {}

    joined = weights.merge(
        unit_consumption[["ship_type", "sku_id", "kg_per_ship"]],
        on="ship_type", how="inner",
    )
    joined["shape_factor"] = joined.apply(
        lambda r: _apply_shape_to_row(r, sku_id_to_cat, shape_dict, rel_month_length),
        axis=1,
    )
    joined["qty"] = joined["active_ratio"] * joined["shape_factor"] * joined["kg_per_ship"]
    forecast = (
        joined.groupby(["year_month", "sku_id"])["qty"]
        .sum().reset_index()
        .rename(columns={"qty": "予測使用量"})
    )
    return forecast


def generate_per_ship_forecast(
    ships: pd.DataFrame,
    unit_consumption: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    materials: pd.DataFrame | None = None,
    shape: dict | None = None,
    rel_month_length: int = 20,
) -> pd.DataFrame:
    """船別の予測使用量を生成 (区分別 shape 適用後配分)."""
    if len(ships) == 0 or len(unit_consumption) == 0:
        return pd.DataFrame(columns=["s_no", "ship_type", "sku_id", "予測使用量"])
    weights = _build_weights_with_category_shape(
        ships, start_ym, end_ym, rel_month_length,
    )
    if len(weights) == 0:
        return pd.DataFrame(columns=["s_no", "ship_type", "sku_id", "予測使用量"])
    if materials is None:
        sku_id_to_cat = {}
    else:
        sku_id_to_cat = dict(zip(materials["sku_id"], materials["区分"]))
    shape_dict = shape or {}

    joined = weights.merge(
        unit_consumption[["ship_type", "sku_id", "kg_per_ship"]],
        on="ship_type", how="inner",
    )
    joined["shape_factor"] = joined.apply(
        lambda r: _apply_shape_to_row(r, sku_id_to_cat, shape_dict, rel_month_length),
        axis=1,
    )
    joined["qty"] = joined["active_ratio"] * joined["shape_factor"] * joined["kg_per_ship"]
    per_ship = (
        joined.groupby(["s_no", "ship_type", "sku_id"])["qty"]
        .sum().reset_index()
        .rename(columns={"qty": "予測使用量"})
    )
    return per_ship
