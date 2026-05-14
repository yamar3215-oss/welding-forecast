"""CLIエントリ: 入力Excelから予測レポートを生成する."""
import argparse
from datetime import datetime
import gc
import json
import os
from pathlib import Path
import numpy as np
import pandas as pd

from src.io_reader import (
    read_senpyou,
    read_ship_types,
    read_materials_and_consumption,
    read_inventory,
    read_planned_orders,
    detect_train_end_ym,
    extract_planned_orders_from_inventory,
    extract_usage_consumption,
    _USAGE_LOCATIONS,
)
from src.unit_consumption import (
    apply_overrides,
    apply_category_fallback,
    compute_holdout_mape,
)
from src.category_shape import estimate_kg_and_shape, save_learned_shape
from src.forecast import generate_monthly_forecast, apply_ratio_constraint
from src.stock_eval import compute_stock_evaluation, compare_with_existing_evaluation
from src.order_recommend import recommend_orders
from src.order_validation import validate_orders
from src.validator import validate_ships, validate_consumption, validate_inventory
from src.inventory_format_writer import write_inventory_format
from src.material_rules import load_stainless_brands


def main():
    parser = argparse.ArgumentParser(description="船舶溶接材料 予測システム")
    parser.add_argument("--data", required=True, help="data.xlsx パス")
    parser.add_argument("--inventory", required=True,
                        help="訓練・forecast起点用の在庫管理表 (_1.xlsx)")
    parser.add_argument("--inventory-validate", default=None,
                        help="検証用の発注計画書 (_2.xlsx)。指定すれば推奨発注 vs 入荷予定の検証を実行")
    parser.add_argument("--output-dir", default="output", help="出力ディレクトリ")
    parser.add_argument("--config-dir", default="config", help="設定ディレクトリ")
    parser.add_argument("--forecast-months", type=int, default=12, help="予測期間 (月)")
    parser.add_argument("--train-end", default=None,
                        help="学習期間の終端 year_month (YYYY-MM)。 未指定で在庫・消費の登録済最新月を自動採用")
    parser.add_argument("--rel-month-length", type=int, default=16,
                        help="ALS の shape factor 配列長 (デフォルト 16 = sweep ベスト)")
    parser.add_argument("--kg-l2", type=float, default=0.01,
                        help="kg_per_ship 推定 NNLS の L2 正則化係数 (デフォルト 0.01 = sweep ベスト)")
    parser.add_argument("--shape-l2", type=float, default=0.0,
                        help="shape 推定 NNLS の L2 正則化係数 (デフォルト 0.0、 正規化で打ち消される)")
    parser.add_argument("--weight-scheme", default="exp_24m",
                        choices=["uniform", "linear", "exp_24m", "exp_12m"],
                        help="観測時系列重み (デフォルト exp_24m = 半減期24ヶ月の指数減衰)")
    parser.add_argument("--ratio-target", type=float, default=None,
                        help="forecast の SKU別総量を過去消費に揃える ratio (1.0=同等、 未指定で無効)")
    parser.add_argument("--ratio-mode", default="match",
                        choices=["match", "floor", "ceiling"],
                        help="match=両側強制、 floor=過小のみ補正、 ceiling=過剰のみ抑制")
    parser.add_argument("--ratio-lookback", type=int, default=12,
                        help="ratio 制約の過去参照月数 (デフォルト 12)")
    parser.add_argument("--ratio-tol", type=float, default=0.10,
                        help="ratio 制約の許容バンド (±tol、 デフォルト 0.10)")
    args = parser.parse_args()

    warnings_list = []
    log_lines = []

    def log(msg: str):
        print(msg)
        log_lines.append(msg)

    log(f"=== 開始: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===")
    log(f"  - モデル設定: rel_month_length={args.rel_month_length}, "
        f"kg_l2={args.kg_l2}, weight_scheme={args.weight_scheme}")
    if args.ratio_target is not None:
        log(f"  - ratio制約: target={args.ratio_target}, mode={args.ratio_mode}, "
            f"lookback={args.ratio_lookback}, tol={args.ratio_tol}")

    log("[1/8] 入力ファイル読み込み")
    ships = read_senpyou(args.data)
    ship_types = read_ship_types(args.data)
    materials, consumption = read_materials_and_consumption(args.data)
    inventory = read_inventory(args.inventory)
    log(f"  - 船数: {len(ships)}, 船種: {len(ship_types)}, "
        f"SKU: {len(materials)}, 消費レコード: {len(consumption)}, "
        f"在庫レコード: {len(inventory)}")

    # 使用区分別消費データを在庫管理表の出庫実績から追加
    usage_cons = extract_usage_consumption(inventory)
    if len(usage_cons) > 0:
        # 使用区分別SKUの基本sku_idを特定
        base_skus: set[str] = set()
        for sku in usage_cons["sku_id"].unique():
            for loc in _USAGE_LOCATIONS:
                if sku.endswith(f"_{loc}"):
                    base_skus.add(sku[: -(len(loc) + 1)])
                    break
        # 基本SKU材料行から派生エントリを materials に追加
        extra_mats = []
        for sku in usage_cons["sku_id"].unique():
            for base_sku in base_skus:
                if sku.startswith(f"{base_sku}_"):
                    hits = materials[materials["sku_id"] == base_sku]
                    if len(hits) > 0:
                        row = hits.iloc[0].to_dict()
                        row["sku_id"] = sku
                        extra_mats.append(row)
        if extra_mats:
            materials = pd.concat([materials, pd.DataFrame(extra_mats)], ignore_index=True)
        # 重複を避けるため、対象月の基本SKU消費を除外
        usage_months = set(usage_cons["year_month"].unique())
        for base_sku in base_skus:
            consumption = consumption[~(
                (consumption["sku_id"] == base_sku)
                & (consumption["year_month"].isin(usage_months))
            )]
        consumption = pd.concat([consumption, usage_cons], ignore_index=True)
        log(f"  - 使用区分別消費データ追加: {usage_cons['sku_id'].nunique()}区分 / "
            f"{len(usage_cons)}件 (基本SKU {sorted(base_skus)})")

    log("[2/8] データ品質検証")
    warnings_list.extend(validate_ships(ships))
    warnings_list.extend(validate_consumption(consumption))
    warnings_list.extend(validate_inventory(inventory))
    log(f"  - 警告数: {len(warnings_list)}")

    log("[3/8] 学習期間決定")
    if len(consumption) == 0:
        log("  消費データが空 — 中断")
        return
    train_start = consumption["year_month"].min()
    cons_max = consumption["year_month"].max()
    inv_max = inventory["year_month"].max() if len(inventory) > 0 else None
    auto_end = detect_train_end_ym(inventory, consumption)
    if args.train_end is not None:
        train_end = args.train_end
        log(f"  - train_end 明示指定: {train_end}")
    elif auto_end is not None:
        train_end = auto_end
        log(f"  - train_end 自動判定: {train_end} "
            f"(消費最新 {cons_max} / 在庫最新 {inv_max} の登録済 min)")
    else:
        train_end = cons_max
        log(f"  - train_end フォールバック: {train_end} (消費データの最新月)")
    # 学習データを train_end 以前に絞り込み
    consumption = consumption[consumption["year_month"] <= train_end]
    log(f"  - 学習期間: {train_start} 〜 {train_end} "
        f"(消費レコード {len(consumption)} 件)")

    log("[4/8] kg_per_ship と shape(区分) を ALS で同時推定")
    stainless_brands = load_stainless_brands(
        os.path.join(args.config_dir, "stainless_brands.csv")
    )
    log(f"  - ステンレス銘柄: {len(stainless_brands)}件 "
        f"({'制約有効' if stainless_brands else '制約無効 - csv未配置/空'})")
    unit, shape = estimate_kg_and_shape(
        ships, consumption, materials,
        train_start, train_end,
        rel_month_length=args.rel_month_length,
        stainless_brands=stainless_brands,
        kg_l2=args.kg_l2, shape_l2=args.shape_l2,
        weight_scheme=args.weight_scheme,
    )
    unit = apply_category_fallback(unit, ship_types, stainless_brands=stainless_brands)
    override_path = os.path.join(args.config_dir, "unit_consumption_override.csv")
    unit = apply_overrides(unit, override_path)
    log(f"  - 区分: {sorted(shape.keys())}")
    if shape:
        peak_msg = ", ".join(f"{c}=M{int(np.argmax(s))+1}" for c, s in sorted(shape.items()))
        log(f"  - 各区分のピーク rel_month: {peak_msg}")
    save_learned_shape(shape, os.path.join(args.config_dir, "learned_shape.csv"))
    log(f"  - 推定セル数: {len(unit)}")

    log("[4.5/8] ホールドアウト検証 (直近9ヶ月, ALS shape)")
    holdout_result = compute_holdout_mape(
        ships, consumption, holdout_months=9,
        stainless_brands=stainless_brands,
        materials=materials, rel_month_length=args.rel_month_length,
        kg_l2=args.kg_l2, shape_l2=args.shape_l2,
        weight_scheme=args.weight_scheme,
    )
    holdout_baseline = compute_holdout_mape(
        ships, consumption, holdout_months=9, stainless_brands=set(),
        materials=materials, rel_month_length=args.rel_month_length,
        kg_l2=args.kg_l2, shape_l2=args.shape_l2,
        weight_scheme=args.weight_scheme,
    )
    overall_mape: float | None = None
    if not pd.isna(holdout_result["mape"]):
        overall_mape = float(holdout_result["mape"])
        log(f"  - MAPE (制約あり): {overall_mape:.1f}%")
        if not pd.isna(holdout_baseline["mape"]):
            improvement = holdout_baseline["mape"] - overall_mape
            log(f"  - MAPE (制約なし): {holdout_baseline['mape']:.1f}% "
                f"(改善: {improvement:+.1f} pt)")
    else:
        log("  - MAPE算出不可 (学習データ不足)")

    # 個別SKU MAPE を JSON 保存（フロントエンドで銘柄詳細表示に利用）
    per_sku_mape: dict[str, float] = {}
    per_sku_df = holdout_result.get("per_sku", pd.DataFrame())
    if len(per_sku_df) > 0:
        Path(args.output_dir).mkdir(exist_ok=True)
        has_reason = "reason" in per_sku_df.columns
        # 有効MAPE（実績あり）のみ float 保存 (Supabase・後方互換)
        if has_reason:
            valid_df = per_sku_df[per_sku_df["reason"] == "ok"]
        else:
            valid_df = per_sku_df[per_sku_df["mape_%"].notna()]
        per_sku_mape = valid_df.set_index("sku_id")["mape_%"].round(1).to_dict()
        per_sku_path = os.path.join(args.output_dir, "per_sku_mape.json")
        with open(per_sku_path, "w", encoding="utf-8") as f:
            json.dump(per_sku_mape, f, ensure_ascii=False, indent=2)
        # reason 辞書を別ファイル保存（フロント "消費なし" 表示用）
        if has_reason:
            reason_dict = per_sku_df.set_index("sku_id")["reason"].to_dict()
            reason_path = os.path.join(args.output_dir, "per_sku_reason.json")
            with open(reason_path, "w", encoding="utf-8") as f:
                json.dump(reason_dict, f, ensure_ascii=False, indent=2)
            no_mape = [s for s, r in reason_dict.items() if r != "ok"]
            if no_mape:
                log(f"  - 実績ゼロのためMAPE算出不可 ({len(no_mape)}銘柄): "
                    f"{', '.join(sorted(no_mape)[:10])}"
                    + (f"…他{len(no_mape) - 10}件" if len(no_mape) > 10 else ""))
        log(f"  - 個別MAPE ({len(per_sku_mape)}銘柄有効): {per_sku_path}")

    # 月別MAPE (HO検証期間内の各月ごと全SKU平均)
    per_month_df = holdout_result.get("per_month", pd.DataFrame())
    if len(per_month_df) > 0:
        mape_by_month = per_month_df.set_index("year_month")["mape_%"].round(1).to_dict()
        with open(os.path.join(args.output_dir, "mape_by_month.json"), "w", encoding="utf-8") as f:
            json.dump(mape_by_month, f, ensure_ascii=False, indent=2)

    # SKU×月別MAPE
    per_sku_month_df = holdout_result.get("per_sku_month", pd.DataFrame())
    if len(per_sku_month_df) > 0:
        per_sku_month_dict: dict = {}
        for _, row in per_sku_month_df.iterrows():
            per_sku_month_dict.setdefault(row["sku_id"], {})[row["year_month"]] = round(float(row["mape_%"]), 1)
        with open(os.path.join(args.output_dir, "mape_by_sku_month.json"), "w", encoding="utf-8") as f:
            json.dump(per_sku_month_dict, f, ensure_ascii=False, indent=2)

    # ALS × 2 回分の大きなオブジェクトを即時解放
    del holdout_result, holdout_baseline, per_sku_df, per_month_df, per_sku_month_df
    gc.collect()

    log("[5/8] 月次予測生成")
    # 仕様: forecast 起点 = train_end + 1 (= 「出庫または在庫が登録されている最新月」の翌月).
    # 確定発注のみが入っている月 (出庫・在庫ブランク) は forecast 範囲に内包される。
    anchor_ym = train_end
    log(f"  - forecast起点判定: train_end={train_end} → 翌月から{args.forecast_months}か月")
    next_y, next_m = _next_month(anchor_ym)
    forecast_start = f"{next_y:04d}-{next_m:02d}"
    forecast_end = _add_months(forecast_start, args.forecast_months - 1)
    log(f"  - 予測期間: {forecast_start} 〜 {forecast_end}")
    forecast_monthly = generate_monthly_forecast(
        ships, unit, forecast_start, forecast_end,
        materials=materials, shape=shape, rel_month_length=args.rel_month_length,
    )
    if args.ratio_target is not None:
        before_total = forecast_monthly["予測使用量"].sum()
        forecast_monthly = apply_ratio_constraint(
            forecast_monthly, consumption,
            lookback_months=args.ratio_lookback,
            target_ratio=args.ratio_target,
            tol=args.ratio_tol,
            mode=args.ratio_mode,
        )
        after_total = forecast_monthly["予測使用量"].sum()
        log(f"  - ratio制約適用 (mode={args.ratio_mode}, target={args.ratio_target}, "
            f"lookback={args.ratio_lookback}, tol={args.ratio_tol})")
        log(f"    予測総量: {before_total:.0f}kg → {after_total:.0f}kg "
            f"(scale {after_total/before_total if before_total > 0 else 0:.2f})")
    log(f"  - 月次予測レコード: {len(forecast_monthly)}")

    # shape / unit は以降不要: 即時解放
    del unit, shape
    gc.collect()

    log("[6/8] 在庫評価 (実績)")
    stock_eval = compute_stock_evaluation(inventory, consumption)
    log(f"  - 評価レコード: {len(stock_eval)}")

    eval_compare = compare_with_existing_evaluation(stock_eval, inventory)
    if eval_compare["total"] > 0:
        log(f"  - 既存値との一致率: {eval_compare['match_rate']*100:.1f}% "
            f"({eval_compare['matched']}/{eval_compare['total']})")
    else:
        log("  - 既存値との比較データなし")

    del stock_eval, eval_compare
    gc.collect()

    log("[7/8] 推奨発注量")
    if len(inventory) > 0:
        current_stock = (
            inventory[inventory["year_month"] == anchor_ym]
            .groupby("sku_id")["在庫"].sum().reset_index()
        )
    else:
        current_stock = pd.DataFrame(columns=["sku_id", "在庫"])

    planned_in_inventory = extract_planned_orders_from_inventory(inventory)
    if len(planned_in_inventory) > 0:
        log(f"  - 確定発注 (入庫予定のみ登録) 行: {len(planned_in_inventory)} "
            f"(SKU {planned_in_inventory['sku_id'].nunique()}件) → 発注済量列として出力")

    orders = recommend_orders(
        forecast_monthly, current_stock,
        consumption_history=consumption,
        stainless_brands=stainless_brands,
        planned_orders=planned_in_inventory,
    )
    n_confirmed = (
        int(orders["手配済み"].sum()) if len(orders) > 0 and "手配済み" in orders.columns else 0
    )
    log(f"  - 推奨発注レコード: {len(orders)} (うち確定 {n_confirmed})")

    # 発注計算に使った大きなオブジェクトを解放（forecast_monthly は Supabase 保存まで保持）
    del current_stock, planned_in_inventory, consumption, inventory
    gc.collect()

    order_validation_result = None
    if args.inventory_validate:
        log("[7.5/8] 推奨発注 vs 入荷予定 検証")
        planned = read_planned_orders(args.inventory_validate)
        log(f"  - 検証ファイル: {args.inventory_validate}")
        log(f"  - 入荷予定レコード: {len(planned)}, SKU: {planned['sku_id'].nunique() if len(planned) else 0}, "
            f"期間: {sorted(planned['year_month'].unique()) if len(planned) else []}")
        if len(planned) > 0:
            order_validation_result = validate_orders(orders, planned)
            cov = order_validation_result["coverage"]
            log(f"  - MAPE (推奨 vs 計画): {order_validation_result['mape_overall']:.1f}%")
            log(f"  - SKUカバー率: {cov['captured']}/{cov['planned_skus']} "
                f"(false positive: {cov['false_positive_skus']}, missed: {cov['missed_skus']})")
            log(f"  - ±20% 一致率: {order_validation_result['within_20pct_rate']*100:.1f}%")
            tot = order_validation_result["totals"]
            log(f"  - 総量比: 推奨 {tot['recommended_total_kg']:.0f}kg / 計画 {tot['planned_total_kg']:.0f}kg "
                f"(ratio={tot['ratio']:.2f})")
        else:
            log("  - 入荷予定データなし — 検証スキップ")

    log("[8/8] Excelレポート生成")
    Path(args.output_dir).mkdir(parents=True, exist_ok=True)
    res_path = os.path.join(
        args.output_dir,
        "溶接棒在庫管理表　在庫評価追加_RES.xlsx",
    )
    write_inventory_format(
        out_path=res_path,
        orders=orders,
        materials=materials,
    )
    log(f"  - 出力 (_1.xlsx 形式): {res_path}")

    log_path = os.path.join(args.output_dir, "実行ログ.txt")
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines))
        f.write("\n\n=== 警告 ===\n")
        f.write("\n".join(warnings_list))
    log(f"  - ログ: {log_path}")

    # Supabase への予測結果・MAPE 蓄積（環境変数が設定されている場合のみ）
    from src.supabase_client import SupabaseClient
    db = SupabaseClient()
    if db.enabled:
        run_at = datetime.now().isoformat()
        db.save_forecast(run_at, train_end, forecast_monthly, per_sku_mape)
        if overall_mape is not None:
            db.save_mape(run_at, train_end, overall_mape, per_sku_mape)
        log(f"  - Supabase 保存完了 (予測 {len(forecast_monthly)} 件, MAPE {len(per_sku_mape)} 銘柄)")
    else:
        log("  - Supabase: 未設定 (SUPABASE_URL / SUPABASE_KEY 未設定につきスキップ)")

    del forecast_monthly
    gc.collect()
    log("=== 完了 ===")


def _next_month(ym: str):
    y, m = int(ym[:4]), int(ym[5:7])
    m += 1
    if m > 12:
        m = 1
        y += 1
    return y, m


def _add_months(ym: str, n: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    total = y * 12 + (m - 1) + n
    new_y = total // 12
    new_m = total % 12 + 1
    return f"{new_y:04d}-{new_m:02d}"


if __name__ == "__main__":
    main()
