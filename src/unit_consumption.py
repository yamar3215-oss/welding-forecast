"""船種別 × SKU別 kg_per_ship を ALS で推定 (委譲版)."""
import logging
import os
import numpy as np
import pandas as pd
from src.material_rules import (
    is_stainless_sku,
    is_chemical_ship_type,
    load_stainless_brands,
)

_logger = logging.getLogger(__name__)


def estimate_unit_consumption(
    ships: pd.DataFrame,
    monthly_consumption: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    stainless_brands: set | None = None,
    materials: pd.DataFrame | None = None,
    rel_month_length: int = 20,
) -> pd.DataFrame:
    """ALS で kg_per_ship を推定. shape は内部で学習するが本関数は kg のみ返す.

    shape も合わせて取得したい場合は src.category_shape.estimate_kg_and_shape を直接呼ぶ.
    """
    from src.category_shape import estimate_kg_and_shape
    if materials is None:
        materials = pd.DataFrame(columns=["sku_id", "区分"])
    unit, _shape = estimate_kg_and_shape(
        ships, monthly_consumption, materials,
        start_ym, end_ym,
        rel_month_length=rel_month_length,
        stainless_brands=stainless_brands,
    )
    return unit


def apply_overrides(unit_df: pd.DataFrame, override_path: str) -> pd.DataFrame:
    """unit_consumption_override.csv で kg_per_ship を上書き.

    override CSV の列は kg_per_month のままでも受け入れる (後方互換).
    """
    if not os.path.exists(override_path):
        return unit_df
    overrides = pd.read_csv(override_path)
    if len(overrides) == 0:
        return unit_df
    df = unit_df.copy()
    val_col = "kg_per_ship" if "kg_per_ship" in overrides.columns else "kg_per_month"
    for _, row in overrides.iterrows():
        mask = (df["ship_type"] == row["ship_type"]) & (df["sku_id"] == row["sku_id"])
        df.loc[mask, "kg_per_ship"] = float(row[val_col])
    return df


def apply_category_fallback(
    unit_df: pd.DataFrame,
    ship_types_master: pd.DataFrame,
    stainless_brands: set | None = None,
) -> pd.DataFrame:
    """過去実績ゼロ船種に対して category 内平均で埋める (kg_per_ship).

    stainless_brands に含まれる銘柄 × 非ケミカル船種 の組合せは fallback しない.
    """
    if stainless_brands is None:
        stainless_brands = load_stainless_brands()

    df = unit_df.copy()
    df = df.merge(ship_types_master, on="ship_type", how="left")
    df["fallback_flag"] = False
    category_means = (
        df[df["n_samples"] > 0]
        .groupby(["category", "sku_id"])["kg_per_ship"]
        .mean()
        .reset_index()
        .rename(columns={"kg_per_ship": "cat_mean"})
    )
    df = df.merge(category_means, on=["category", "sku_id"], how="left")
    df["_is_stainless"] = df["sku_id"].apply(lambda s: is_stainless_sku(s, stainless_brands))
    df["_is_chem"] = df["ship_type"].apply(is_chemical_ship_type)
    skip_mask = df["_is_stainless"] & ~df["_is_chem"]
    mask = (
        (df["n_samples"] == 0)
        & (df["kg_per_ship"] == 0)
        & (df["cat_mean"].notna())
        & ~skip_mask
    )
    df.loc[mask, "kg_per_ship"] = df.loc[mask, "cat_mean"]
    df.loc[mask, "fallback_flag"] = True
    df = df.drop(columns=["cat_mean", "_is_stainless", "_is_chem"])
    return df


def compute_holdout_mape(
    ships: pd.DataFrame,
    consumption: pd.DataFrame,
    holdout_months: int = 3,
    stainless_brands: set | None = None,
    materials: pd.DataFrame | None = None,
    rel_month_length: int = 20,
    kg_l2: float = 0.0,
    shape_l2: float = 0.0,
    weight_scheme: str = "uniform",
) -> dict:
    """直近 N ヶ月をホールドアウトして ALS モデルで MAPE を算出."""
    if len(consumption) == 0:
        return {"mape": float("nan"), "per_sku": pd.DataFrame()}
    months_sorted = sorted(consumption["year_month"].unique())
    if len(months_sorted) < holdout_months + 6:
        return {"mape": float("nan"), "per_sku": pd.DataFrame()}
    holdout_ms = set(months_sorted[-holdout_months:])
    train_start = months_sorted[0]
    train_end = months_sorted[-holdout_months - 1]
    train_cons = consumption[~consumption["year_month"].isin(holdout_ms)]
    holdout_cons = consumption[consumption["year_month"].isin(holdout_ms)]

    from src.category_shape import estimate_kg_and_shape
    if materials is None:
        materials = pd.DataFrame(columns=["sku_id", "区分"])
    unit, shape = estimate_kg_and_shape(
        ships, train_cons, materials,
        train_start, train_end,
        rel_month_length=rel_month_length,
        stainless_brands=stainless_brands,
        kg_l2=kg_l2, shape_l2=shape_l2,
        weight_scheme=weight_scheme,
    )

    from src.forecast import generate_monthly_forecast
    fc_start = sorted(holdout_ms)[0]
    fc_end = sorted(holdout_ms)[-1]
    pred = generate_monthly_forecast(
        ships, unit, fc_start, fc_end,
        materials=materials, shape=shape, rel_month_length=rel_month_length,
    )
    pred = pred.rename(columns={"予測使用量": "予測"})
    actual = holdout_cons.rename(columns={"qty_kg": "実績"})

    pred_skus = set(pred["sku_id"].unique()) if len(pred) > 0 else set()

    merged = pred.merge(actual, on=["year_month", "sku_id"], how="inner")
    merged_nonzero = merged[merged["実績"] > 0]

    skus_with_nonzero = set(merged_nonzero["sku_id"].unique())
    zero_actual_skus = pred_skus - skus_with_nonzero
    if zero_actual_skus:
        _logger.info(
            "ホールドアウト実績ゼロSKU (%d件): %s",
            len(zero_actual_skus),
            ", ".join(sorted(zero_actual_skus)[:20]),
        )

    if len(merged_nonzero) == 0:
        rows = [{"sku_id": s, "abs_pct_err": float("nan"),
                 "mape_%": float("nan"), "reason": "zero_actual"}
                for s in sorted(pred_skus)]
        return {"mape": float("nan"),
                "per_sku": pd.DataFrame(rows) if rows else pd.DataFrame()}

    merged_nonzero = merged_nonzero.copy()
    merged_nonzero["abs_pct_err"] = (
        (merged_nonzero["予測"] - merged_nonzero["実績"]).abs()
        / merged_nonzero["実績"]
    )
    per_sku = merged_nonzero.groupby("sku_id")["abs_pct_err"].mean().reset_index()
    per_sku["mape_%"] = per_sku["abs_pct_err"] * 100
    per_sku["reason"] = "ok"

    if zero_actual_skus:
        zero_rows = pd.DataFrame([
            {"sku_id": s, "abs_pct_err": float("nan"),
             "mape_%": float("nan"), "reason": "zero_actual"}
            for s in sorted(zero_actual_skus)
        ])
        per_sku = pd.concat([per_sku, zero_rows], ignore_index=True)

    # 月別MAPE (全SKU平均)
    per_month = (
        merged_nonzero.groupby("year_month")["abs_pct_err"].mean().reset_index()
    )
    per_month["mape_%"] = per_month["abs_pct_err"] * 100

    # SKU×月別MAPE
    per_sku_month = (
        merged_nonzero.groupby(["sku_id", "year_month"])["abs_pct_err"]
        .mean().reset_index()
    )
    per_sku_month["mape_%"] = per_sku_month["abs_pct_err"] * 100

    overall = float(merged_nonzero["abs_pct_err"].mean() * 100)
    return {"mape": overall, "per_sku": per_sku,
            "per_month": per_month, "per_sku_month": per_sku_month}


def compute_cv_mape(
    ships: pd.DataFrame,
    consumption: pd.DataFrame,
    n_splits: int = 3,
    holdout_months: int = 9,
    stainless_brands: set | None = None,
    materials: pd.DataFrame | None = None,
    rel_month_length: int = 20,
    kg_l2: float = 0.0,
    shape_l2: float = 0.0,
    weight_scheme: str = "uniform",
) -> dict:
    """時系列 forward-chaining cross-validation で MAPE 平均を計算.

    例: n_splits=3, holdout_months=9 のとき、
      split 1: train = months[0..-19], test = months[-27..-19]
      split 2: train = months[0..-10], test = months[-18..-10]
      split 3: train = months[0..-1],  test = months[-9..-1]
    各 split で compute_holdout_mape 相当の手順を実行し、 MAPE 平均を返す.
    """
    if len(consumption) == 0:
        return {"mean_mape": float("nan"), "per_split": []}
    months_sorted = sorted(consumption["year_month"].unique())
    min_train_months = 6
    needed = holdout_months * n_splits + min_train_months
    if len(months_sorted) < needed:
        return {"mean_mape": float("nan"), "per_split": []}

    per_split = []
    for split_i in range(n_splits):
        # split index 0 が最古、 n_splits-1 が最新
        offset_from_end = (n_splits - 1 - split_i) * holdout_months
        if offset_from_end == 0:
            test_months_set = set(months_sorted[-holdout_months:])
            train_end = months_sorted[-holdout_months - 1]
        else:
            test_months_set = set(
                months_sorted[-holdout_months - offset_from_end:-offset_from_end]
            )
            train_end = months_sorted[-holdout_months - offset_from_end - 1]
        train_cons = consumption[~consumption["year_month"].isin(test_months_set)]
        # 学習期間は train_end まで（ train_cons はテスト後も含むが先頭から train_end まで使う）
        train_cons = train_cons[train_cons["year_month"] <= train_end]
        if len(train_cons) == 0:
            continue
        train_start = train_cons["year_month"].min()

        from src.category_shape import estimate_kg_and_shape
        if materials is None:
            materials_ = pd.DataFrame(columns=["sku_id", "区分"])
        else:
            materials_ = materials
        unit, shape = estimate_kg_and_shape(
            ships, train_cons, materials_,
            train_start, train_end,
            rel_month_length=rel_month_length,
            stainless_brands=stainless_brands,
            kg_l2=kg_l2, shape_l2=shape_l2,
            weight_scheme=weight_scheme,
        )

        from src.forecast import generate_monthly_forecast
        fc_start = sorted(test_months_set)[0]
        fc_end = sorted(test_months_set)[-1]
        pred = generate_monthly_forecast(
            ships, unit, fc_start, fc_end,
            materials=materials_, shape=shape, rel_month_length=rel_month_length,
        )
        pred = pred.rename(columns={"予測使用量": "予測"})
        actual = consumption[consumption["year_month"].isin(test_months_set)] \
            .rename(columns={"qty_kg": "実績"})
        merged = pred.merge(actual, on=["year_month", "sku_id"], how="inner")
        merged = merged[merged["実績"] > 0]
        if len(merged) == 0:
            per_split.append({"split": split_i, "mape": float("nan"),
                              "test_window": (fc_start, fc_end)})
            continue
        merged["abs_pct_err"] = (merged["予測"] - merged["実績"]).abs() / merged["実績"]
        split_mape = float(merged["abs_pct_err"].mean() * 100)
        per_split.append({"split": split_i, "mape": split_mape,
                          "test_window": (fc_start, fc_end)})

    valid_mapes = [s["mape"] for s in per_split if not pd.isna(s["mape"])]
    mean_mape = float(np.mean(valid_mapes)) if valid_mapes else float("nan")
    return {"mean_mape": mean_mape, "per_split": per_split}
