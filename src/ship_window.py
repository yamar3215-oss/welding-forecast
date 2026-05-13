"""船の消費期間と月別アクティブ比率を計算."""
from datetime import date
from calendar import monthrange
import numpy as np
import pandas as pd
from src.shape_curve import get_curve_for_ship_type, compute_rel_month


def _iter_months(start_ym: str, end_ym: str):
    """'YYYY-MM' 範囲の月を順に返す."""
    sy, sm = int(start_ym[:4]), int(start_ym[5:7])
    ey, em = int(end_ym[:4]), int(end_ym[5:7])
    cy, cm = sy, sm
    while (cy, cm) <= (ey, em):
        yield f"{cy:04d}-{cm:02d}"
        cm += 1
        if cm > 12:
            cm = 1
            cy += 1


def _month_overlap_days(consume_start: date, consume_end: date, year: int, month: int) -> int:
    """月 [year, month] と消費期間 [consume_start, consume_end] の重なり日数."""
    last_day = monthrange(year, month)[1]
    month_start = date(year, month, 1)
    month_end = date(year, month, last_day)
    if consume_end < month_start or consume_start > month_end:
        return 0
    overlap_start = max(month_start, consume_start)
    overlap_end = min(month_end, consume_end)
    return (overlap_end - overlap_start).days + 1


def compute_monthly_active_ratio(ships: pd.DataFrame, start_ym: str, end_ym: str) -> pd.DataFrame:
    """各 (s_no, year_month) ごとのアクティブ比率を返す.

    Returns columns: s_no, ship_type, year_month, active_ratio
    """
    records = []
    months = list(_iter_months(start_ym, end_ym))
    for _, ship in ships.iterrows():
        cs = ship["consume_start"]
        ce = ship["consume_end"]
        for ym in months:
            y, m = int(ym[:4]), int(ym[5:7])
            days_in_month = monthrange(y, m)[1]
            overlap = _month_overlap_days(cs, ce, y, m)
            ratio = overlap / days_in_month if days_in_month > 0 else 0.0
            records.append({
                "s_no": ship["s_no"],
                "ship_type": ship["ship_type"],
                "year_month": ym,
                "active_ratio": ratio,
            })
    return pd.DataFrame(records)


def build_design_matrix(ships: pd.DataFrame, start_ym: str, end_ym: str):
    """NNLS用の設計行列 A を構築.

    Returns: (A, ship_types_list, months_list)
      A.shape = (n_months, n_ship_types)
      A[t, k] = 月 t における船種 k の総アクティブ比率 (同船種の船を合算)
    """
    ratios = compute_monthly_active_ratio(ships, start_ym, end_ym)
    grouped = ratios.groupby(["year_month", "ship_type"])["active_ratio"].sum().reset_index()
    months = sorted(grouped["year_month"].unique())
    ship_types = sorted(grouped["ship_type"].unique())
    A = np.zeros((len(months), len(ship_types)))
    month_idx = {m: i for i, m in enumerate(months)}
    type_idx = {t: i for i, t in enumerate(ship_types)}
    for _, row in grouped.iterrows():
        A[month_idx[row["year_month"]], type_idx[row["ship_type"]]] = row["active_ratio"]
    return A, ship_types, months


def build_design_matrix_with_shape(
    ships: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    curve_map: dict,
    curves: dict,
):
    """shape_factor を組み込んだ NNLS設計行列を返す.

    Returns: (A_prime, ship_types_list, months_list)
      A_prime[t, k] = Σ_{ship ∈ type_k} active_ratio(ship, t)
                      × shape_factor(curve_of_k, rel_month(ship, t))
    """
    months = list(_iter_months(start_ym, end_ym))
    ship_types = sorted(ships["ship_type"].unique())
    A = np.zeros((len(months), len(ship_types)))
    type_idx = {t: i for i, t in enumerate(ship_types)}
    month_idx = {m: i for i, m in enumerate(months)}

    for _, ship in ships.iterrows():
        cs = ship["consume_start"]
        ce = ship["consume_end"]
        st = ship["ship_type"]
        curve = get_curve_for_ship_type(st, curve_map, curves)
        curve_len = len(curve)
        k = type_idx[st]
        for ym in months:
            y, m = int(ym[:4]), int(ym[5:7])
            days_in_month = monthrange(y, m)[1]
            overlap = _month_overlap_days(cs, ce, y, m)
            if overlap == 0:
                continue
            active_ratio = overlap / days_in_month
            rel_m = compute_rel_month(cs, ce, ym, curve_len)
            if rel_m == 0:
                continue
            shape = curve[rel_m - 1]
            A[month_idx[ym], k] += active_ratio * shape
    return A, ship_types, months
