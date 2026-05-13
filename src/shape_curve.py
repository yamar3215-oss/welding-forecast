"""Sカーブ由来の月別係数 (shape_factor) のロード・マッピング・rel_month 算出."""
import math
import os
from calendar import monthrange
from datetime import date

import numpy as np
import pandas as pd


def load_shape_curves(path: str) -> dict[str, np.ndarray]:
    """config/shape_curve.csv を読み込み、curve_name → factor 配列を返す.

    Σ factor = 1.0 になるよう正規化（既に正規化済みでも安全）.
    ファイルが存在しなければ {} を返す.
    """
    if not os.path.exists(path):
        return {}
    df = pd.read_csv(path)
    if len(df) == 0:
        return {}
    df = df.sort_values(["curve_name", "rel_month"])
    out = {}
    for name, grp in df.groupby("curve_name", sort=False):
        arr = grp["factor"].to_numpy(dtype=float)
        s = arr.sum()
        if s > 0:
            arr = arr / s
        out[str(name)] = arr
    return out


def load_ship_type_curve_map(path: str) -> dict[str, str]:
    """config/ship_type_curve_map.csv を読み込み、ship_type → curve_name を返す."""
    if not os.path.exists(path):
        return {}
    df = pd.read_csv(path)
    if len(df) == 0:
        return {}
    return dict(zip(df["ship_type"].astype(str), df["curve_name"].astype(str)))


def get_curve_for_ship_type(
    ship_type: str,
    mapping: dict[str, str],
    curves: dict[str, np.ndarray],
) -> np.ndarray:
    """船種に対応する curve 配列を返す.

    マッピングに無ければ 'average' へフォールバック.
    'average' も無ければ均一分布 (12月で 1/12 ずつ) を返す.
    """
    curve_name = mapping.get(ship_type)
    if curve_name and curve_name in curves:
        return curves[curve_name]
    if "average" in curves:
        return curves["average"]
    return np.full(12, 1.0 / 12)


def compute_rel_month(
    consume_start: date,
    consume_end: date,
    year_month: str,
    curve_length: int,
) -> int:
    """月 year_month の中央日における正規化後の rel_month (1..curve_length).

    消費期間外 (進捗 < 0 または > 1) なら 0 を返す.
    """
    y, m = int(year_month[:4]), int(year_month[5:7])
    last_day = monthrange(y, m)[1]
    mid_day = (last_day + 1) // 2
    mid_date = date(y, m, mid_day)

    span = (consume_end - consume_start).days
    if span <= 0:
        return 0
    offset = (mid_date - consume_start).days
    progress = offset / span
    if progress < 0 or progress > 1:
        return 0
    raw = math.ceil(progress * curve_length)
    if raw < 1:
        raw = 1
    if raw > curve_length:
        raw = curve_length
    return raw
