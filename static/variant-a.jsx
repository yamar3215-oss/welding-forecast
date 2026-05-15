/* 溶材会議アプリ — 在庫ダッシュボード v5
   外部DB不要: 全データは window.FORECAST_DATA を参照。Supabase等は不使用。 */

const useCallback = React.useCallback;

// ── レスポンシブ用フック ──
function useWindowWidth() {
  const [w, setW] = useState(window.innerWidth);
  React.useEffect(() => {
    const fn = () => setW(window.innerWidth);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return w;
}

// ──── 数値フォーマット ────
const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('ja-JP'));
const fmtYMLabel = (ym) => ym ? `${ym.slice(0,4)}年${parseInt(ym.slice(5,7))}月` : '—';

function daysToText(days) {
  if (days == null || days >= 999) return '—';
  if (days <= 0) return '在庫切れ';
  if (days >= 30) return `残${Math.round(days / 30 * 10) / 10}か月分`;
  return `残${days}日分`;
}

function barColor(days, dT, cT) {
  if (days == null || days >= 999) return '#94a3b8';
  if (days <= 0 || days < dT) return '#ef4444';
  if (days < cT) return '#eab308';
  return '#22c55e';
}

// ──── MAPE色分けヘルパー（全体で統一）────
// <30%: 緑（良好）/ 30-49%: 橙（注意）/ ≥50%: 赤（要注意）
function mapeColor(pct) {
  if (pct == null) return '#94a3b8';
  if (pct < 30) return '#15803d';
  if (pct < 50) return '#b45309';
  return '#dc2626';
}
function mapeBg(pct) {
  if (pct == null || pct < 30) return 'transparent';
  if (pct < 50) return '#fefce8';
  return '#fef2f2';
}
function fmtMape(pct) {
  return pct == null ? '—' : `${Math.round(pct)}%`;
}

// ──── ヘルプツールチップ ────
// クリックで表示/非表示。ラベル横の ❓ボタンに適用する。
const HELP_TEXTS = {
  グラフ表示月数: '在庫推移グラフに表示する予測月数（3/6/9/12）を選択します。月数を増やすと長期の在庫枯渇リスクを把握しやすくなります。',
  予測開始月: '在庫グラフの表示開始月を選択します。未来月を選ぶと特定の造船スケジュール前後の在庫状況を確認できます。',
  在庫健全性スコア: '余力（現在庫 − 月間消費）を月間消費で割った比率で 1〜5 評価。評価3（適正）は余力が月間消費の2.0倍。評価1〜2 は危険域のため早急な発注が必要です。',
  評価3発注量: '評価3（適正）を達成するために必要な即時発注量。計算式: 月間消費 × 3.0 − 現在庫。マイナスになる場合（在庫十分）は 0 表示。',
  MAPE: '予測精度の指標（Mean Absolute Percentage Error）。実績と予測の乖離率の平均値。20%未満=高精度（緑）、50%以上=要警戒（赤）。ホールドアウト検証で算出。',
  アラート閾値: '残日数が「危険閾値」を下回ると赤ステータス、「注意閾値」を下回ると黄ステータスになります。リードタイムに合わせて設定してください。',
  溶材会議: '新来島ドック納品表に記載された銘柄のみを表示します。納品表とデータが自動照合され、板継用・全姿勢用も独立した行として表示されます。',
  パイプライン予測在庫: 'ALS（交互最小二乗法）による船種別需要分解 + 竣工スケジュールから算出した月末予測在庫量。実際の発注量（確定分）を加味したシミュレーション結果です。',
};

function InfoTooltip({ id }) {
  const [open, setOpen] = React.useState(false);
  const text = HELP_TEXTS[id];
  if (!text) return null;
  return (
    <span style={{ position: 'relative', display: 'inline-block', verticalAlign: 'middle', marginLeft: 3 }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
        style={{
          background: open ? '#0ea5e9' : '#e0f2fe', border: 'none', borderRadius: '50%',
          width: 14, height: 14, fontSize: 9, fontWeight: 700, lineHeight: '14px',
          color: open ? '#fff' : '#0369a1', cursor: 'pointer', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
        title={id}
      >?</button>
      {open && (
        <div style={{
          position: 'absolute', left: 0, top: 18, zIndex: 999, width: 240,
          background: '#1e293b', color: '#f0f9ff', fontSize: 11, lineHeight: 1.6,
          borderRadius: 8, padding: '10px 12px', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          pointerEvents: 'none',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: '#7dd3fc' }}>{id}</div>
          {text}
        </div>
      )}
    </span>
  );
}

const STATUS_RANK = { risk: 0, caution: 1, safe: 2, excess: 3 };
const ST = {
  risk:    { label: '危険', bg: '#fee2e2', color: '#dc2626', dot: '#ef4444' },
  caution: { label: '注意', bg: '#fef9c3', color: '#a16207', dot: '#eab308' },
  safe:    { label: '適正', bg: '#dcfce7', color: '#15803d', dot: '#22c55e' },
  excess:  { label: '過剰', bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6' },
};
const ORDER_CYCLE = ['未発注', '発注済', '保留'];
const ORD_STYLE = {
  '未発注': { bg: '#f1f5f9', color: '#475569' },
  '発注済': { bg: '#dcfce7', color: '#15803d' },
  '保留':   { bg: '#fef9c3', color: '#a16207' },
};

// ──── 95%信頼区間 ────
function computeCI(fcArr, mape_pct) {
  const sigma = Math.min(0.15, (mape_pct || 20) / 400);
  return fcArr.map((fc, i) => {
    const hw = Math.min(0.50, 1.96 * sigma * Math.sqrt(i + 1)) * Math.max(0, fc);
    return { lower: Math.max(0, fc - hw), upper: fc + hw };
  });
}

// ──── 建造スケジュール補助 ────
function ymNum(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + m;
}
function numToYM(n) {
  const y = Math.floor((n - 1) / 12);
  const m = ((n - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}
function addMonthsToYM(ym, n) {
  return numToYM(ymNum(ym) + n);
}

const VESSEL_COLOR = { '大西2号': '#3b82f6', '大西3号': '#0891b2' };
function vColor(v) { return VESSEL_COLOR[v] || '#7c3aed'; }

function enrichShips(ships, periodStart, periodEnd) {
  if (!periodStart || !periodEnd) return [];
  return (ships || []).map(s => {
    if (!s.load) return null;
    const loadYM = s.load.slice(0, 7);
    const constructYM = addMonthsToYM(loadYM, -2);
    return { ...s, loadYM, constructYM };
  }).filter(s => s && (
    (s.loadYM >= periodStart && s.loadYM <= periodEnd) ||
    (s.constructYM >= periodStart && s.constructYM <= periodEnd)
  ));
}

// ──── X軸マッパー ────
function makeXMapper(allYms, PL, iW) {
  if (!allYms || allYms.length < 2) return () => PL;
  const n0 = ymNum(allYms[0]);
  const n1 = ymNum(allYms[allYms.length - 1]);
  return (ym) => {
    const f = Math.max(0, Math.min(1, (ymNum(ym) - n0) / (n1 - n0)));
    return PL + f * iW;
  };
}

// ──── 建造スケジュールタイムライン ────
function ShipTimeline({ ships, allYms, PL, PR }) {
  const W = 900, ROW_H = 16, GAP = 3;
  const iW = W - PL - PR;
  const sx = makeXMapper(allYms, PL, iW);
  const start = allYms[0], end = allYms[allYms.length - 1];
  const visible = enrichShips(ships, start, end);
  if (!visible.length) return null;
  const vessels = [...new Set(visible.map(s => s.vessel))];
  const svgH = vessels.length * (ROW_H + GAP) + 8;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '.06em', marginLeft: PL + 4, marginBottom: 2 }}>
        建造スケジュール &nbsp;
        <span style={{ fontStyle: 'italic', fontWeight: 400 }}>着工（破線）→ 建造開始（●）</span>
      </div>
      <svg viewBox={`0 0 ${W} ${svgH}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <line x1={PL} y1={0} x2={PL} y2={svgH} stroke="#e2e8f0" strokeWidth={1}/>
        {vessels.map((vessel, vi) => {
          const y = vi * (ROW_H + GAP) + 4;
          const col = vColor(vessel);
          return (
            <g key={vessel}>
              <text x={PL - 4} y={y + ROW_H - 3} textAnchor="end" fontSize={8} fill={col}>{vessel}</text>
              {visible.filter(s => s.vessel === vessel).map(ship => {
                const c1 = sx(ship.constructYM < start ? start : ship.constructYM);
                const c2 = sx(ship.loadYM > end ? end : ship.loadYM);
                const bw = Math.max(2, c2 - c1);
                const col2 = vColor(ship.vessel);
                return (
                  <g key={ship.id}>
                    <rect x={c1} y={y} width={bw} height={ROW_H} rx={2}
                      fill={col2} fillOpacity={0.13} stroke={col2} strokeOpacity={0.25} strokeWidth={0.5}/>
                    {ship.constructYM >= start && (
                      <line x1={c1} y1={y} x2={c1} y2={y + ROW_H}
                        stroke={col2} strokeWidth={1} strokeDasharray="2 2" strokeOpacity={0.5}/>
                    )}
                    <line x1={c2} y1={y} x2={c2} y2={y + ROW_H}
                      stroke={col2} strokeWidth={1.5} strokeOpacity={0.75}/>
                    <circle cx={c2} cy={y + ROW_H / 2} r={2.5} fill={col2} opacity={0.75}/>
                    {bw > 32 && (
                      <text x={c1 + 3} y={y + ROW_H - 3} fontSize={7} fill={col2} opacity={0.8}>{ship.id}</text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ──── CI注釈 ────
function CINote({ fcVal0, ci0, ciLast }) {
  return (
    <div style={{ fontSize: 11, color: '#64748b', background: '#f8fafc', border: '1px solid #e2e8f0',
      borderRadius: 6, padding: '6px 12px', marginTop: 6,
      display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontWeight: 600, color: '#475569' }}>📊 95%信頼区間</span>
      <span>この予測値は95%の確率でこの範囲内に収まります</span>
      <span>初月 {fmt(Math.round(fcVal0))}kg → 範囲: {fmt(Math.round(ci0.lower))} 〜 {fmt(Math.round(ci0.upper))}kg</span>
      <span>最終月: {fmt(Math.round(ciLast.lower))} 〜 {fmt(Math.round(ciLast.upper))}kg</span>
    </div>
  );
}

// ──── 集計予測グラフ ────
function ForecastChart({ series, months, skus, mape_pct, ships }) {
  const W = 900, H = 210, PL = 68, PR = 20, PT = 22, PB = 40;
  const iW = W - PL - PR, iH = H - PT - PB;
  const fcPts = useMemo(() => (months || []).map((ym, i) => ({
    ym, val: (skus || []).reduce((s, sk) => s + (sk.monthly_forecast?.[i] || 0), 0),
  })), [months, skus]);
  const acPts = useMemo(() =>
    (series || []).filter(s => s.actual != null).map(s => ({ ym: s.ym, val: s.actual })),
    [series]);
  const ci = useMemo(() => computeCI(fcPts.map(p => p.val), mape_pct), [fcPts, mape_pct]);
  const allYms = useMemo(() =>
    [...new Set([...acPts.map(p => p.ym), ...fcPts.map(p => p.ym)])].sort(),
    [acPts, fcPts]);
  const maxV = useMemo(() => {
    const all = [...fcPts.map(p => p.val), ...acPts.map(p => p.val), ...ci.map(c => c.upper)];
    return Math.max(...all, 1);
  }, [fcPts, acPts, ci]);
  if (!allYms.length || allYms.length < 2) return null;
  const sx = makeXMapper(allYms, PL, iW);
  const sy = (v) => PT + (1 - Math.min(Math.max(v, 0), maxV) / maxV) * iH;
  const fmtK = (v) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v/1e3)}K` : `${Math.round(v)}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ v: t * maxV, y: PT + (1 - t) * iH }));
  const fcPoly = fcPts.map(p => `${sx(p.ym)},${sy(p.val)}`).join(' ');
  const acPoly = acPts.length > 1 ? acPts.map(p => `${sx(p.ym)},${sy(p.val)}`).join(' ') : '';
  const upperPts = fcPts.map((p, i) => [sx(p.ym), sy(ci[i].upper)]);
  const lowerPts = fcPts.map((p, i) => [sx(p.ym), sy(ci[i].lower)]).reverse();
  const ciPoly = [...upperPts, ...lowerPts].map(([x, y]) => `${x},${y}`).join(' ');
  const activeShips = enrichShips(ships, allYms[0], allYms[allYms.length - 1]);
  const hasActual = acPoly.length > 0;
  const legX = PL;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PL} y1={t.y} x2={W - PR} y2={t.y} stroke="#f1f5f9" strokeWidth={1}/>
            <text x={PL - 6} y={t.y + 4} textAnchor="end" fontSize={10} fill="#94a3b8">{fmtK(t.v)}</text>
          </g>
        ))}
        {activeShips.map(ship => {
          const c1 = sx(ship.constructYM < allYms[0] ? allYms[0] : ship.constructYM);
          const c2 = sx(ship.loadYM > allYms[allYms.length-1] ? allYms[allYms.length-1] : ship.loadYM);
          const col = vColor(ship.vessel);
          return (
            <g key={ship.id}>
              <rect x={c1} y={PT} width={Math.max(1, c2 - c1)} height={iH} fill={col} fillOpacity={0.035} stroke="none"/>
              <line x1={c2} y1={PT} x2={c2} y2={PT + iH} stroke={col} strokeWidth={1} strokeOpacity={0.3} strokeDasharray="3 3"/>
            </g>
          );
        })}
        {fcPts.length > 1 && (
          <>
            <polygon points={ciPoly} fill="#0ea5e9" fillOpacity={0.11} stroke="none"/>
            <polyline points={fcPts.map((p, i) => `${sx(p.ym)},${sy(ci[i].upper)}`).join(' ')}
              fill="none" stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.35} strokeDasharray="3 2"/>
            <polyline points={fcPts.map((p, i) => `${sx(p.ym)},${sy(ci[i].lower)}`).join(' ')}
              fill="none" stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.35} strokeDasharray="3 2"/>
          </>
        )}
        {hasActual && (
          <>
            <polyline points={acPoly} fill="none" stroke="#64748b" strokeWidth={2} strokeDasharray="5 2"/>
            {acPts.map((p, i) => <circle key={i} cx={sx(p.ym)} cy={sy(p.val)} r={3} fill="#64748b"/>)}
          </>
        )}
        {fcPts.length > 1 && (
          <>
            <polygon points={`${sx(fcPts[0].ym)},${PT+iH} ${fcPoly} ${sx(fcPts[fcPts.length-1].ym)},${PT+iH}`}
              fill="#0ea5e9" fillOpacity={0.06}/>
            <polyline points={fcPoly} fill="none" stroke="#0ea5e9" strokeWidth={2.5} strokeLinejoin="round"/>
            {fcPts.map((p, i) => <circle key={i} cx={sx(p.ym)} cy={sy(p.val)} r={3.5} fill="#0ea5e9"/>)}
          </>
        )}
        {allYms.filter((_, i) => i % 2 === 0 || i === allYms.length - 1).map(ym => (
          <text key={ym} x={sx(ym)} y={H - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">
            {ym.replace('-', '/')}
          </text>
        ))}
        <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#e2e8f0" strokeWidth={1}/>
        <line x1={PL} y1={PT + iH} x2={W - PR} y2={PT + iH} stroke="#e2e8f0" strokeWidth={1}/>
        <circle cx={legX + 10} cy={PT - 7} r={3.5} fill="#0ea5e9"/>
        <text x={legX + 16} y={PT - 4} fontSize={9} fill="#475569">予測</text>
        {hasActual && (
          <>
            <line x1={legX+46} y1={PT-7} x2={legX+58} y2={PT-7} stroke="#64748b" strokeWidth={2} strokeDasharray="4 2"/>
            <text x={legX+61} y={PT-4} fontSize={9} fill="#475569">実績</text>
          </>
        )}
        <rect x={hasActual?legX+96:legX+46} y={PT-13} width={12} height={9}
          fill="#0ea5e9" fillOpacity={0.2} stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.5} rx={1}/>
        <text x={hasActual?legX+110:legX+60} y={PT-4} fontSize={9} fill="#475569">95%CI</text>
      </svg>
      <ShipTimeline ships={ships} allYms={allYms} PL={PL} PR={PR}/>
      {fcPts.length > 0 && ci.length > 0 && (
        <CINote fcVal0={fcPts[0].val} ci0={ci[0]} ciLast={ci[ci.length - 1]}/>
      )}
    </div>
  );
}

// ──── 個別銘柄予測グラフ ────
const SIM_MULT = [0, 0.5, 1.0, 1.5, 2.0];
const SIM_LABELS = ['発注なし', '50%', '推奨通り', '150%', '200%'];
const SIM_COLORS = ['#94a3b8', '#f59e0b', '#22c55e', '#f97316', '#ef4444'];

function SkuForecastChart({ material, months, mape_pct, ships, finalDecision }) {
  const W = 900, H = 215, PL = 68, PR = 20, PT = 22, PB = 40;
  const iW = W - PL - PR, iH = H - PT - PB;
  const fcArr = material.monthlyForecastArr || [];
  const stArr = material.monthlyStockArr || [];
  const orderArr = material.monthlyOrderArr || [];
  const [simLevel, setSimLevel] = useState(1);
  const [visible, setVisible] = useState({ fc: true, sim: true, st: true, ci: true, stockCi: true, fd: true });
  const [hoverIdx, setHoverIdx] = useState(null);
  const svgRef = useRef(null);
  const simColor = SIM_COLORS[simLevel - 1];
  const toggleVis = (k) => setVisible(v => ({ ...v, [k]: !v[k] }));

  // シミュレーション在庫 (期待値消費ベース)
  const simStock = useMemo(() => {
    const mult = SIM_MULT[simLevel - 1];
    let s = material.current;
    return fcArr.map((fc, i) => {
      s = s - (fc || 0) + mult * (orderArr[i] || 0);
      return Math.max(0, s);
    });
  }, [material, simLevel]);

  const ci = useMemo(() => computeCI(fcArr, mape_pct), [material, mape_pct]);

  // 在庫95%CI: 消費が上限(最悪)・下限(最良)で推移した場合のシミュレーション在庫
  const simStockCI = useMemo(() => {
    if (!ci.length) return { worst: [], best: [] };
    const mult = SIM_MULT[simLevel - 1];
    let sw = material.current, sb = material.current;
    const worst = [], best = [];
    fcArr.forEach((_, i) => {
      sw = sw - (ci[i].upper || 0) + mult * (orderArr[i] || 0);
      sb = sb - (ci[i].lower || 0) + mult * (orderArr[i] || 0);
      worst.push(Math.max(0, sw));
      best.push(Math.max(0, sb));
    });
    return { worst, best };
  }, [material, simLevel, ci]);

  // 最終決定量での在庫シミュレーション (発注量を month[0] に加算)
  const finalDecisionStock = useMemo(() => {
    if (finalDecision == null) return [];
    let s = material.current + finalDecision;
    return fcArr.map((fc) => { s = s - (fc || 0); return Math.max(0, s); });
  }, [material, finalDecision, fcArr]);

  // スコア3閾値 (月間消費×3.0) — グラフ上の水平線
  const score3Threshold = material.monthly * 3.0;

  const maxV = useMemo(() => {
    const all = [
      ...fcArr, ...stArr.filter(v => v != null), ...simStock,
      ...simStockCI.best, ...ci.map(c => c.upper),
      ...(finalDecisionStock.length ? finalDecisionStock : []),
      score3Threshold,
    ];
    return Math.max(...all, 1);
  }, [fcArr, stArr, simStock, simStockCI, ci, finalDecisionStock, score3Threshold]);

  if (!months || months.length < 2) return null;
  const sx = makeXMapper(months, PL, iW);
  const sy = (v) => PT + (1 - Math.min(Math.max(v, 0), maxV) / maxV) * iH;
  const fmtK = (v) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v/1e3)}K` : `${Math.round(v)}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ v: t * maxV, y: PT + (1 - t) * iH }));

  const fcPoly = fcArr.map((v, i) => `${sx(months[i])},${sy(v)}`).join(' ');
  const stPts = stArr.map((v, i) => v != null ? [sx(months[i]), sy(v)] : null).filter(Boolean);
  const stPoly = stPts.map(([x, y]) => `${x},${y}`).join(' ');
  const simPts = simStock.map((v, i) => [sx(months[i]), sy(v)]);
  const simPoly = simPts.map(([x, y]) => `${x},${y}`).join(' ');
  const ciPoly = [
    ...fcArr.map((_, i) => [sx(months[i]), sy(ci[i].upper)]),
    ...fcArr.map((_, i) => [sx(months[i]), sy(ci[i].lower)]).reverse(),
  ].map(([x, y]) => `${x},${y}`).join(' ');
  const stockCiPoly = [
    ...simStockCI.best.map((v, i) => [sx(months[i]), sy(v)]),
    ...simStockCI.worst.map((v, i) => [sx(months[i]), sy(v)]).reverse(),
  ].map(([x, y]) => `${x},${y}`).join(' ');

  const activeShips = enrichShips(ships, months[0], months[months.length - 1]);
  const finalSimStock = simStock[simStock.length - 1];

  // Hover: nearest month from mouse position in SVG coordinates
  const handleMouseMove = (e) => {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    if (mx < PL || mx > W - PR) { setHoverIdx(null); return; }
    let ci2 = 0, cd = Infinity;
    months.forEach((ym, i) => { const d = Math.abs(sx(ym) - mx); if (d < cd) { cd = d; ci2 = i; } });
    setHoverIdx(ci2);
  };

  const fdPoly = finalDecisionStock.length > 0
    ? finalDecisionStock.map((v, i) => `${sx(months[i])},${sy(v)}`).join(' ')
    : '';

  // Legend definition
  const LEGEND = [
    { k: 'fc',      label: '予測消費量',         type: 'line',  color: '#0ea5e9' },
    { k: 'sim',     label: `在庫(${SIM_LABELS[simLevel-1]})`, type: 'line', color: simColor, dash: simLevel > 1 },
    { k: 'stockCi', label: '在庫95%CI',           type: 'band',  color: '#22c55e' },
    { k: 'st',      label: 'パイプライン予測在庫', type: 'dash',  color: '#22c55e' },
    { k: 'ci',      label: '消費95%CI',           type: 'band',  color: '#0ea5e9' },
    ...(finalDecision != null ? [{ k: 'fd', label: `最終決定量(${fmt(Math.round(finalDecision))}kg)`, type: 'line', color: '#f59e0b', dash: false }] : []),
  ];

  return (
    <div>
      {/* 発注シミュレーター */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: '#475569', fontWeight: 700, whiteSpace: 'nowrap', marginRight: 2 }}>発注シミュレーター:</span>
        {[1,2,3,4,5].map(lv => (
          <button key={lv} onClick={() => setSimLevel(lv)} style={{
            padding: '4px 9px', borderRadius: 6, fontSize: 11, fontWeight: 700,
            cursor: 'pointer', border: '1.5px solid',
            background: simLevel === lv ? SIM_COLORS[lv-1] : '#f8fafc',
            color: simLevel === lv ? '#fff' : '#64748b',
            borderColor: simLevel === lv ? SIM_COLORS[lv-1] : '#e2e8f0', minHeight: 30,
          }}>Lv{lv} {SIM_LABELS[lv-1]}</button>
        ))}
        {finalSimStock != null && (
          <span style={{ marginLeft: 6, fontSize: 11, color: '#64748b' }}>
            → 期末在庫(推定): <b style={{ color: simColor }}>{fmt(Math.round(finalSimStock))} kg</b>
          </span>
        )}
      </div>

      {/* 凡例（クリックで表示切替） */}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 5, alignItems: 'center' }}>
        <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 700, letterSpacing: '.05em' }}>凡例クリックで切替:</span>
        {LEGEND.map(({ k, label, type, color, dash }) => (
          <button key={k} onClick={() => toggleVis(k)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 600,
            cursor: 'pointer',
            border: `1.5px solid ${visible[k] ? color : '#e2e8f0'}`,
            background: visible[k] ? `${color}18` : '#f8fafc',
            color: visible[k] ? color : '#94a3b8',
            textDecoration: visible[k] ? 'none' : 'line-through',
            transition: 'all 0.12s',
          }}>
            {type === 'band' ? (
              <span style={{ display:'inline-block', width:12, height:7, borderRadius:2,
                background: color, opacity: visible[k] ? 0.35 : 0.1 }}/>
            ) : (
              <svg width={14} height={6} style={{ display:'block' }}>
                <line x1={0} y1={3} x2={14} y2={3} stroke={visible[k] ? color : '#cbd5e1'}
                  strokeWidth={2} strokeDasharray={dash ? '4 2' : undefined}/>
              </svg>
            )}
            {label}
          </button>
        ))}
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>

        {/* Grid */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PL} y1={t.y} x2={W-PR} y2={t.y} stroke="#f1f5f9" strokeWidth={1}/>
            <text x={PL-6} y={t.y+4} textAnchor="end" fontSize={10} fill="#94a3b8">{fmtK(t.v)}</text>
          </g>
        ))}

        {/* 建造・荷積み帯 */}
        {activeShips.map(ship => {
          const c1 = sx(ship.constructYM < months[0] ? months[0] : ship.constructYM);
          const c2 = sx(ship.loadYM > months[months.length-1] ? months[months.length-1] : ship.loadYM);
          const col = vColor(ship.vessel);
          return (
            <g key={ship.id}>
              <rect x={c1} y={PT} width={Math.max(1,c2-c1)} height={iH} fill={col} fillOpacity={0.035}/>
              <line x1={c2} y1={PT} x2={c2} y2={PT+iH} stroke={col} strokeWidth={1} strokeOpacity={0.3} strokeDasharray="3 3"/>
            </g>
          );
        })}

        {/* ① 消費の95%CIシェード */}
        {fcArr.length > 1 && visible.ci && (
          <>
            <polygon points={ciPoly} fill="#0ea5e9" fillOpacity={0.10}/>
            <polyline points={fcArr.map((_,i)=>`${sx(months[i])},${sy(ci[i].upper)}`).join(' ')}
              fill="none" stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.3} strokeDasharray="3 2"/>
            <polyline points={fcArr.map((_,i)=>`${sx(months[i])},${sy(ci[i].lower)}`).join(' ')}
              fill="none" stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.3} strokeDasharray="3 2"/>
          </>
        )}

        {/* ② 在庫95%CIシェード (消費が上振れ/下振れした場合の在庫変動幅) */}
        {simStock.length > 1 && visible.stockCi && (
          <>
            <polygon points={stockCiPoly} fill="#16a34a" fillOpacity={0.12}/>
            <polyline points={simStockCI.worst.map((v,i)=>`${sx(months[i])},${sy(v)}`).join(' ')}
              fill="none" stroke="#16a34a" strokeWidth={0.9} strokeOpacity={0.45} strokeDasharray="3 2"/>
            <polyline points={simStockCI.best.map((v,i)=>`${sx(months[i])},${sy(v)}`).join(' ')}
              fill="none" stroke="#16a34a" strokeWidth={0.9} strokeOpacity={0.45} strokeDasharray="3 2"/>
          </>
        )}

        {/* パイプライン予測在庫（破線） */}
        {stPoly && stPts.length > 1 && visible.st && (
          <>
            <polyline points={stPoly} fill="none" stroke="#22c55e" strokeWidth={1} strokeDasharray="5 2" strokeOpacity={0.5}/>
            {stPts.map(([x,y],i) => <circle key={i} cx={x} cy={y} r={2} fill="#22c55e" opacity={0.5}/>)}
          </>
        )}

        {/* スコア3閾値ライン (月間消費×3.0) */}
        {score3Threshold <= maxV && (() => {
          const s3y = sy(score3Threshold);
          return (
            <g>
              <line x1={PL} y1={s3y} x2={W-PR} y2={s3y}
                stroke="#f59e0b" strokeWidth={1} strokeDasharray="5 3" opacity={0.65}/>
              <rect x={PL+2} y={s3y-9} width={34} height={12} rx={3} fill="#fffbeb" opacity={0.9}/>
              <text x={PL+5} y={s3y} fontSize={9} fill="#b45309" fontWeight={700}>S3境界</text>
            </g>
          );
        })()}

        {/* シミュレーション在庫ライン */}
        {simPts.length > 1 && visible.sim && (
          <>
            <polyline points={simPoly} fill="none" stroke={simColor} strokeWidth={2.5}
              strokeDasharray={simLevel > 1 ? '7 3' : undefined}/>
            {simPts.map(([x,y],i) => (
              <circle key={i} cx={x} cy={y} r={hoverIdx===i ? 5 : 3} fill={simColor}
                style={{ transition: 'r 0.1s' }}/>
            ))}
          </>
        )}

        {/* 最終決定量シミュレーションライン（橙） */}
        {fdPoly && finalDecisionStock.length > 1 && visible.fd && (
          <>
            <polyline points={fdPoly} fill="none" stroke="#f59e0b" strokeWidth={3}
              strokeLinecap="round" strokeLinejoin="round"/>
            {finalDecisionStock.map((v,i) => (
              <circle key={i} cx={sx(months[i])} cy={sy(v)} r={hoverIdx===i ? 6 : 3.5}
                fill="#f59e0b" stroke="#fff" strokeWidth={1.5} style={{ transition: 'r 0.1s' }}/>
            ))}
          </>
        )}

        {/* 予測消費量（青） */}
        {fcArr.length > 1 && visible.fc && (
          <>
            <polygon points={`${sx(months[0])},${PT+iH} ${fcPoly} ${sx(months[months.length-1])},${PT+iH}`}
              fill="#0ea5e9" fillOpacity={0.06}/>
            <polyline points={fcPoly} fill="none" stroke="#0ea5e9" strokeWidth={2.5} strokeLinejoin="round"/>
            {fcArr.map((v,i) => (
              <circle key={i} cx={sx(months[i])} cy={sy(v)} r={hoverIdx===i ? 5.5 : 3.5} fill="#0ea5e9"
                style={{ transition: 'r 0.1s' }}/>
            ))}
          </>
        )}

        {/* ホバー縦線 + ツールチップ */}
        {hoverIdx != null && months[hoverIdx] && (() => {
          const hx = sx(months[hoverIdx]);
          const fc  = fcArr[hoverIdx] || 0;
          const sim = simStock[hoverIdx] ?? 0;
          const ciU = ci[hoverIdx]?.upper ?? fc;
          const ciL = ci[hoverIdx]?.lower ?? fc;
          const scW = simStockCI.worst[hoverIdx] ?? sim;
          const scB = simStockCI.best[hoverIdx] ?? sim;
          const fdVal = finalDecisionStock[hoverIdx];
          const rows = [
            { label: months[hoverIdx].replace('-','/'), val: null, hdr: true },
            { label: '予測消費量', val: `${fmtK(fc)} kg`, color: '#60a5fa' },
            { label: '在庫(シミュ)', val: `${fmtK(sim)} kg`, color: simColor },
            ...(fdVal != null ? [{ label: '最終決定発注後', val: `${fmtK(fdVal)} kg`, color: '#fbbf24' }] : []),
            { label: '消費95%上限', val: `${fmtK(ciU)} kg`, color: '#94a3b8' },
            { label: '消費95%下限', val: `${fmtK(ciL)} kg`, color: '#94a3b8' },
            { label: '在庫・最悪', val: `${fmtK(scW)} kg`, color: '#4ade80' },
            { label: '在庫・最良', val: `${fmtK(scB)} kg`, color: '#4ade80' },
          ];
          const TW = 192, TH = rows.length * 15 + 12;
          const tx = hx + 10 + TW > W - PR ? hx - TW - 8 : hx + 10;
          const ty = Math.max(PT + 2, Math.min(PT + iH - TH - 2, sy(sim) - TH / 2));
          return (
            <g style={{ pointerEvents: 'none' }}>
              <line x1={hx} y1={PT} x2={hx} y2={PT+iH}
                stroke="#475569" strokeWidth={1} strokeDasharray="4 2" opacity={0.65}/>
              {visible.fc && <circle cx={hx} cy={sy(fc)} r={5.5} fill="#0ea5e9" opacity={0.95}
                stroke="#fff" strokeWidth={1.5}/>}
              {visible.sim && <circle cx={hx} cy={sy(sim)} r={5.5} fill={simColor} opacity={0.95}
                stroke="#fff" strokeWidth={1.5}/>}
              {fdVal != null && visible.fd && <circle cx={hx} cy={sy(fdVal)} r={5.5} fill="#f59e0b"
                opacity={0.95} stroke="#fff" strokeWidth={1.5}/>}
              <rect x={tx} y={ty} width={TW} height={TH} rx={6}
                fill="#1e293b" fillOpacity={0.94}/>
              {rows.map((r, ri) => r.hdr ? (
                <text key={ri} x={tx+10} y={ty+14+ri*15} fontSize={11} fill="#7dd3fc" fontWeight={700}>
                  {r.label}
                </text>
              ) : (
                <text key={ri} x={tx+10} y={ty+14+ri*15} fontSize={10} fill="#e2e8f0">
                  <tspan fill="#94a3b8">{r.label}　</tspan>
                  <tspan fill={r.color} fontWeight={600}>{r.val}</tspan>
                </text>
              ))}
            </g>
          );
        })()}

        {/* 軸 */}
        <line x1={PL} y1={PT} x2={PL} y2={PT+iH} stroke="#e2e8f0" strokeWidth={1}/>
        <line x1={PL} y1={PT+iH} x2={W-PR} y2={PT+iH} stroke="#e2e8f0" strokeWidth={1}/>
        {months.filter((_,i) => i%2===0 || i===months.length-1).map(ym => (
          <text key={ym} x={sx(ym)} y={H-6} textAnchor="middle" fontSize={9} fill="#94a3b8">
            {ym.replace('-','/')}
          </text>
        ))}
      </svg>
      <ShipTimeline ships={ships} allYms={months} PL={PL} PR={PR}/>
      {fcArr.length > 0 && ci.length > 0 && (
        <CINote fcVal0={fcArr[0]} ci0={ci[0]} ciLast={ci[ci.length-1]}/>
      )}
    </div>
  );
}

// ──── 発注根拠パネル ────
function OrderRationalePanel({ material, ships, months }) {
  if (!material || !months || months.length === 0) return null;
  const start = months[0], end = months[months.length - 1];
  const active = enrichShips(ships, start, end);
  if (active.length === 0) return null;
  // 全予測月から消費ピーク月を特定（chartMonths が部分表示でも正しく取得）
  const fcArr = material.monthlyForecastArr || [];
  const allMonths = (window.FORECAST_PERIOD || {}).months || months;
  const peakIdx = fcArr.reduce((mx, v, i) => (v > (fcArr[mx] || 0) ? i : mx), 0);
  const peakYM = allMonths[peakIdx] || months[months.length - 1];
  const peakVal = fcArr[peakIdx] || 0;
  return (
    <div style={{ marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', marginBottom: 6 }}>発注根拠 — 建造スケジュールとの関連</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {active.map(ship => {
          const col = vColor(ship.vessel);
          const inConstruct = peakYM >= ship.constructYM && peakYM <= ship.loadYM;
          return (
            <div key={ship.id} style={{ fontSize: 11, color: '#374151', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: col, marginTop: 2, flexShrink: 0 }}/>
              <span>
                <b style={{ color: col }}>{ship.vessel}</b> #{ship.id} —
                着工 {fmtYMLabel(ship.constructYM)} → 積み出し {fmtYMLabel(ship.loadYM)}
                {inConstruct && peakVal > 0 && (
                  <span style={{ color: '#dc2626', fontWeight: 600 }}>
                    {' '}（消費ピーク {fmtYMLabel(peakYM)}: {fmt(Math.round(peakVal))}kg 重複）
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {peakVal > 0 && (
          <div style={{ fontSize: 11, color: '#475569', marginTop: 4, paddingTop: 4, borderTop: '1px solid #d1fae5' }}>
            消費ピーク月: <b>{fmtYMLabel(peakYM)}</b> — {fmt(Math.round(peakVal))} kg
            （月間平均の {Math.round(peakVal / Math.max(1, material.monthly) * 100)}%）
          </div>
        )}
      </div>
    </div>
  );
}

// ──── 予測精度向上ロジック説明パネル ────
function AccuracyFactorsPanel({ material, globalMape }) {
  const mape = material ? material.mapePct : globalMape;
  const factors = [
    {
      icon: '🚢',
      title: '船種別補正 (ALS行列分解)',
      body: '各船種の溶材消費パターンを交互最小二乗法 (ALS) で学習。ケミカル船・タンカー・バルカー等の消費係数を自動推定し、竣工スケジュールと掛け合わせて月別需要を予測します。',
      color: '#1d4ed8',
    },
    {
      icon: '📅',
      title: '季節性パターン (月次行列)',
      body: '年間12ヶ月の季節係数を学習データから抽出。工事繁忙期（造船スケジュール集中期）や稼働月数の変動を補正し、単純移動平均より精度の高い予測を実現します。',
      color: '#7c3aed',
    },
    {
      icon: '📈',
      title: 'データ蓄積効果 (学習曲線 α=0.35)',
      body: `実績データが増えるほど係数推定の精度が向上します。現在の学習月数18ヶ月を基点に、さらに12ヶ月蓄積するとMAPEは約${mape != null ? Math.round(mape * (1 - Math.pow(18/(18+12), 0.35))) : '—'}%ポイント改善する見込みです（学習曲線モデル）。`,
      color: '#0891b2',
    },
    {
      icon: '⚙️',
      title: '外れ値制約と在庫評価照合',
      body: '月次予測に在庫評価スコア（1〜5段階）との整合チェックを適用。大きく乖離した予測値を制約して実態に沿った結果を維持します。制約MAPE=全銘柄の重み付き平均。',
      color: '#15803d',
    },
  ];
  return (
    <div style={{ marginTop: 14, background: '#f8fafc', borderRadius: 8,
      border: '1px solid #e2e8f0', padding: '12px 14px' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>
        予測精度向上ロジック
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
        {factors.map((f, i) => (
          <div key={i} style={{ background: '#fff', borderRadius: 6, padding: '8px 10px',
            border: `1px solid ${f.color}28`, borderLeft: `3px solid ${f.color}` }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: f.color, marginBottom: 4 }}>
              {f.icon} {f.title}
            </div>
            <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.55 }}>{f.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──── MAPEトレンド + 将来学習曲線グラフ ────
// X軸: 実際のカレンダー月（〇月形式）、過去=実線(橙)、将来=点線(青)+エリア
// 閾値ライン: 20%(高精度)・50%(要警戒)、SVGネイティブ日本語ツールチップ
const _addMtoYm = (ym, n) => {
  if (!ym || ym.length < 7) return '';
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function MapeHistoryChart({ material, globalMapeByMonth }) {
  const [tooltip, setTooltip] = useState(null);
  const W = 900, H = 195, PL = 56, PR = 88, PT = 24, PB = 40;
  const iW = W - PL - PR, iH = H - PT - PB;

  const currentMape = material.mapePct;
  const mapeByMonth = material.mapeByMonth || {};
  const allGlobal = globalMapeByMonth || {};

  const fd = window.FORECAST_DATA || {};
  const periodStart = fd.period_start || '';

  const N_FUTURE = 24, LC_ALPHA = 0.35, trainMonthsNow = 18;

  // 過去実績データ (SKU固有 > グローバル月別の優先順)
  const pastData = useMemo(() => {
    const src = Object.keys(mapeByMonth).length > 0 ? mapeByMonth : allGlobal;
    return Object.entries(src)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ym, v]) => ({ ym, v }));
  }, [material, globalMapeByMonth]);

  // 将来シミュレーションデータ (学習曲線モデル)
  const futureData = useMemo(() => {
    if (currentMape == null || !periodStart) return [];
    return Array.from({ length: N_FUTURE + 1 }, (_, i) => ({
      ym: _addMtoYm(periodStart, i),
      v: currentMape * Math.pow(trainMonthsNow / Math.max(1, trainMonthsNow + i), LC_ALPHA),
    }));
  }, [currentMape, periodStart]);

  // X軸: 過去+将来の全月を結合してソート
  const allYms = useMemo(() => {
    const s = new Set([...pastData.map(d => d.ym), ...futureData.map(d => d.ym)]);
    return [...s].sort();
  }, [pastData, futureData]);

  const hasMapeHistory = pastData.length > 0;

  if (currentMape == null && !hasMapeHistory) {
    return (
      <div style={{ fontSize: 11, color: '#94a3b8', padding: '8px 0' }}>
        この銘柄のMAPEデータがまだ蓄積されていません（実績月数が不足）
      </div>
    );
  }

  const nYm = allYms.length;
  const sx = (ym) => {
    const idx = allYms.indexOf(ym);
    return PL + (idx < 0 ? 0 : idx / Math.max(1, nYm - 1)) * iW;
  };
  const sy = (pct) => PT + (1 - Math.min(Math.max(pct, 0), 100) / 100) * iH;

  const pastPts  = pastData.map(d  => [sx(d.ym),  sy(d.v),  d.ym,  d.v,  false]);
  const futurePts = futureData.map(d => [sx(d.ym), sy(d.v), d.ym, d.v, true]);
  const pastPoly   = pastPts.map(([x, y]) => `${x},${y}`).join(' ');
  const futurePoly = futurePts.map(([x, y]) => `${x},${y}`).join(' ');
  const areaFill = futurePts.length > 1
    ? `${futurePts[0][0]},${PT + iH} ${futurePoly} ${futurePts[futurePts.length - 1][0]},${PT + iH}`
    : '';

  const xTickStep = nYm > 18 ? 3 : nYm > 9 ? 2 : 1;
  const thresholds = [
    { v: 20, label: '高精度 20%', color: '#15803d' },
    { v: 50, label: '要警戒 50%', color: '#dc2626' },
  ];

  const mape12 = currentMape != null
    ? Math.round(currentMape * Math.pow(trainMonthsNow / (trainMonthsNow + 12), LC_ALPHA)) : null;
  const mape24 = currentMape != null
    ? Math.round(currentMape * Math.pow(trainMonthsNow / (trainMonthsNow + 24), LC_ALPHA)) : null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
        予測精度 (MAPE) トレンドと将来シミュレーション
      </div>
      <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6, lineHeight: 1.5 }}>
        {hasMapeHistory
          ? 'ホールドアウト検証期間の月別MAPE実績（実線・橙）と、今後のデータ蓄積による改善予測（点線・青、学習曲線 α=0.35）'
          : `現在のMAPE ${currentMape != null ? Math.round(currentMape) : '—'}% を基点に学習曲線モデルでシミュレーション（α=0.35）`}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}>
        <defs>
          <clipPath id="mc-clip">
            <rect x={PL} y={PT} width={iW} height={iH}/>
          </clipPath>
        </defs>

        {/* 背景バンド: 良好(緑 ≤20%)/ 注意(黄 20-50%)/ 要注意(赤 >50%) */}
        <rect x={PL} y={sy(20)} width={iW} height={sy(0) - sy(20)} fill="#dcfce7" fillOpacity={0.35}/>
        <rect x={PL} y={sy(50)} width={iW} height={sy(20) - sy(50)} fill="#fef9c3" fillOpacity={0.5}/>
        <rect x={PL} y={PT}     width={iW} height={sy(50) - PT}     fill="#fee2e2" fillOpacity={0.35}/>

        {/* Y軸グリッド + ラベル */}
        {[0, 20, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={PL} y1={sy(v)} x2={W - PR} y2={sy(v)} stroke="#e2e8f0" strokeWidth={0.8}/>
            <text x={PL - 4} y={sy(v) + 3.5} textAnchor="end" fontSize={9} fill="#94a3b8">{v}%</text>
          </g>
        ))}

        {/* 閾値ライン: 20%(高精度・緑)/ 50%(要警戒・赤) */}
        {thresholds.map(({ v, label, color }) => (
          <g key={v}>
            <line x1={PL} y1={sy(v)} x2={W - PR} y2={sy(v)}
              stroke={color} strokeWidth={1.3} strokeDasharray="6 3" opacity={0.8}/>
            <text x={W - PR + 4} y={sy(v) + 3.5} fontSize={8} fill={color}>{label}</text>
          </g>
        ))}

        {/* 「現在」縦線 (予測開始月の境界) */}
        {periodStart && allYms.includes(periodStart) && (
          <g>
            <line x1={sx(periodStart)} y1={PT} x2={sx(periodStart)} y2={PT + iH}
              stroke="#64748b" strokeWidth={1} strokeDasharray="4 3"/>
            <text x={sx(periodStart)} y={PT - 7} textAnchor="middle" fontSize={8} fill="#64748b">現在</text>
          </g>
        )}

        {/* 将来エリア (薄い青) */}
        {areaFill && (
          <polygon points={areaFill} fill="#0ea5e9" fillOpacity={0.09} clipPath="url(#mc-clip)"/>
        )}

        {/* 将来学習曲線 (青点線) */}
        {futurePoly && (
          <polyline points={futurePoly} fill="none" stroke="#0ea5e9" strokeWidth={2}
            strokeDasharray="6 3" clipPath="url(#mc-clip)"/>
        )}

        {/* 過去実績MAPE (橙実線) */}
        {pastPoly && (
          <polyline points={pastPoly} fill="none" stroke="#f97316" strokeWidth={2.2}
            clipPath="url(#mc-clip)"/>
        )}

        {/* 過去の円ドット (ホバーでツールチップ) */}
        {pastPts.map(([x, y, ym, v], i) => (
          <circle key={i} cx={x} cy={y} r={4.5}
            fill={mapeColor(v)} stroke="#fff" strokeWidth={1.5}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setTooltip({ x, y, ym, v, isFuture: false })}
            onMouseLeave={() => setTooltip(null)}/>
        ))}

        {/* 将来の円ドット (3ヶ月毎に表示) */}
        {futurePts.filter((_, i) => i % 3 === 0).map(([x, y, ym, v], i) => (
          <circle key={i} cx={x} cy={y} r={3}
            fill="#0ea5e9" stroke="#fff" strokeWidth={1} opacity={0.8}
            style={{ cursor: 'pointer' }}
            onMouseEnter={() => setTooltip({ x, y, ym, v, isFuture: true })}
            onMouseLeave={() => setTooltip(null)}/>
        ))}

        {/* SVGネイティブ日本語ツールチップ */}
        {tooltip && (() => {
          const TW = 168;
          const tx = tooltip.x + 10 + TW > W
            ? Math.max(PL, tooltip.x - TW - 6) : tooltip.x + 10;
          const ty = Math.max(tooltip.y - 30, PT + 2);
          const valTxt = `MAPE ${Math.round(tooltip.v)}%${tooltip.isFuture ? '（予測）' : ''}`;
          return (
            <g>
              <rect x={tx} y={ty} width={TW} height={22} rx={4}
                fill="#1e293b" fillOpacity={0.92}/>
              <text x={tx + 8} y={ty + 14.5} fontSize={10} fill="#fff">
                {fmtYMLabel(tooltip.ym)}：{valTxt}
              </text>
            </g>
          );
        })()}

        {/* 軸枠 */}
        <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#cbd5e1" strokeWidth={1}/>
        <line x1={PL} y1={PT + iH} x2={W - PR} y2={PT + iH} stroke="#cbd5e1" strokeWidth={1}/>

        {/* X軸目盛 (〇月形式 + 相対月数ラベル) */}
        {allYms.filter((_, i) => i % xTickStep === 0).map(ym => {
          const isJan = ym.endsWith('-01');
          // 現在(periodStart)からの相対月数
          const relM = periodStart ? (() => {
            const [py, pm] = periodStart.split('-').map(Number);
            const [yy, ym2] = ym.split('-').map(Number);
            return (yy - py) * 12 + (ym2 - pm);
          })() : null;
          const relLabel = relM == null ? '' :
            relM === 0 ? '' :
            relM < 0 ? `${relM}ヶ月` : `+${relM}ヶ月`;
          return (
            <g key={ym}>
              <line x1={sx(ym)} y1={PT + iH} x2={sx(ym)} y2={PT + iH + 3}
                stroke="#cbd5e1" strokeWidth={0.8}/>
              {isJan && (
                <text x={sx(ym)} y={PT + iH + 12} textAnchor="middle" fontSize={7} fill="#64748b">
                  {ym.slice(0, 4)}年
                </text>
              )}
              <text x={sx(ym)} y={isJan ? PT + iH + 23 : PT + iH + 13}
                textAnchor="middle" fontSize={8} fill="#94a3b8">
                {parseInt(ym.slice(5, 7))}月
              </text>
              {relLabel && relM % 6 === 0 && (
                <text x={sx(ym)} y={isJan ? PT + iH + 34 : PT + iH + 26}
                  textAnchor="middle" fontSize={7} fill={relM < 0 ? '#f97316' : '#0ea5e9'}>
                  {relLabel}
                </text>
              )}
            </g>
          );
        })}

        {/* 凡例 */}
        <line x1={PL} y1={PT - 10} x2={PL + 14} y2={PT - 10} stroke="#f97316" strokeWidth={2.2}/>
        <circle cx={PL + 7} cy={PT - 10} r={3} fill="#f97316"/>
        <text x={PL + 17} y={PT - 6} fontSize={8} fill="#475569">実績MAPE</text>
        <line x1={PL + 76} y1={PT - 10} x2={PL + 90} y2={PT - 10}
          stroke="#0ea5e9" strokeWidth={2} strokeDasharray="5 2"/>
        <circle cx={PL + 83} cy={PT - 10} r={2.5} fill="#0ea5e9" opacity={0.8}/>
        <text x={PL + 93} y={PT - 6} fontSize={8} fill="#475569">改善予測（学習曲線シミュレーション）</text>
      </svg>

      {/* 精度改善実績サマリー */}
      {hasMapeHistory && pastData.length >= 2 && (() => {
        const first = pastData[0], last = pastData[pastData.length - 1];
        const improvement = first.v - last.v;
        const nMonths = pastData.length;
        return (
          <div style={{ fontSize: 11, color: '#475569', marginTop: 6, background: '#fefce8',
            borderRadius: 6, padding: '6px 10px', border: '1px solid #fef08a', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>📈 <b>改善実績:</b> {nMonths}ヶ月間で&nbsp;
              <b style={{ color: improvement > 0 ? '#15803d' : '#dc2626' }}>
                {improvement > 0 ? '+' : ''}{Math.round(improvement)}%ポイント
              </b>&nbsp;{improvement > 0 ? '精度向上' : '変動'}
            </span>
            <span style={{ color: '#94a3b8' }}>
              {fmtYMLabel(first.ym)} {Math.round(first.v)}% → {fmtYMLabel(last.ym)} {Math.round(last.v)}%
            </span>
          </div>
        );
      })()}
      {(mape12 != null || mape24 != null) && (
        <div style={{ fontSize: 11, color: '#475569', marginTop: 4, background: '#f0f9ff',
          borderRadius: 6, padding: '6px 10px', border: '1px solid #bae6fd' }}>
          {mape12 != null && (
            <span>12ヶ月後 ({fmtYMLabel(_addMtoYm(periodStart, 12))}): <b style={{ color: mapeColor(mape12) }}>{mape12}%</b>見込 &nbsp;|&nbsp;</span>
          )}
          {mape24 != null && (
            <span>24ヶ月後 ({fmtYMLabel(_addMtoYm(periodStart, 24))}): <b style={{ color: mapeColor(mape24) }}>{mape24}%</b>見込 &nbsp;</span>
          )}
          <span style={{ color: '#94a3b8' }}>— データ蓄積により精度向上の見込み（学習曲線モデル α=0.35）</span>
        </div>
      )}
    </div>
  );
}

// ──── ソート可能テーブルヘッダー ────
// top: 50 = ページ固定ヘッダー（約48px）の下に追従
function ThSort({ label, sortKey, curKey, curDir, onClick, textAlign }) {
  const active = sortKey === curKey;
  return (
    <th onClick={() => onClick(sortKey)} style={{
      padding: '9px 10px', textAlign: textAlign || 'left', fontSize: 11, fontWeight: 600,
      color: active ? '#0f172a' : '#64748b', cursor: 'pointer', userSelect: 'none',
      whiteSpace: 'nowrap', borderBottom: '2px solid #e2e8f0',
      background: active ? '#f1f5f9' : '#fafafa', position: 'sticky', top: 50, zIndex: 2,
    }}>
      {label} <span style={{ opacity: active ? 1 : 0.4 }}>{active ? (curDir === 'asc' ? '▲' : '▼') : '↕'}</span>
    </th>
  );
}

// ──── MAPE バッジ（テーブル行内表示用） ────
function MapeBadge({ pct, reason }) {
  if (reason === 'zero_actual') {
    return (
      <span style={{ color: '#94a3b8', fontSize: 10, background: '#f1f5f9',
        padding: '2px 5px', borderRadius: 4, whiteSpace: 'nowrap' }}>
        消費なし
      </span>
    );
  }
  if (pct == null) return <span style={{ color: '#94a3b8', fontSize: 11 }}>—</span>;
  const col = mapeColor(pct);
  const bg = mapeBg(pct);
  const isHigh = pct >= 50;
  return (
    <span style={{
      display: 'inline-block', fontWeight: isHigh ? 700 : 600, fontSize: 11,
      color: col, background: bg,
      borderRadius: 5, padding: isHigh ? '2px 7px' : '2px 4px',
      border: isHigh ? `1px solid ${col}30` : 'none',
    }}>
      {Math.round(pct)}%
      {isHigh && <span style={{ fontSize: 9, marginLeft: 3 }}>⚠</span>}
    </span>
  );
}

// ──── メインダッシュボード ────
function VariantA() {
  const fd = window.FORECAST_DATA || {};
  const months = (window.FORECAST_PERIOD || {}).months || [];
  const summary = fd.summary || {};
  const rawSkus = fd.skus || [];
  const series = fd.series || [];
  const globalMape = summary.mape_constrained || 20;
  const globalMapeByMonth = fd.mape_by_month || {};

  // ── 状態 ──
  const [fMonths, setFMonths] = useState(6);       // グラフ表示月数
  const [startOffset, setStartOffset] = useState(0); // グラフ開始月インデックス
  // 評価3達成発注量 (orderSum) は月間消費×3.0−現在庫で固定算出 (orderMonths設定不要)
  const [dangerT, setDangerT] = useState(15);
  const [cautionT, setCautionT] = useState(35);
  const [orderStatus, setOrderStatus] = useState({});
  const [sortKey, setSortKey] = useState('statusRank');
  const [sortDir, setSortDir] = useState('asc');
  const [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [uploadPanel, setUploadPanel] = useState(false);
  const [meetingSkus, setMeetingSkus] = useState([]);
  const [meetingFile, setMeetingFile] = useState(null);
  const [uploadStates, setUploadStates] = useState({
    inventory: { uploading: false, msg: '' },
    data:      { uploading: false, msg: '' },
    plan:      { uploading: false, msg: '' },
  });
  const [selectedSku, setSelectedSku] = useState(null);
  const [inactiveSku, setInactiveSku] = useState(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [finalDecisionInput, setFinalDecisionInput] = useState('');
  const [finalDecision, setFinalDecision] = useState(null);   // 確定した最終決定量 (kg)
  const [finalDecisionMsg, setFinalDecisionMsg] = useState('');

  const width = useWindowWidth();
  const isMobile = width < 768;
  const isTablet = width < 1024;

  // ── 派生データ ──
  const enriched = useMemo(() => MATERIALS.map(m => {
    const status = computeStatus(m, dangerT, cautionT);
    // 評価3(適正)達成に必要な即時発注量: 余力=monthly×2.0 → 必要在庫=monthly×3.0
    const orderSum = Math.max(0, Math.round(m.monthly * 3.0 - m.current));
    return { ...m, status, statusRank: STATUS_RANK[status], orderSum };
  }), [dangerT, cautionT]);

  const urgentCount = useMemo(() => enriched.filter(s => s.status === 'risk').length, [enriched]);
  const cautionCount = useMemo(() => enriched.filter(s => s.status === 'caution').length, [enriched]);
  // 溶材会議: 納品書に含まれる銘柄（なければアラート銘柄にフォールバック）
  // 正規化マッチング: trailing underscore 除去 + prefix + 板継用/全姿勢用サフィックス
  const meetingList = useMemo(() => {
    if (meetingSkus.length === 0) return enriched.filter(s => s.status === 'risk' || s.status === 'caution');
    const USAGE_SFXS = ['_板継用', '_全姿勢用'];
    const normSet = new Set(meetingSkus.map(s => s.replace(/_+$/, '')));
    return enriched.filter(s => {
      // 1: 完全一致
      if (meetingSkus.includes(s.sku)) return true;
      const normSku = s.sku.replace(/_+$/, '');
      // 2: 正規化完全一致
      if (normSet.has(normSku)) return true;
      // 3: 板継用/全姿勢用サフィックスを除いた基底が一致
      for (const sfx of USAGE_SFXS) {
        if (s.sku.endsWith(sfx)) {
          const base = s.sku.slice(0, -sfx.length);
          const normBase = base.replace(/_+$/, '');
          if (meetingSkus.includes(base) || normSet.has(normBase)) return true;
        }
      }
      // 4: prefix マッチ (納品表 SKU が forecast SKU の prefix、またはその逆)
      for (const ms of normSet) {
        if (normSku.startsWith(ms + '_') || ms.startsWith(normSku + '_')) return true;
      }
      return false;
    });
  }, [enriched, meetingSkus]);
  const meetingCount = meetingList.length;

  const selectedMaterial = useMemo(() =>
    selectedSku ? enriched.find(m => m.sku === selectedSku) : null,
    [selectedSku, enriched]);

  const skuMape = selectedMaterial ? selectedMaterial.mapePct : null;

  const skuCV = useMemo(() => {
    if (!selectedMaterial || skuMape != null) return null;
    const arr = (selectedMaterial.monthlyForecastArr || []).filter(v => v > 0);
    if (arr.length < 2) return null;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    if (mean <= 0) return null;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return Math.round(Math.sqrt(variance) / mean * 100);
  }, [selectedMaterial, skuMape]);

  const displayed = useMemo(() => {
    let list = filter === 'meeting' ? [...meetingList] : [...enriched];
    list.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (av == null) av = sortDir === 'asc' ? Infinity : -Infinity;
      if (bv == null) bv = sortDir === 'asc' ? Infinity : -Infinity;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv, 'ja') : bv.localeCompare(av, 'ja');
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }, [enriched, meetingList, filter, sortKey, sortDir]);

  // 表示中の稼働銘柄のみのMAPE（フィルター + 非稼働除外 に連動）
  const displayedMape = useMemo(() => {
    const active = displayed.filter(m => !inactiveSku.has(m.sku) && m.mapePct != null);
    if (!active.length) return null;
    return Math.round(active.reduce((s, m) => s + m.mapePct, 0) / active.length);
  }, [displayed, inactiveSku]);

  const inactiveCount = inactiveSku.size;
  const activeCountInDisplayed = displayed.filter(m => !inactiveSku.has(m.sku)).length;

  // グラフ表示月: startOffset から fMonths 分
  const chartMonths = useMemo(() => {
    const off = Math.min(startOffset, Math.max(0, months.length - 1));
    return months.slice(off, off + fMonths);
  }, [months, startOffset, fMonths]);

  // グラフ用データ: 配列もwindowに合わせてスライス
  const chartMaterial = useMemo(() => {
    if (!selectedMaterial) return null;
    const off = Math.min(startOffset, Math.max(0, months.length - 1));
    const n = chartMonths.length;
    const sl = (arr) => (arr || []).slice(off, off + n);
    return {
      ...selectedMaterial,
      monthlyForecastArr: sl(selectedMaterial.monthlyForecastArr),
      monthlyStockArr:    sl(selectedMaterial.monthlyStockArr),
      monthlyOrderArr:    sl(selectedMaterial.monthlyOrderArr),
      monthlyConfirmedArr: sl(selectedMaterial.monthlyConfirmedArr),
    };
  }, [selectedMaterial, startOffset, chartMonths]);

  // グラフ末尾月にスコア3を達成するための発注量 (消費累計を加味した逆算)
  const score3OrderQty = useMemo(() => {
    if (!selectedMaterial || chartMonths.length === 0) return 0;
    const fcArr = (chartMaterial || selectedMaterial).monthlyForecastArr || [];
    const totalConsumption = fcArr.reduce((s, v) => s + (v || 0), 0);
    // target: 期末在庫 = monthly × 3.0 (スコア3の上限 = スコア4への境界)
    return Math.max(0, Math.round(selectedMaterial.monthly * 3.0 - selectedMaterial.current + totalConsumption));
  }, [selectedMaterial, chartMaterial, chartMonths]);
  const targetMonthLabel = chartMonths.length > 0 ? fmtYMLabel(chartMonths[chartMonths.length - 1]) : '—';

  // ── ハンドラ ──
  const handleSort = useCallback((key) => {
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); return prev; }
      setSortDir('asc'); return key;
    });
  }, []);

  const cycleOrder = useCallback((sku) => {
    setOrderStatus(prev => {
      const cur = prev[sku] || '未発注';
      const next = ORDER_CYCLE[(ORDER_CYCLE.indexOf(cur) + 1) % ORDER_CYCLE.length];
      return { ...prev, [sku]: next };
    });
  }, []);

  const handleToggleInactive = useCallback((sku) => {
    setInactiveSku(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  }, []);

  const handleRerun = async () => {
    setRunning(true);
    setRunMsg('予測計算を開始しました。完了後にページを再読み込みしてください（1〜3分）。');
    try { await fetch('/api/run', { method: 'POST' }); }
    catch (_) { setRunMsg('エラーが発生しました。'); }
    setRunning(false);
  };

  const handleFinalDecision = async () => {
    const qty = parseFloat(finalDecisionInput);
    if (isNaN(qty) || qty < 0) { setFinalDecisionMsg('正しい数値(kg)を入力してください'); return; }
    setFinalDecision(qty);
    if (!selectedMaterial) { setFinalDecisionMsg('✓ グラフに反映しました'); return; }
    try {
      const res = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: selectedMaterial.sku, ym: targetMonthLabel, qty }),
      });
      setFinalDecisionMsg(res.ok ? '✓ 保存・グラフ反映しました' : '⚠ 保存エラー（グラフには反映済）');
    } catch (_) {
      setFinalDecisionMsg('⚠ 保存エラー（グラフには反映済）');
    }
  };

  const handleUploadFile = async (e, fileType) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const setMsg = (msg, uploading = false) =>
      setUploadStates(prev => ({ ...prev, [fileType]: { uploading, msg } }));
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setMsg('⚠ xlsx ファイルのみ対応しています');
      return;
    }
    setMsg('アップロード中...', true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/upload?file_type=${fileType}`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'アップロード失敗');
      }
      const data = await res.json();
      setMsg(`✓ ${data.filename} を受信しました`);
    } catch (err) {
      setMsg(`エラー: ${err.message}`);
    }
  };

  // 銘柄選択変更時に最終決定量をリセット
  useEffect(() => {
    setFinalDecision(null);
    setFinalDecisionInput('');
    setFinalDecisionMsg('');
  }, [selectedSku]);

  // 溶材会議 SKU リストを起動時に取得
  useEffect(() => {
    fetch('/api/meeting-skus')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.skus) { setMeetingSkus(d.skus); setMeetingFile(d.filename); } })
      .catch(() => {});
  }, []);

  const thProps = { curKey: sortKey, curDir: sortDir, onClick: handleSort };
  const mDate = (typeof fmtYM === 'function' && typeof MEETING_DATE !== 'undefined') ? fmtYM(MEETING_DATE) : '—';

  // ── MAPE KPIカードの動的ラベル・値（フィルター + 非稼働に連動） ──
  const mapeKpiLabel = filter === 'meeting'
    ? `溶材会議MAPE（${displayed.length}銘柄）`
    : inactiveCount > 0
      ? `稼働MAPE（真の予測精度）`
      : '予測精度 (MAPE)';
  const mapeKpiValue = fmtMape(displayedMape);
  const mapeKpiUnit = filter === 'meeting'
    ? `溶材会議銘柄の平均 ／ 全体: ${fmtMape(globalMape)}`
    : inactiveCount > 0
      ? `稼働${activeCountInDisplayed}銘柄 ／ 非稼働${inactiveCount}銘柄除外`
      : `全${enriched.length}銘柄の平均`;
  const mapeKpiColor = mapeColor(displayedMape);

  // ── KPIカードデータ ──
  const kpiCards = selectedMaterial ? [
    { label: '現在庫', value: fmt(selectedMaterial.current) + ' kg', unit: selectedMaterial.isStockSynthesized ? '（推定値）' : '', color: '#0f172a' },
    { label: '残日数', value: daysToText(selectedMaterial.daysLeft), unit: `月間消費 ${fmt(selectedMaterial.monthly)} kg`, color: selectedMaterial.status === 'risk' ? '#dc2626' : selectedMaterial.status === 'caution' ? '#b45309' : '#15803d' },
    { label: `${targetMonthLabel}に健全在庫スコア3になるための発注量`, value: fmt(score3OrderQty) + ' kg', unit: `在庫健全性スコア ${selectedMaterial.healthScore ?? '—'}/5 ／ MAPE: ${fmtMape(displayedMape)}`, color: score3OrderQty > 0 ? '#b45309' : '#15803d' },
  ] : [
    { label: '総予測重量', value: fmt(summary.total_forecast_kg), unit: `kg ／ ${months.length}か月`, color: '#0f172a' },
    { label: mapeKpiLabel, value: mapeKpiValue, unit: mapeKpiUnit, color: mapeKpiColor },
    { label: '溶材会議', value: `${meetingCount}件`, unit: meetingSkus.length > 0 ? `納品書: ${meetingFile || '読込済'}` : `危険 ${urgentCount}件 ／ 注意 ${cautionCount}件`, color: urgentCount > 0 ? '#dc2626' : cautionCount > 0 ? '#b45309' : '#0891b2' },
  ];

  const kpiCols = isMobile ? '1fr' : isTablet ? 'repeat(2,1fr)' : 'repeat(3,1fr)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', background: '#f1f5f9' }}>

      {/* ── ヘッダー（ページ上部に固定） ── */}
      <header style={{
        background: '#0f172a', color: '#fff', padding: '10px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        boxShadow: '0 2px 8px rgba(0,0,0,.3)', flexShrink: 0,
        position: 'sticky', top: 0, zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {isMobile && (
            <button onClick={() => setSidebarOpen(s => !s)} style={{
              background: 'rgba(255,255,255,.15)', color: '#fff', border: 'none',
              borderRadius: 6, padding: '8px 10px', fontSize: 18, cursor: 'pointer',
              minHeight: 44, minWidth: 44, lineHeight: 1,
            }}>☰</button>
          )}
          {selectedSku && (
            <button onClick={() => setSelectedSku(null)} style={{
              background: 'rgba(255,255,255,.1)', color: '#93c5fd',
              border: '1px solid rgba(255,255,255,.2)',
              borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', fontWeight: 600, minHeight: 44,
            }}>← 全体に戻る</button>
          )}
          <div style={{ fontSize: isMobile ? 14 : 18, fontWeight: 700 }}>🔧 在庫ダッシュボード</div>
          {selectedMaterial && !isMobile && (
            <div style={{ fontSize: 13, color: '#7dd3fc', fontWeight: 600 }}>› {selectedMaterial.code}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!isMobile && (
            <div style={{ fontSize: 16, fontWeight: 700, color: '#93c5fd' }}>溶材会議日：{mDate}</div>
          )}
          <button onClick={() => setUploadPanel(p => !p)} style={{
            background: uploadPanel ? '#0f766e' : '#059669', color: '#fff', border: 'none',
            borderRadius: 8, padding: '0 14px', fontWeight: 700, fontSize: 13,
            cursor: 'pointer', minHeight: 44,
          }}>
            📤 {isMobile ? 'Excel' : 'Excel更新'} {uploadPanel ? '▲' : '▼'}
          </button>
          <button onClick={handleRerun} disabled={running} style={{
            background: running ? '#334155' : '#0ea5e9', color: '#fff', border: 'none',
            borderRadius: 8, padding: '0 18px', fontWeight: 700, fontSize: 13,
            cursor: running ? 'not-allowed' : 'pointer', minHeight: 44,
          }}>
            {running ? '計算中…' : (isMobile ? '▶ 再実行' : '▶ 予測を再実行')}
          </button>
        </div>
      </header>

      {runMsg && (
        <div style={{ background: '#eff6ff', padding: '6px 20px', fontSize: 12, color: '#1d4ed8', borderBottom: '1px solid #bfdbfe' }}>
          {runMsg}
        </div>
      )}
      {uploadPanel && (
        <div style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0', padding: '12px 20px' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', marginBottom: 10 }}>
            ファイルをアップロードして「▶ 予測を再実行」を押してください
          </div>
          {[
            { key: 'inventory', label: '在庫管理表', hint: '_1.xlsx（在庫実績・在庫評価）' },
            { key: 'data',      label: '銘柄マスタ',  hint: 'data.xlsx（銘柄・消費実績）' },
            { key: 'plan',      label: '発注計画書',  hint: '_2.xlsx（発注計画・検証用）' },
          ].map(({ key, label, hint }) => {
            const st = uploadStates[key];
            const isErr = st.msg.startsWith('エラー') || st.msg.startsWith('⚠');
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7, flexWrap: 'wrap' }}>
                <label style={{
                  background: st.uploading ? '#94a3b8' : '#0891b2', color: '#fff',
                  borderRadius: 6, padding: '6px 12px', fontWeight: 700, fontSize: 12,
                  cursor: st.uploading ? 'not-allowed' : 'pointer',
                  userSelect: 'none', minWidth: 96, textAlign: 'center', whiteSpace: 'nowrap',
                }}>
                  <input type="file" accept=".xlsx" onChange={e => handleUploadFile(e, key)}
                    style={{ display: 'none' }} disabled={st.uploading} />
                  {st.uploading ? '送信中…' : `📤 ${label}`}
                </label>
                <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 160 }}>{hint}</span>
                {st.msg ? (
                  <span style={{ fontSize: 11, fontWeight: 600, color: isErr ? '#dc2626' : '#15803d' }}>
                    {st.msg}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* ── 情報バー（フィルター連動MAPEを表示） ── */}
      <div style={{ background: '#fff', borderBottom: '1px solid #e2e8f0',
        padding: '5px 20px', fontSize: 11, color: '#64748b',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: 4 }}>
        <span>予測期間 {fd.period_start} 〜 {fd.period_end} ／ 生成: {fd.generated_at}</span>
        <span style={{ fontWeight: 600, color: '#334155', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>総予測 {fmt(summary.total_forecast_kg)} kg</span>
          <span>｜</span>
          <span>
            {filter === 'meeting' ? '溶材会議MAPE' : inactiveCount > 0 ? '稼働MAPE' : 'MAPE'}
            <span style={{
              marginLeft: 4, fontWeight: 700,
              color: mapeColor(displayedMape),
              background: displayedMape != null && displayedMape >= 50 ? '#fee2e2' : 'transparent',
              borderRadius: 4, padding: displayedMape != null && displayedMape >= 50 ? '0 4px' : 0,
            }}>
              {fmtMape(displayedMape)}
            </span>
            {filter !== 'all' && (
              <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: 4 }}>
                （全体: {fmtMape(globalMape)}）
              </span>
            )}
          </span>
          <span>｜ 警告 {summary.warnings ?? '—'} 件</span>
          {inactiveCount > 0 && (
            <span style={{ color: '#94a3b8', fontWeight: 400 }}>／ 非稼働{inactiveCount}銘柄除外</span>
          )}
        </span>
      </div>

      <div style={{ display: 'flex', flex: 1 }}>

        {/* モバイル バックドロップ */}
        {isMobile && sidebarOpen && (
          <div onClick={() => setSidebarOpen(false)} style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 150,
          }}/>
        )}

        {/* ── サイドバー ── */}
        <aside style={{
          width: 220, flexShrink: 0, background: '#fff', borderRight: '1px solid #e2e8f0',
          padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 18,
          overflowY: 'auto',
          ...(isMobile ? {
            position: 'fixed', top: 0, bottom: 0, left: sidebarOpen ? 0 : -230,
            zIndex: 200, transition: 'left 0.22s ease', boxShadow: sidebarOpen ? '4px 0 20px rgba(0,0,0,0.2)' : 'none',
          } : {
            position: 'sticky', top: 50, maxHeight: 'calc(100vh - 50px)', alignSelf: 'flex-start',
          }),
        }}>
          {isMobile && (
            <button onClick={() => setSidebarOpen(false)} style={{
              alignSelf: 'flex-end', background: '#f1f5f9', border: 'none',
              borderRadius: 6, padding: '6px 12px', fontSize: 13, cursor: 'pointer',
              color: '#475569', fontWeight: 600, minHeight: 44,
            }}>✕ 閉じる</button>
          )}

          {/* 予測グラフ表示月数 */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>グラフ表示月数<InfoTooltip id="グラフ表示月数"/></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {[3, 6, 9, 12].map(n => (
                <button key={n} onClick={() => setFMonths(n)} style={{
                  padding: '7px 0', fontSize: 13, fontWeight: 600,
                  background: fMonths === n ? '#0f172a' : '#f1f5f9',
                  color: fMonths === n ? '#fff' : '#475569',
                  border: 'none', borderRadius: 6, cursor: 'pointer', minHeight: 40,
                }}>{n}か月</button>
              ))}
            </div>
          </div>

          {/* 予測開始月 */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>予測開始月<InfoTooltip id="予測開始月"/></div>
            <select
              value={startOffset}
              onChange={e => setStartOffset(Number(e.target.value))}
              style={{
                width: '100%', padding: '6px 8px', borderRadius: 6,
                border: '1px solid #cbd5e1', fontSize: 12, background: '#fff',
                color: '#0f172a', cursor: 'pointer',
              }}
            >
              {months.map((ym, i) => (
                <option key={ym} value={i}>{fmtYMLabel(ym)}〜</option>
              ))}
            </select>
            {startOffset > 0 && (
              <button onClick={() => setStartOffset(0)} style={{
                marginTop: 4, width: '100%', fontSize: 11, padding: '3px 0',
                background: '#f1f5f9', border: 'none', borderRadius: 6,
                color: '#64748b', cursor: 'pointer',
              }}>先頭に戻す</button>
            )}
          </div>

          {/* 在庫健全性スコア説明 */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              在庫健全性スコア (1〜5)<InfoTooltip id="在庫健全性スコア"/>
            </div>
            <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.6 }}>
              余力 = 現在庫 − 月間消費<br/>
              <span style={{ color: '#dc2626', fontWeight: 600 }}>評価1</span>: 余力≤月消費×1.0<br/>
              <span style={{ color: '#b45309', fontWeight: 600 }}>評価2</span>: ×1.5 &nbsp;
              <span style={{ color: '#15803d', fontWeight: 600 }}>評価3(適正)</span>: ×2.0<br/>
              <span style={{ color: '#1d4ed8', fontWeight: 600 }}>評価4</span>: ×2.5 &nbsp;
              <span style={{ color: '#1d4ed8', fontWeight: 600 }}>評価5</span>: ×3.0+<br/>
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
              評価3達成発注量 = 月消費×3.0 − 現在庫
            </div>
          </div>

          {/* アラート閾値 */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>アラート閾値<InfoTooltip id="アラート閾値"/></div>
            {[
              { label: '危険', color: '#dc2626', val: dangerT, set: setDangerT },
              { label: '注意', color: '#eab308', val: cautionT, set: setCautionT },
            ].map(({ label, color, val, set }) => (
              <div key={label} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 4 }}>● {label}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="number" value={val} min={1} max={360}
                    onChange={e => set(Math.max(1, Number(e.target.value)))}
                    style={{ width: 56, padding: '4px 6px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12, textAlign: 'right' }}/>
                  <span style={{ fontSize: 11, color: '#64748b' }}>日以下</span>
                </div>
              </div>
            ))}
          </div>

          {/* 絞り込み（フィルター連動MAPE表示） */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>絞り込み</div>
            {[
              { key: 'all', label: `全銘柄 (${enriched.length}件)` },
              { key: 'meeting', label: `溶材会議 (${meetingCount}件)`, tooltip: '溶材会議' },
            ].map(({ key, label, tooltip }) => (
              <button key={key} onClick={() => setFilter(key)} style={{
                display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
                padding: '7px 10px', marginBottom: 4, fontSize: 12,
                fontWeight: filter === key ? 700 : 500,
                background: filter === key ? '#f1f5f9' : 'transparent',
                color: filter === key ? '#0f172a' : '#64748b',
                border: 'none', borderRadius: 6, cursor: 'pointer', minHeight: 40,
              }}>{label}{tooltip && <InfoTooltip id={tooltip}/>}</button>
            ))}
            {/* フィルター別MAPE速報 */}
            <div style={{ background: '#f8fafc', borderRadius: 6, padding: '6px 10px', border: '1px solid #e2e8f0', marginTop: 4 }}>
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>
                {filter === 'meeting' ? '溶材会議MAPE' : '表示中MAPE'}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: mapeColor(displayedMape) }}>
                {fmtMape(displayedMape)}
              </div>
              {filter !== 'all' && (
                <div style={{ fontSize: 10, color: '#94a3b8' }}>全体: {fmtMape(globalMape)}</div>
              )}
            </div>
          </div>

          {/* 非稼働銘柄パネル */}
          {inactiveCount > 0 && (
            <div style={{ background: '#fef9c3', borderRadius: 8, padding: '10px 12px', border: '1px solid #fde68a' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#a16207', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>非稼働銘柄</div>
              <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600 }}>{inactiveCount}銘柄 除外中</div>
              <div style={{ fontSize: 11, color: '#a16207', marginTop: 2 }}>
                稼働MAPE: <b>{fmtMape(displayedMape)}</b>
              </div>
              <button onClick={() => setInactiveSku(new Set())} style={{
                marginTop: 8, fontSize: 11, padding: '4px 10px', borderRadius: 6,
                background: '#fff', border: '1px solid #fde68a',
                color: '#a16207', cursor: 'pointer', width: '100%', fontWeight: 600,
              }}>すべて稼働に戻す</button>
            </div>
          )}

          {/* 選択中の銘柄パネル */}
          {selectedMaterial && (
            <div style={{ background: '#f0f9ff', borderRadius: 8, padding: '12px', border: '1px solid #bae6fd' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#0ea5e9', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>選択中の銘柄</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>{selectedMaterial.code}</div>
              <div style={{ fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: '#64748b' }}>MAPE: </span>
                {skuMape != null ? (
                  <b style={{ color: mapeColor(skuMape), fontSize: 14 }}>{fmtMape(skuMape)}</b>
                ) : (
                  <span style={{ color: '#94a3b8' }}>—</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8 }}>
                {filter === 'meeting' ? '溶材会議' : '全体'}MAPE: {fmtMape(displayedMape)}
                {skuMape != null && (
                  <span style={{ color: skuMape < (displayedMape || globalMape) ? '#15803d' : '#dc2626', marginLeft: 4 }}>
                    ({skuMape < (displayedMape || globalMape) ? '↑良好' : '↓低精度'})
                  </span>
                )}
              </div>
              <button onClick={() => setSelectedSku(null)} style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 6,
                background: '#fff', border: '1px solid #bae6fd',
                color: '#0ea5e9', cursor: 'pointer', width: '100%', fontWeight: 600,
              }}>選択解除</button>
            </div>
          )}

        </aside>

        {/* ── メインコンテンツ ── */}
        <main style={{ flex: 1, padding: isMobile ? 10 : 16, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>

          {/* KPIカード */}
          <div style={{ display: 'grid', gridTemplateColumns: kpiCols, gap: 12 }}>
            {kpiCards.map(({ label, value, unit, color }) => (
              <div key={label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 18px' }}>
                <div style={{ fontSize: 11, color: '#64748b', fontWeight: 500, marginBottom: 6 }}>{label}</div>
                <div style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{unit}</div>
              </div>
            ))}
          </div>

          {/* グラフエリア */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px' }}>
            {selectedMaterial ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
                    {selectedMaterial.code} — 月次予測（消費量 kg）
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{
                      background: skuMape != null && skuMape >= 50 ? '#fef2f2' : '#f8fafc',
                      border: `1px solid ${skuMape != null && skuMape >= 50 ? '#fca5a5' : '#e2e8f0'}`,
                      borderRadius: 6, padding: '4px 10px', fontSize: 12,
                    }}>
                      MAPE:&nbsp;
                      {skuMape != null ? (
                        <b style={{ fontSize: 16, color: mapeColor(skuMape) }}>{fmtMape(skuMape)}</b>
                      ) : (
                        <b style={{ color: '#94a3b8' }}>—</b>
                      )}
                      {skuMape == null && skuCV != null && (
                        <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 4 }}>変動係数: {skuCV}%</span>
                      )}
                      <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 4 }}>（直近9ヶ月HO）</span>
                    </span>
                    <span style={{ fontSize: 11, color: '#94a3b8', padding: '4px 8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6 }}>
                      {filter === 'meeting' ? '溶材会議' : '全体'}MAPE: <b style={{ color: mapeColor(displayedMape) }}>{fmtMape(displayedMape)}</b>
                      {skuMape != null && displayedMape != null && (
                        <span style={{ marginLeft: 4, color: skuMape < displayedMape ? '#15803d' : '#dc2626' }}>
                          {skuMape < displayedMape
                            ? `（+${(displayedMape - skuMape).toFixed(0)}pt 良好）`
                            : `（−${(skuMape - displayedMape).toFixed(0)}pt 低精度）`}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
                {/* 最終決定量パネル */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  marginBottom: 8, background: '#fffbeb', border: '1px solid #fde68a',
                  borderRadius: 8, padding: '8px 12px',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', whiteSpace: 'nowrap' }}>
                    {targetMonthLabel}スコア3達成：<span style={{ color: '#b45309', fontSize: 15 }}>{fmt(score3OrderQty)} kg</span>
                  </div>
                  <div style={{ width: 1, height: 24, background: '#fcd34d', flexShrink: 0 }}/>
                  <label style={{ fontSize: 11, fontWeight: 600, color: '#78350f', whiteSpace: 'nowrap' }}>
                    溶材会議での最終決定量:
                  </label>
                  <input
                    type="number" min={0} step={1}
                    value={finalDecisionInput}
                    onChange={e => setFinalDecisionInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleFinalDecision()}
                    placeholder={`例: ${fmt(score3OrderQty)}`}
                    style={{
                      width: 110, padding: '5px 8px', borderRadius: 6,
                      border: finalDecision != null ? '2px solid #f59e0b' : '1px solid #fcd34d',
                      fontSize: 13, fontWeight: 700, textAlign: 'right', background: '#fff',
                    }}
                  />
                  <span style={{ fontSize: 11, color: '#92400e' }}>kg</span>
                  <button onClick={handleFinalDecision} style={{
                    padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                    background: '#f59e0b', color: '#fff', border: 'none', cursor: 'pointer',
                  }}>確定・グラフ反映</button>
                  {finalDecision != null && (
                    <button onClick={() => { setFinalDecision(null); setFinalDecisionInput(''); setFinalDecisionMsg(''); }}
                      style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6,
                        background: '#fff', border: '1px solid #fcd34d', color: '#92400e', cursor: 'pointer' }}>
                      クリア
                    </button>
                  )}
                  {finalDecisionMsg && (
                    <span style={{ fontSize: 11, color: finalDecisionMsg.startsWith('✓') ? '#15803d' : '#dc2626', fontWeight: 600 }}>
                      {finalDecisionMsg}
                    </span>
                  )}
                </div>

                {/* グラフ説明: 月次予測と在庫シミュレーション */}
                <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6, lineHeight: 1.5 }}>
                  <b>消費量予測（青）</b>: 建造スケジュールと過去実績から推定した月別使用量 kg ／
                  <b> 在庫シミュレーション（カラーライン）</b>: 初期状態=Lv1（発注なし）で、現在庫から月次消費を差し引いた在庫推移。ボタンで発注倍率を変更可 ／
                  <b> 95%CI（水色帯）</b>: MAPE×1.96σを用いた予測誤差範囲
                </div>
                <SkuForecastChart material={chartMaterial || selectedMaterial} months={chartMonths.length >= 2 ? chartMonths : months.slice(0, fMonths)} mape_pct={displayedMape || globalMape} ships={SHIPS} finalDecision={finalDecision}/>
                <OrderRationalePanel material={selectedMaterial} ships={SHIPS} months={chartMonths.length >= 2 ? chartMonths : months.slice(0, fMonths)}/>
                <MapeHistoryChart material={selectedMaterial} globalMapeByMonth={globalMapeByMonth}/>
                <AccuracyFactorsPanel material={selectedMaterial} globalMape={displayedMape}/>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>月次予測推移（使用量 kg）</div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 8, lineHeight: 1.5 }}>
                  全銘柄合計の月別消費量予測（青）と、在庫管理表に記録された実績消費量（グレー破線）の比較。
                  水色帯はMAPEから算出した95%信頼区間。表示中フィルターに応じてMAPEが連動します。
                </div>
                <ForecastChart series={series} months={months} skus={rawSkus} mape_pct={displayedMape || globalMape} ships={SHIPS} highlightMonths={chartMonths}/>
              </>
            )}
          </div>

          {/* 材料一覧テーブル */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                {filter === 'meeting' ? `溶材会議 一覧${meetingSkus.length > 0 ? `（納品書: ${meetingFile || ''}）` : ''}` : '全材料在庫一覧'}
                <span style={{ fontSize: 12, color: '#64748b', fontWeight: 400, marginLeft: 8 }}>{displayed.length}銘柄</span>
                {inactiveCount > 0 && (
                  <span style={{ fontSize: 11, color: '#a16207', background: '#fef9c3', borderRadius: 6, padding: '1px 8px', marginLeft: 8, fontWeight: 600 }}>
                    非稼働{inactiveCount}銘柄あり
                  </span>
                )}
              </div>
              {!isMobile && (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>
                  「詳細」または材料名クリックで個別グラフ ／ 「稼働」ボタンでMAPE除外 ／ MAPE<span style={{ color: '#b45309' }}>橙</span>≥30% <span style={{ color: '#dc2626' }}>赤</span>≥50%
                </div>
              )}
            </div>

            {/* overflowY: clip → th の position:sticky がページヘッダー下に追従 */}
            <div style={{ overflowX: 'auto', overflowY: 'clip' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={{
                      padding: '9px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
                      borderBottom: '2px solid #e2e8f0', background: '#fafafa',
                      whiteSpace: 'nowrap', position: 'sticky', top: 50, zIndex: 2, width: 72,
                    }}>詳細</th>
                    <ThSort label="状態" sortKey="statusRank" {...thProps}/>
                    <ThSort label="材料名" sortKey="code" {...thProps}/>
                    <ThSort label="現在庫 (kg)" sortKey="current" textAlign="right" {...thProps}/>
                    <ThSort label="残日数" sortKey="daysLeft" {...thProps}/>
                    <ThSort label="月間消費 (kg)" sortKey="monthly" textAlign="right" {...thProps}/>
                    <ThSort label={<span>評価3発注量 (kg)<InfoTooltip id="評価3発注量"/></span>} sortKey="orderSum" textAlign="right" {...thProps}/>
                    <ThSort label={<span>MAPE<InfoTooltip id="MAPE"/></span>} sortKey="mapePct" textAlign="center" {...thProps}/>
                    <th style={{
                      padding: '9px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
                      borderBottom: '2px solid #e2e8f0', background: '#fafafa',
                      whiteSpace: 'nowrap', position: 'sticky', top: 50, zIndex: 2,
                    }}>発注状況</th>
                    <th style={{
                      padding: '9px 10px', fontSize: 11, fontWeight: 600, color: '#64748b',
                      borderBottom: '2px solid #e2e8f0', background: '#fafafa',
                      whiteSpace: 'nowrap', position: 'sticky', top: 50, zIndex: 2, textAlign: 'center',
                    }}>稼働</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((m, i) => {
                    const st = ST[m.status];
                    const ord = orderStatus[m.sku] || '未発注';
                    const os = ORD_STYLE[ord];
                    const bc = barColor(m.daysLeft, dangerT, cautionT);
                    const pct = Math.min(100, Math.max(0, ((m.daysLeft || 0) / (cautionT * 2)) * 100));
                    const isSel = selectedSku === m.sku;
                    const isInactive = inactiveSku.has(m.sku);
                    const isHighMape = !isInactive && m.mapePct != null && m.mapePct >= 50;
                    return (
                      <tr key={m.sku} style={{
                        background: isSel ? '#f0f9ff' : isHighMape ? '#fff5f5' : i % 2 === 0 ? '#fff' : '#fafafa',
                        borderBottom: isHighMape ? '1px solid #fecaca' : '1px solid #f1f5f9',
                        outline: isSel ? '2px solid #0ea5e9' : isHighMape ? '1px solid #fca5a5' : 'none',
                        outlineOffset: -1,
                        opacity: isInactive ? 0.45 : 1,
                      }}>
                        <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                          <button onClick={() => setSelectedSku(isSel ? null : m.sku)} style={{
                            padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                            cursor: 'pointer', border: '1px solid',
                            background: isSel ? '#0ea5e9' : '#f8fafc',
                            color: isSel ? '#fff' : '#475569',
                            borderColor: isSel ? '#0ea5e9' : '#e2e8f0',
                            minWidth: 54, minHeight: 32,
                          }}>
                            {isSel ? '✓選択中' : '詳細'}
                          </button>
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
                            background: isInactive ? '#f1f5f9' : st.bg,
                            color: isInactive ? '#94a3b8' : st.color,
                            borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 600 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: isInactive ? '#94a3b8' : st.dot }}/>
                            {isInactive ? '非稼働' : st.label}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <button onClick={() => setSelectedSku(isSel ? null : m.sku)} style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            fontWeight: 600, color: isInactive ? '#94a3b8' : '#0f172a', fontSize: 12, padding: 0,
                            textDecoration: isSel ? 'underline' : 'none',
                            textDecorationColor: '#0ea5e9', whiteSpace: 'nowrap',
                          }}>
                            {m.code}
                          </button>
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: m.isStockSynthesized ? '#94a3b8' : '#0f172a' }}>
                          {fmt(m.current)}
                          {m.isStockSynthesized && <span style={{ fontSize: 9, color: '#b0bec5', marginLeft: 3 }}>推定</span>}
                        </td>
                        <td style={{ padding: '8px 10px', minWidth: 120 }}>
                          <div style={{ fontSize: 11, color: '#334155', marginBottom: 3, fontWeight: 500 }}>{daysToText(m.daysLeft)}</div>
                          <div style={{ height: 5, borderRadius: 3, background: '#f1f5f9', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: bc, borderRadius: 3 }}/>
                          </div>
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#334155' }}>{fmt(m.monthly)}</td>
                        <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                          {(() => {
                            const hs = m.healthScore;
                            const hsColor = hs <= 1 ? '#dc2626' : hs <= 2 ? '#b45309' : hs === 3 ? '#15803d' : '#1d4ed8';
                            const hsLabel = hs <= 1 ? '危' : hs <= 2 ? '注' : hs === 3 ? '適' : '過';
                            return (
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5 }}>
                                <span style={{ fontSize: 9, fontWeight: 700, color: hsColor,
                                  background: `${hsColor}18`, borderRadius: 4, padding: '1px 4px',
                                  border: `1px solid ${hsColor}40`, whiteSpace: 'nowrap' }}>
                                  {hsLabel}{hs}
                                </span>
                                <span style={{ fontWeight: 700, color: m.orderSum > 0 ? '#b45309' : '#94a3b8' }}>
                                  {m.orderSum > 0 ? fmt(m.orderSum) : '—'}
                                </span>
                              </div>
                            );
                          })()}
                        </td>
                        {/* MAPE列 */}
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          <MapeBadge pct={m.mapePct} reason={m.mapeReason}/>
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <button onClick={() => cycleOrder(m.sku)} style={{
                            padding: '3px 12px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                            cursor: 'pointer', border: 'none', background: os.bg, color: os.color,
                            minWidth: 56, minHeight: 32,
                          }}>
                            {ord}
                          </button>
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          <button
                            onClick={() => handleToggleInactive(m.sku)}
                            title={isInactive ? '稼働に戻す' : 'MAPEから除外する'}
                            style={{
                              padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                              cursor: 'pointer', border: '1px solid',
                              background: isInactive ? '#fef9c3' : '#f1f5f9',
                              color: isInactive ? '#a16207' : '#64748b',
                              borderColor: isInactive ? '#fde68a' : '#e2e8f0',
                              minWidth: 60, minHeight: 32,
                            }}
                          >
                            {isInactive ? '非稼働' : '稼働中'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}
