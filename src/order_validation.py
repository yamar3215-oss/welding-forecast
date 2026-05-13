"""推奨発注 vs 実際の発注計画（入荷予定）の検証.

`order_recommend.recommend_orders` の出力（推奨発注量）と、
`io_reader.read_planned_orders` の出力（_2.xlsx の入荷予定量）を
SKU × 月で突き合わせ、誤差・MAPE・カバー率を返す。
"""
import numpy as np
import pandas as pd


def validate_orders(orders: pd.DataFrame, planned: pd.DataFrame) -> dict:
    """推奨発注と入荷予定を SKU×月 で比較し、誤差指標を返す.

    Args:
      orders: recommend_orders の戻り値 (columns に 'sku_id','year_month','推奨発注量' を含む)
      planned: read_planned_orders の戻り値 (columns: sku_id, year_month, planned_kg)

    Returns: dict
      comparison: DataFrame
        columns: sku_id, year_month, recommended_kg, planned_kg, diff_kg, abs_pct_error
      mape_overall: float        # planned > 0 の行に対する単純平均 (%)
      mape_per_sku: DataFrame    # sku_id, mape, n_months
      mape_per_month: DataFrame  # year_month, mape, n_skus
      coverage: dict             # planned_skus, captured, false_positive_skus, missed_skus
      within_20pct_rate: float   # planned>0 の行のうち |誤差|<=20% の比率
      totals: dict               # recommended_total_kg, planned_total_kg, ratio
    """
    rec = orders[["sku_id", "year_month", "推奨発注量"]].copy()
    rec = rec.rename(columns={"推奨発注量": "recommended_kg"})
    rec = rec.groupby(["sku_id", "year_month"], as_index=False)["recommended_kg"].sum()

    pl = planned[["sku_id", "year_month", "planned_kg"]].copy()

    # 検証は planned の月範囲に絞る (forecast は12ヶ月分あるので)
    months = sorted(pl["year_month"].unique())
    rec_in_window = rec[rec["year_month"].isin(months)]

    merged = pd.merge(rec_in_window, pl, on=["sku_id", "year_month"], how="outer")
    merged["recommended_kg"] = merged["recommended_kg"].fillna(0.0)
    merged["planned_kg"] = merged["planned_kg"].fillna(0.0)
    merged["diff_kg"] = merged["recommended_kg"] - merged["planned_kg"]

    def _abs_pct_error(row):
        p, r = row["planned_kg"], row["recommended_kg"]
        if p > 0:
            return abs(r - p) / p * 100.0
        # planned == 0: 誤差%は未定義 → NaN
        return np.nan

    merged["abs_pct_error"] = merged.apply(_abs_pct_error, axis=1)
    merged = merged.sort_values(["sku_id", "year_month"]).reset_index(drop=True)

    # planned > 0 のみで MAPE
    mask = merged["planned_kg"] > 0
    sub = merged[mask]
    mape_overall = float(sub["abs_pct_error"].mean()) if len(sub) else float("nan")

    mape_per_sku = (
        sub.groupby("sku_id")["abs_pct_error"]
        .agg(["mean", "count"])
        .reset_index()
        .rename(columns={"mean": "mape", "count": "n_months"})
        .sort_values("mape")
        .reset_index(drop=True)
    )

    mape_per_month = (
        sub.groupby("year_month")["abs_pct_error"]
        .agg(["mean", "count"])
        .reset_index()
        .rename(columns={"mean": "mape", "count": "n_skus"})
        .sort_values("year_month")
        .reset_index(drop=True)
    )

    planned_skus = set(pl["sku_id"].unique())
    rec_skus = set(rec_in_window[rec_in_window["recommended_kg"] > 0]["sku_id"].unique())
    captured = planned_skus & rec_skus
    false_positive = rec_skus - planned_skus
    missed = planned_skus - rec_skus
    coverage = {
        "planned_skus": len(planned_skus),
        "captured": len(captured),
        "captured_rate": len(captured) / len(planned_skus) if planned_skus else float("nan"),
        "false_positive_skus": len(false_positive),
        "missed_skus": len(missed),
    }

    within_20 = float((sub["abs_pct_error"] <= 20.0).mean()) if len(sub) else float("nan")

    totals = {
        "recommended_total_kg": float(rec_in_window["recommended_kg"].sum()),
        "planned_total_kg": float(pl["planned_kg"].sum()),
    }
    totals["ratio"] = (
        totals["recommended_total_kg"] / totals["planned_total_kg"]
        if totals["planned_total_kg"] > 0 else float("nan")
    )

    return {
        "comparison": merged,
        "mape_overall": mape_overall,
        "mape_per_sku": mape_per_sku,
        "mape_per_month": mape_per_month,
        "coverage": coverage,
        "within_20pct_rate": within_20,
        "totals": totals,
    }
