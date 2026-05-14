"""SKU区分別 shape factor を ALS で学習する."""
import gc
import logging
import os
from calendar import monthrange
import numpy as np
import pandas as pd
from scipy.optimize import nnls

_SKU_BATCH = 50  # compute_kg_given_shape で GC を挟むバッチサイズ

from src.ship_window import _iter_months, _month_overlap_days
from src.shape_curve import compute_rel_month
from src.material_rules import (
    is_stainless_sku, is_chemical_ship_type, load_stainless_brands,
)

_logger = logging.getLogger(__name__)


def _confidence_label(n: int) -> str:
    if n >= 20:
        return "高"
    if n >= 5:
        return "中"
    return "低"


def _build_kg_design_matrix(ships, sku_id_to_cat, sku, shape, start_ym, end_ym, rel_month_length):
    """Step S 用: shape を固定して、 SKU 1個に対する A行列を構築."""
    months = list(_iter_months(start_ym, end_ym))
    ship_types = sorted(ships["ship_type"].unique())
    type_idx = {t: i for i, t in enumerate(ship_types)}
    month_idx = {m: i for i, m in enumerate(months)}
    cat = sku_id_to_cat.get(sku)
    shape_arr = shape.get(cat) if cat else None
    if shape_arr is None or len(shape_arr) == 0:
        shape_arr = np.full(rel_month_length, 1.0 / rel_month_length)
    curve_len = len(shape_arr)

    A = np.zeros((len(months), len(ship_types)))
    for _, ship in ships.iterrows():
        cs = ship["consume_start"]
        ce = ship["consume_end"]
        st = ship["ship_type"]
        k = type_idx[st]
        for ym in months:
            y, m = int(ym[:4]), int(ym[5:7])
            days = monthrange(y, m)[1]
            overlap = _month_overlap_days(cs, ce, y, m)
            if overlap == 0:
                continue
            active_ratio = overlap / days
            rel_m = compute_rel_month(cs, ce, ym, curve_len)
            if rel_m == 0:
                continue
            A[month_idx[ym], k] += active_ratio * shape_arr[rel_m - 1]
    return A, ship_types, months


def _solve_nnls_l2(A: np.ndarray, y: np.ndarray, l2: float,
                   weights: np.ndarray | None = None):
    """L2 正則化 + 観測重み付き NNLS を Tikhonov 拡張で解く.

    min Σ_i w_i (y_i - (Ax)_i)^2 + l2 * ||x||^2  s.t. x >= 0
    ⇔ NNLS([[√w·A], [sqrt(l2) I]], [[√w·y], [0]])
    """
    if weights is not None:
        w = np.sqrt(weights)
        A = A * w[:, None]
        y = y * w
    if l2 <= 0:
        return nnls(A, y)
    n_cols = A.shape[1]
    A_ext = np.vstack([A, np.sqrt(l2) * np.eye(n_cols)])
    y_ext = np.concatenate([y, np.zeros(n_cols)])
    return nnls(A_ext, y_ext)


def compute_temporal_weights(months: list, scheme: str) -> np.ndarray:
    """月リストに対する時系列重みを計算.

    scheme:
      - "uniform": 全月 1.0 (default)
      - "linear":  oldest 0.5 → newest 1.0
      - "exp_24m": 半減期 24ヶ月の指数減衰 (newest=1.0)
      - "exp_12m": 半減期 12ヶ月の指数減衰 (newest=1.0)
    """
    n = len(months)
    if n == 0:
        return np.ones(0)
    if scheme == "uniform":
        return np.ones(n)
    if scheme == "linear":
        return np.linspace(0.5, 1.0, n)
    if scheme == "exp_24m":
        decay = 0.5 ** (1.0 / 24)
        ages = np.arange(n - 1, -1, -1)  # newest=0, oldest=n-1
        return decay ** ages
    if scheme == "exp_12m":
        decay = 0.5 ** (1.0 / 12)
        ages = np.arange(n - 1, -1, -1)
        return decay ** ages
    raise ValueError(f"unknown weight scheme: {scheme}")


def compute_kg_given_shape(
    ships: pd.DataFrame,
    consumption: pd.DataFrame,
    materials: pd.DataFrame,
    shape: dict[str, np.ndarray],
    start_ym: str,
    end_ym: str,
    rel_month_length: int = 20,
    stainless_brands: set | None = None,
    kg_l2: float = 0.0,
    weight_scheme: str = "uniform",
) -> pd.DataFrame:
    """shape 固定で kg_per_ship を SKU ごとに NNLS 推定 (L2 正則化対応)."""
    if stainless_brands is None:
        stainless_brands = load_stainless_brands()

    sku_id_to_cat = dict(zip(materials["sku_id"], materials["区分"]))
    skus = sorted(consumption["sku_id"].unique())
    months_all = list(_iter_months(start_ym, end_ym))
    ship_types_all = sorted(ships["ship_type"].unique())
    # float32 で構築: ALS 設計行列のピークメモリを約 50% 削減
    cons_pivot = (
        consumption
        .pivot_table(index="year_month", columns="sku_id", values="qty_kg", aggfunc="sum")
        .reindex(months_all, fill_value=0.0)
        .astype(np.float32)
    )
    chem_mask = np.array([is_chemical_ship_type(st) for st in ship_types_all])
    chem_idx = np.where(chem_mask)[0]
    temporal_weights = compute_temporal_weights(months_all, weight_scheme)

    records = []
    for i_sku, sku in enumerate(skus):
        if sku not in cons_pivot.columns:
            continue
        y = cons_pivot[sku].to_numpy(dtype=np.float64)  # NNLS は float64 が必要
        A, _, _ = _build_kg_design_matrix(
            ships, sku_id_to_cat, sku, shape, start_ym, end_ym, rel_month_length,
        )
        n_samples_by_type = [(A[:, i] > 0).sum() for i in range(len(ship_types_all))]
        if y.sum() == 0:
            for i, st in enumerate(ship_types_all):
                records.append({
                    "ship_type": st, "sku_id": sku, "kg_per_ship": 0.0,
                    "n_samples": int(n_samples_by_type[i]),
                    "r2": 0.0,
                    "confidence": _confidence_label(int(n_samples_by_type[i])),
                })
            continue

        is_stainless = is_stainless_sku(sku, stainless_brands)
        try:
            if is_stainless:
                if len(chem_idx) == 0:
                    x_full = np.zeros(len(ship_types_all))
                else:
                    A_chem = A[:, chem_idx]
                    x_chem, _ = _solve_nnls_l2(A_chem, y, kg_l2, weights=temporal_weights)
                    x_full = np.zeros(len(ship_types_all))
                    for k, i in enumerate(chem_idx):
                        x_full[i] = x_chem[k]
            else:
                x_full, _ = _solve_nnls_l2(A, y, kg_l2, weights=temporal_weights)
        except Exception as e:
            _logger.warning(f"kg NNLS failed for SKU {sku}: {e}")
            x_full = np.zeros(len(ship_types_all))

        ss_res = float(np.sum((y - A @ x_full) ** 2))
        ss_tot = float(np.sum((y - y.mean()) ** 2))
        r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
        for i, st in enumerate(ship_types_all):
            records.append({
                "ship_type": st, "sku_id": sku, "kg_per_ship": float(x_full[i]),
                "n_samples": int(n_samples_by_type[i]),
                "r2": r2,
                "confidence": _confidence_label(int(n_samples_by_type[i])),
            })
        # _SKU_BATCH 件ごとにGCを実行してピークメモリを抑制
        if (i_sku + 1) % _SKU_BATCH == 0:
            gc.collect()
    return pd.DataFrame(records)


def compute_shape_given_kg(
    ships: pd.DataFrame,
    consumption: pd.DataFrame,
    materials: pd.DataFrame,
    kg_per_ship: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    rel_month_length: int = 20,
    shape_l2: float = 0.0,
    weight_scheme: str = "uniform",
) -> dict[str, np.ndarray]:
    """kg_per_ship 固定で shape(区分, rel_month) を NNLS 推定 (L2 正則化対応).

    Returns: {"A": np.array(N), "B": np.array(N), ...}   Σ=1.0
    """
    sku_id_to_cat = dict(zip(materials["sku_id"], materials["区分"]))
    kg_lookup = {}
    for _, row in kg_per_ship.iterrows():
        kg_lookup[(row["ship_type"], row["sku_id"])] = float(row["kg_per_ship"])

    months = list(_iter_months(start_ym, end_ym))
    month_idx = {m: i for i, m in enumerate(months)}
    temporal_weights = compute_temporal_weights(months, weight_scheme)

    # float32 で構築してメモリ削減; NNLS 呼び出し時に scipy が float64 へ変換
    cons_pivot = (
        consumption
        .pivot_table(index="year_month", columns="sku_id", values="qty_kg", aggfunc="sum")
        .reindex(months, fill_value=0.0)
        .astype(np.float32)
    )

    categories = sorted(
        c for c in set(sku_id_to_cat.values())
        if c is not None and not (isinstance(c, float) and np.isnan(c))
    )
    shape_out = {}
    for cat in categories:
        cat_skus = [s for s, c in sku_id_to_cat.items() if c == cat and s in cons_pivot.columns]
        if not cat_skus:
            continue
        y_blocks = []
        A_blocks = []
        for sku in cat_skus:
            y_sku = cons_pivot[sku].to_numpy(dtype=np.float32)
            A_block = np.zeros((len(months), rel_month_length), dtype=np.float32)
            for _, ship in ships.iterrows():
                cs = ship["consume_start"]
                ce = ship["consume_end"]
                st = ship["ship_type"]
                kg_value = kg_lookup.get((st, sku), 0.0)
                if kg_value == 0:
                    continue
                for ym in months:
                    yy, mm = int(ym[:4]), int(ym[5:7])
                    days = monthrange(yy, mm)[1]
                    overlap = _month_overlap_days(cs, ce, yy, mm)
                    if overlap == 0:
                        continue
                    active_ratio = overlap / days
                    rel_m = compute_rel_month(cs, ce, ym, rel_month_length)
                    if rel_m == 0:
                        continue
                    A_block[month_idx[ym], rel_m - 1] += active_ratio * kg_value
            y_blocks.append(y_sku)
            A_blocks.append(A_block)
        if not y_blocks:
            continue
        y_concat = np.concatenate(y_blocks).astype(np.float64)
        A_concat = np.vstack(A_blocks).astype(np.float64)
        del A_blocks, y_blocks  # float32 版を即時解放してから NNLS（float64 コピーのみ使用）
        # 観測順に並んだ temporal_weights を SKU 数分繰り返す
        w_concat = np.tile(temporal_weights, len(cat_skus))
        try:
            x, _ = _solve_nnls_l2(A_concat, y_concat, shape_l2, weights=w_concat)
        except Exception as e:
            _logger.warning(f"shape NNLS failed for category {cat}: {e}")
            x = np.full(rel_month_length, 1.0 / rel_month_length)
        del A_concat, y_concat
        s = x.sum()
        if s > 0:
            x = x / s
        else:
            x = np.full(rel_month_length, 1.0 / rel_month_length)
        shape_out[cat] = x
    return shape_out


def estimate_kg_and_shape(
    ships: pd.DataFrame,
    consumption: pd.DataFrame,
    materials: pd.DataFrame,
    start_ym: str,
    end_ym: str,
    rel_month_length: int = 20,
    max_iter: int = 5,
    tol: float = 0.005,
    stainless_brands: set | None = None,
    kg_l2: float = 0.0,
    shape_l2: float = 0.0,
    weight_scheme: str = "uniform",
) -> tuple[pd.DataFrame, dict[str, np.ndarray]]:
    """ALS で kg_per_ship と shape(区分, rel_month) を同時推定 (L2 + 観測重み付き)."""
    if stainless_brands is None:
        stainless_brands = load_stainless_brands()

    sku_id_to_cat = dict(zip(materials["sku_id"], materials["区分"]))
    categories = sorted(
        c for c in set(sku_id_to_cat.values())
        if c is not None and not (isinstance(c, float) and np.isnan(c))
    )
    shape = {c: np.full(rel_month_length, 1.0 / rel_month_length) for c in categories}

    prev_resid = None
    unit = None
    for it in range(max_iter):
        unit = compute_kg_given_shape(
            ships, consumption, materials, shape,
            start_ym, end_ym, rel_month_length, stainless_brands,
            kg_l2=kg_l2, weight_scheme=weight_scheme,
        )
        if not categories:
            break

        new_shape = compute_shape_given_kg(
            ships, consumption, materials, unit,
            start_ym, end_ym, rel_month_length,
            shape_l2=shape_l2, weight_scheme=weight_scheme,
        )
        for c in categories:
            if c in new_shape:
                shape[c] = new_shape[c]

        resid = _compute_residual(ships, consumption, materials, unit, shape,
                                   start_ym, end_ym, rel_month_length)
        if prev_resid is not None and prev_resid > 0:
            change = abs(prev_resid - resid) / prev_resid
            if change < tol:
                _logger.info(f"ALS converged at iter {it+1} (change={change:.4f})")
                break
        prev_resid = resid
        # ALS 1 反復終了: 前回の unit/shape 中間オブジェクトを解放
        gc.collect()

    return unit, shape


def _compute_residual(ships, consumption, materials, unit, shape,
                      start_ym, end_ym, rel_month_length):
    """ALS 反復の収束判定用に残差二乗和を計算."""
    from src.forecast import generate_monthly_forecast
    pred = generate_monthly_forecast(
        ships, unit, start_ym, end_ym,
        materials=materials, shape=shape, rel_month_length=rel_month_length,
    )
    merged = pred.rename(columns={"予測使用量": "予測"}).merge(
        consumption.rename(columns={"qty_kg": "実績"}),
        on=["year_month", "sku_id"], how="outer",
    ).fillna(0.0)
    return float(((merged["予測"] - merged["実績"]) ** 2).sum())


def save_learned_shape(shape: dict[str, np.ndarray], path: str):
    """学習結果の shape を CSV に保存."""
    rows = []
    for cat, arr in shape.items():
        for m, v in enumerate(arr, start=1):
            rows.append({"category": cat, "rel_month": m, "factor": float(v)})
    if not rows:
        pd.DataFrame(columns=["category", "rel_month", "factor"]).to_csv(path, index=False)
        return
    pd.DataFrame(rows).to_csv(path, index=False)


def load_learned_shape(path: str) -> dict[str, np.ndarray]:
    """学習済み shape を CSV から読み込む."""
    if not os.path.exists(path):
        return {}
    df = pd.read_csv(path)
    if len(df) == 0:
        return {}
    out = {}
    for cat, grp in df.groupby("category"):
        arr = grp.sort_values("rel_month")["factor"].to_numpy(dtype=float)
        s = arr.sum()
        if s > 0:
            arr = arr / s
        out[str(cat)] = arr
    return out
