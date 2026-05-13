"""データ品質検証. 警告メッセージのリストを返す."""
import pandas as pd


def validate_ships(ships: pd.DataFrame) -> list:
    """船の日付整合性チェック."""
    warnings = []
    for _, row in ships.iterrows():
        keel = row["keel_date"]
        launch = row.get("launch_date")
        delivery = row.get("delivery_date")
        if keel is None:
            warnings.append(f"船 {row['s_no']}: 搭載開始日 None")
            continue
        if launch and launch < keel:
            warnings.append(
                f"船 {row['s_no']}: 進水({launch}) < 搭載開始({keel})"
            )
        if delivery and launch and delivery < launch:
            warnings.append(
                f"船 {row['s_no']}: 引渡({delivery}) < 進水({launch})"
            )
    return warnings


def validate_consumption(consumption: pd.DataFrame) -> list:
    """月別消費量の異常値チェック."""
    warnings = []
    if len(consumption) == 0:
        return warnings
    neg = consumption[consumption["qty_kg"] < 0]
    for _, row in neg.iterrows():
        warnings.append(
            f"消費量 負値: {row['year_month']} {row['sku_id']} = {row['qty_kg']}"
        )
    for sku, g in consumption.groupby("sku_id"):
        non_zero = g[g["qty_kg"] > 0]["qty_kg"]
        if len(non_zero) < 5:
            continue
        median = non_zero.median()
        outliers = g[g["qty_kg"] > median * 10]
        for _, row in outliers.iterrows():
            warnings.append(
                f"消費量 異常極大: {row['year_month']} {row['sku_id']} = "
                f"{row['qty_kg']} (中央値 {median:.0f} の{row['qty_kg']/median:.0f}倍)"
            )
    return warnings


def validate_inventory(inventory: pd.DataFrame) -> list:
    """在庫の連続不整合チェック: 前月末在庫 + 入庫 - 出庫 ≠ 当月末在庫."""
    warnings = []
    if len(inventory) == 0:
        return warnings
    inv = inventory.sort_values(["sku_id", "拠点", "year_month"]).copy()
    inv["prev_stock"] = inv.groupby(["sku_id", "拠点"])["在庫"].shift(1)
    inv["expected"] = inv["prev_stock"] + inv["入庫"] - inv["出庫"]
    bad = inv[
        (inv["prev_stock"].notna()) &
        ((inv["expected"] - inv["在庫"]).abs() > 1.0)
    ]
    for _, row in bad.iterrows():
        warnings.append(
            f"在庫 不整合: {row['year_month']} {row['sku_id']} ({row['拠点']}) "
            f"期待 {row['expected']:.0f}, 実 {row['在庫']:.0f}"
        )
    return warnings
