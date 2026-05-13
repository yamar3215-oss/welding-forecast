"""材料・船種の分類ルール。

ステンレス銘柄リストは config/stainless_brands.csv で外部管理。
ケミカル船種判定は ship_type 文字列内の 'ケミカル' 部分一致で行う。
"""
import logging
import os
import pandas as pd


_logger = logging.getLogger(__name__)


def load_stainless_brands(path: str = "config/stainless_brands.csv") -> set[str]:
    """ステンレス銘柄集合を返す。

    ファイルが存在しない、または brand 列が空の場合は空集合 + warn ログ。
    """
    if not os.path.exists(path):
        _logger.warning(f"stainless brands file not found: {path} (constraint disabled)")
        return set()
    try:
        df = pd.read_csv(path)
    except Exception as e:
        _logger.warning(f"failed to read {path}: {e} (constraint disabled)")
        return set()
    if "brand" not in df.columns or len(df) == 0:
        _logger.warning(f"{path} has no brand entries (constraint disabled)")
        return set()
    brands = {str(b).strip() for b in df["brand"].dropna() if str(b).strip()}
    return brands


def is_stainless_sku(sku_id: str, stainless_brands: set[str]) -> bool:
    """sku_id の銘柄部分（'_' 前）が stainless_brands に含まれるか判定。"""
    if not stainless_brands or not sku_id:
        return False
    brand = sku_id.split("_", 1)[0]
    return brand in stainless_brands


def is_chemical_ship_type(ship_type: str) -> bool:
    """ship_type 文字列に 'ケミカル' を部分文字列として含むか。"""
    if not ship_type:
        return False
    return "ケミカル" in ship_type


def filter_chemical_ship_types(ship_types: list) -> list:
    """ship_types リストからケミカル船種のみ抽出（順序保持）。"""
    return [st for st in ship_types if is_chemical_ship_type(st)]


def get_lead_time_months(sku_id: str, stainless_brands: set) -> int:
    """SKUの銘柄カテゴリから発注リードタイム（月数）を返す。

    ステンレス銘柄 → 3ヶ月
    その他 → 2ヶ月
    """
    if is_stainless_sku(sku_id, stainless_brands):
        return 3
    return 2
