"""推奨発注量の算出 (在庫評価=3 を目標)."""
import pandas as pd
from src.stock_eval import _prior_three_months, classify_stock_score
from src.material_rules import get_lead_time_months, load_stainless_brands


def recommend_orders(
    forecast_monthly: pd.DataFrame,
    current_stock: pd.DataFrame,
    consumption_history: pd.DataFrame = None,
    stainless_brands: set | None = None,
    safety_factor: float = 2.0,
    planned_orders: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """月別推奨発注量を算出 (在庫評価=3 を目標).

    リードタイムは銘柄カテゴリで決定:
      - ステンレス銘柄 → 3ヶ月
      - その他 → 2ヶ月

    アルゴリズム:
      M(t) = 月t の直前3ヶ月の使用量平均 (履歴+予測連結)
      目標在庫 = M(t) × safety_factor (=2.0) → 在庫評価=3
      推奨発注量(予測) = max(0, 目標在庫 - 月末予測在庫(発注前))
        ※ 確定の有無にかかわらず常に算出 (予実対比のため)
      入庫採用 = 発注済量(確定) if 確定あり else 推奨発注量(予測)
      月末予測在庫 = 月初在庫 - 予測使用量 + 入庫採用

    planned_orders (任意): _1.xlsx の「入庫予定のみ入力されている (出庫・在庫ブランク)」
      手配済み入庫。 columns: year_month, sku_id, planned_kg
      該当 (sku, ym) では 発注済量 列に planned_kg を格納し、
      在庫遷移には確定値を採用。推奨発注量(予測)は別途常時算出。
    """
    if consumption_history is None:
        consumption_history = pd.DataFrame(columns=["year_month", "sku_id", "qty_kg"])
    if stainless_brands is None:
        stainless_brands = load_stainless_brands()

    planned_map: dict[tuple[str, str], float] = {}
    if planned_orders is not None and len(planned_orders) > 0:
        for _, r in planned_orders.iterrows():
            planned_map[(r["sku_id"], r["year_month"])] = float(r["planned_kg"])

    hist = consumption_history.rename(columns={"qty_kg": "qty"})[["year_month", "sku_id", "qty"]]
    fc = forecast_monthly.rename(columns={"予測使用量": "qty"})[["year_month", "sku_id", "qty"]]
    combined = pd.concat([hist, fc], ignore_index=True)
    combined_idx = combined.set_index(["sku_id", "year_month"])["qty"].to_dict()

    fc_sorted = forecast_monthly.sort_values(["sku_id", "year_month"])
    stock_map = dict(zip(current_stock["sku_id"], current_stock["在庫"]))

    records = []
    for sku, g in fc_sorted.groupby("sku_id"):
        running_stock = stock_map.get(sku, 0.0) or 0.0
        lead = get_lead_time_months(sku, stainless_brands)
        for _, row in g.iterrows():
            ym = row["year_month"]
            usage = row["予測使用量"]
            prior = _prior_three_months(ym)
            prior_vals = [combined_idx.get((sku, p), 0.0) for p in prior]
            m_avg = sum(prior_vals) / 3.0
            target = m_avg * safety_factor

            end_stock_before_order = running_stock - usage
            predicted_order = max(0.0, target - end_stock_before_order)
            planned_key = (sku, ym)
            if planned_key in planned_map:
                confirmed = planned_map[planned_key]
                actual_in = confirmed
                is_planned = True
            else:
                confirmed = float("nan")
                actual_in = predicted_order
                is_planned = False
            running_stock = end_stock_before_order + actual_in
            score = classify_stock_score(running_stock, m_avg)
            order_by = _subtract_months(ym, lead)
            records.append({
                "year_month": ym,
                "sku_id": sku,
                "予測使用量": usage,
                "過去3ヶ月平均": m_avg,
                "目標在庫": target,
                "月末予測在庫": running_stock,
                "予測在庫評価": score,
                "発注済量": confirmed,
                "推奨発注量": predicted_order,
                "発注期限": order_by if (predicted_order > 0 and not is_planned) else "",
                "リードタイム月数": lead,
                "手配済み": is_planned,
            })
    return pd.DataFrame(records)


def _subtract_months(ym: str, n: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    total = y * 12 + (m - 1) - n
    new_y = total // 12
    new_m = total % 12 + 1
    return f"{new_y:04d}-{new_m:02d}"
