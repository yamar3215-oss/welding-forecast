/* 溶材会議アプリ — 共通データ & 予測ロジック
   実データ版: Claude Code パイプラインの出力 (forecast_report.xlsx → forecast-data.js) を読み込む。
   差し替えポイント: predictStock() / recommendOrder() — 現在は実データテーブル参照。
   さらに高度なロジック (船別配賦・原単位ベース計算) に置き換える場合はここを編集。 */

// ===== 日付 / 会議基準日 =====
// 予測期間の先頭から1ヶ月後を会議基準日とする
const _periodStart = (window.FORECAST_DATA && window.FORECAST_DATA.period_start) || '2026-07';
const _ps = _periodStart.split('-');
const MEETING_DATE = new Date(parseInt(_ps[0]), parseInt(_ps[1]) - 1, 1);

const addMonths = (d, m) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + m);
  return x;
};
const fmtYM = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月`;
const fmtYMSlash = (d) => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;

// ===== 銘柄カテゴリ判定 =====
// brand 名から推定（暫定 — マスタ連携後は明示マッピングへ）
function inferCategory(brand) {
  const b = (brand || '').toUpperCase();
  // ステンレス・低合金: 309, 316, 308, 317, MOL, NSSW
  if (/309|316|308|317|MOL|NSSW|TGS|US-/.test(b)) return 'stainless';
  // フラックス・FBB系・SAW
  if (/^(NF|FBB|MF|PF)/.test(b) || /FLUX|SAW/.test(b)) return 'flux';
  // 既定: 軟鋼FCW/Solid
  return 'mild';
}

const CATEGORIES = {
  stainless: { label: 'ステンレス材', color: '#dc2626', priority: '最重要' },
  mild:      { label: '軟鋼材',       color: '#0891b2', priority: '通常' },
  flux:      { label: 'フラックス',   color: '#7c3aed', priority: '通常' },
};

// ===== リードタイム推定（カテゴリ別の既定値） =====
function inferLead(cat) {
  if (cat === 'stainless') return 180;
  if (cat === 'flux') return 60;
  return 90;
}

// ===== 簡易ハッシュ（現在在庫の決定論的合成用） =====
function _hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return h;
}

// ===== 実データから MATERIALS マスタを生成 =====
// 在庫kg は連携未済のため、月消費から決定論的に合成（0.3〜3.5ヶ月分）
function buildMaterials(fd) {
  return (fd.skus || []).map((s, idx) => {
    const monthly = Math.max(1, Math.round(s.total_forecast_12m / 12));
    const cat = inferCategory(s.brand);
    const lead = inferLead(cat);
    // 在庫kg: 優先順位
    //   1. 実データ s.current_stock_kg (在庫マスタ連携済み)
    //   2. パイプラインの予測在庫初月値 s.monthly_stock[0] が正なら採用
    //   3. それが0なら、最初の非0月次予測在庫を採用 (初月のみ偶然0だが次月以降に立ち上がるケース)
    //   4. 月次予測在庫が全て0 (非アクティブSKU) → ハッシュ合成
    let current;
    if (s.current_stock_kg != null) {
      current = Math.round(s.current_stock_kg);
    } else if (s.monthly_stock && s.monthly_stock.length > 0) {
      const ms0 = s.monthly_stock[0];
      if (ms0 != null && ms0 > 0) {
        current = Math.round(ms0);
      } else {
        const firstNonZero = s.monthly_stock.find(v => v != null && v > 0);
        if (firstNonZero != null) {
          current = Math.round(firstNonZero);
        } else {
          const factor = 0.3 + (_hash(s.sku) % 320) / 100;
          current = Math.round(monthly * factor);
        }
      }
    } else {
      const factor = 0.3 + (_hash(s.sku) % 320) / 100;
      current = Math.round(monthly * factor);
    }
    // 残日数: 現在庫 ÷ 月間消費 × 30 (直感的な消費ペース基準)
    const daysLeft = monthly > 0 ? Math.round((current / monthly) * 30) : 999;

    // 在庫評価 (1=過少, 3=適正, 5=過剰): 実値優先、無ければ予測初月で代替
    const stockEvalArr = s.monthly_stock_eval || [];
    let currentEval = s.stock_evaluation_yama;
    if (currentEval == null && stockEvalArr.length > 0) currentEval = stockEvalArr[0];
    // 上位5%は最重要
    const priority = idx < Math.max(5, (fd.skus.length * 0.08) | 0) ? '最重要' : '通常';
    return {
      // 旧スキーマ互換
      code: s.display_name,
      sku: s.sku,
      cat,
      current,
      monthly,
      daysLeft,
      currentEval,
      lead,
      priority,
      shape: s.diameter ? `線径${s.diameter}mm` : '—',
      spool: s.form ? `${s.form}kg ${/^(B|TGS|US)/.test(s.brand) ? '棒' : 'パック'}` : (cat === 'flux' ? '袋' : '—'),
      // 拡張
      brand: s.brand,
      diameter: s.diameter,
      form: s.form,
      monthlyForecastArr: s.monthly_forecast,
      monthlyOrderArr: s.monthly_order,
      monthlyConfirmedArr: s.monthly_confirmed_kg || [],
      monthlyStockArr: s.monthly_stock || [],
      monthlyStockEvalArr: s.monthly_stock_eval || [],
      hasRealForecast: s.has_real_forecast,
      stockEvalYama: s.stock_evaluation_yama,
      stockEvalYM: s.stock_evaluation_ym,
      totalForecast12m: s.total_forecast_12m,
      totalOrder12m: s.total_order_12m,
      isStockSynthesized: (s.current_stock_kg == null),
      mapePct: (s.mape_pct != null) ? s.mape_pct : null,
      mapeReason: s.mape_reason || null,
      mapeByMonth: s.mape_by_month || {},
      usage: s.usage || null,
    };
  });
}

const FD = window.FORECAST_DATA || { skus: [], months: [], summary: {}, series: [] };
const MATERIALS = buildMaterials(FD);

// 統計 (要発注件数は閾値依存なので VariantA で都度算出する)
const STATS = {
  total: MATERIALS.length,
  ships: 17,
  shipsTotal: 29,
  totalForecastKg: FD.summary ? FD.summary.total_forecast_kg : 0,
  mape: FD.summary ? FD.summary.mape_constrained : null,
  evalMatch: FD.summary ? FD.summary.eval_match_rate : null,
  generatedAt: FD.generated_at,
  periodStart: FD.period_start,
  periodEnd: FD.period_end,
};

// ===== ケミカル船表（社外秘 — デフォルト非表示） =====
const SHIPS = [
  { id: 's6278', vessel: '大西2号', load: '2025-06-27', overdue: true },
  { id: 's6292', vessel: '大西2号', load: '2025-10-22' },
  { id: 's6311', vessel: '大西2号', load: '2026-02-05' },
  { id: 's6308', vessel: '大西3号', load: '2026-03-13' },
  { id: 's6312', vessel: '大西2号', load: '2026-05-15' },
  { id: 's6320', vessel: '大西3号', load: '2026-05-27' },
  { id: 's6326', vessel: '大西3号', load: '2026-07-29' },
  { id: 's6328', vessel: '大西3号', load: '2026-08-28' },
  { id: 's6337', vessel: '大西2号', load: '2026-10-09' },
  { id: 's6351', vessel: '大西2号', load: '2026-12-11' },
  { id: 's6366', vessel: '大西3号', load: '2027-01-15' },
  { id: 's6353', vessel: '大西2号', load: '2027-02-19' },
  { id: 's6357', vessel: '大西2号', load: '2027-05-12' },
  { id: 's6368', vessel: '大西3号', load: '2027-09-01' },
  { id: 's6380', vessel: '大西2号', load: '2027-12-15' },
  { id: 's6378', vessel: '大西3号', load: '2028-01-14' },
  { id: 's6381', vessel: '大西3号', load: '2028-03-10' },
];

// ===== 予測ロジック（実データテーブル参照）=====
// predictStock(material, monthsAhead) → N か月先の月末予測在庫を取得
//   monthlyStockArr は RES.xlsx の 月末予測在庫 (入庫を考慮済み)
function predictStock(m, monthsAhead) {
  const fcArr = m.monthlyForecastArr || [];
  let consumed = 0;
  for (let i = 0; i < monthsAhead && i < fcArr.length; i++) consumed += fcArr[i];
  consumed = Math.round(consumed);

  const stockArr = m.monthlyStockArr || [];
  const idx = Math.min(monthsAhead, stockArr.length) - 1;
  const stockFromPipeline = idx >= 0 ? stockArr[idx] : null;

  const est = (stockFromPipeline != null)
    ? Math.max(0, Math.round(stockFromPipeline))
    : Math.max(0, m.current - consumed);

  // 残日数: 現在庫 ÷ 月間消費 × 30 (消費ペース基準、直感的)
  const daysLeft = m.monthly > 0 ? Math.round((m.current / m.monthly) * 30) : 999;

  let level = 5;
  if (est === 0) level = 1;
  else if (est < m.monthly) level = 2;
  else if (est < m.monthly * 1.5) level = 3;
  else if (est < m.monthly * 3) level = 4;
  return { estimatedKg: est, consumedKg: consumed, level, daysLeft };
}

// recommendOrder(material, monthsAhead) → Claude Code 出力の推奨発注量を積算
function recommendOrder(m, monthsAhead) {
  const arr = m.monthlyOrderArr || [];
  let sum = 0;
  for (let i = 0; i < monthsAhead && i < arr.length; i++) sum += arr[i];
  return Math.round(sum);
}

// confirmedOrder(material, monthsAhead) → 入力ファイル由来の確定発注量を積算
//   monthsAhead 期間内で確定値 (null でない要素) を合計
function confirmedOrder(m, monthsAhead) {
  const arr = m.monthlyConfirmedArr || [];
  let sum = 0;
  let hasAny = false;
  for (let i = 0; i < monthsAhead && i < arr.length; i++) {
    if (arr[i] != null) {
      sum += arr[i];
      hasAny = true;
    }
  }
  return { sum: Math.round(sum), hasAny };
}

// ===== レベル → ラベル/色 =====
const LEVEL_META = {
  1: { label: '在庫切れ', color: '#dc2626', bg: '#fee2e2' },
  2: { label: '危険',     color: '#dc2626', bg: '#fee2e2' },
  3: { label: '注意',     color: '#b45309', bg: '#fef3c7' },
  4: { label: '余裕',     color: '#15803d', bg: '#dcfce7' },
  5: { label: '余裕',     color: '#15803d', bg: '#dcfce7' },
};

// 状態の4区分:
//   risk    → 危険 (残日数 < danger 閾値)
//   caution → 注意 (danger 閾値 ≤ 残日数 < caution 閾値)
//   excess  → 過剰 (残日数が caution 以上 かつ 在庫評価 ≥ 4)
//   safe    → 適正 (上記いずれにも該当しない)
const STATUS_META = {
  risk:    { label: '危険', color: '#dc2626', bg: '#fee2e2', dot: '#ef4444' },
  caution: { label: '注意', color: '#b45309', bg: '#fef3c7', dot: '#f59e0b' },
  safe:    { label: '適正', color: '#15803d', bg: '#dcfce7', dot: '#22c55e' },
  excess:  { label: '過剰', color: '#1d4ed8', bg: '#dbeafe', dot: '#3b82f6' },
};

// 残日数+在庫評価+閾値から状態を算出
function computeStatus(m, danger, caution) {
  const days = m.daysLeft != null ? m.daysLeft : 999;
  if (days < danger) return 'risk';
  if (days < caution) return 'caution';
  if (m.currentEval != null && m.currentEval >= 4) return 'excess';
  return 'safe';
}

Object.assign(window, {
  MEETING_DATE, addMonths, fmtYM, fmtYMSlash,
  CATEGORIES, MATERIALS, STATS, SHIPS,
  predictStock, recommendOrder, confirmedOrder, computeStatus,
  LEVEL_META, STATUS_META,
  FORECAST_PERIOD: { start: FD.period_start, end: FD.period_end, months: FD.months },
});
