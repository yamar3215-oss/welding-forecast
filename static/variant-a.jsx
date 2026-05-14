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
function SkuForecastChart({ material, months, mape_pct, ships }) {
  const W = 900, H = 210, PL = 68, PR = 20, PT = 22, PB = 40;
  const iW = W - PL - PR, iH = H - PT - PB;
  const fcArr = material.monthlyForecastArr || [];
  const stArr = material.monthlyStockArr || [];
  const ci = useMemo(() => computeCI(fcArr, mape_pct), [material, mape_pct]);
  const maxV = useMemo(() => {
    const all = [...fcArr, ...stArr.filter(v => v != null), ...ci.map(c => c.upper)];
    return Math.max(...all, 1);
  }, [fcArr, stArr, ci]);
  if (!months || months.length < 2) return null;
  const sx = makeXMapper(months, PL, iW);
  const sy = (v) => PT + (1 - Math.min(Math.max(v, 0), maxV) / maxV) * iH;
  const fmtK = (v) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v/1e3)}K` : `${Math.round(v)}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ v: t * maxV, y: PT + (1 - t) * iH }));
  const fcPoly = fcArr.map((v, i) => `${sx(months[i])},${sy(v)}`).join(' ');
  const stPts = stArr.map((v, i) => v != null ? [sx(months[i]), sy(v)] : null).filter(Boolean);
  const stPoly = stPts.map(([x, y]) => `${x},${y}`).join(' ');
  const upperPts = fcArr.map((_, i) => [sx(months[i]), sy(ci[i].upper)]);
  const lowerPts = fcArr.map((_, i) => [sx(months[i]), sy(ci[i].lower)]).reverse();
  const ciPoly = [...upperPts, ...lowerPts].map(([x, y]) => `${x},${y}`).join(' ');
  const activeShips = enrichShips(ships, months[0], months[months.length - 1]);
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
          const c1 = sx(ship.constructYM < months[0] ? months[0] : ship.constructYM);
          const c2 = sx(ship.loadYM > months[months.length-1] ? months[months.length-1] : ship.loadYM);
          const col = vColor(ship.vessel);
          return (
            <g key={ship.id}>
              <rect x={c1} y={PT} width={Math.max(1, c2 - c1)} height={iH} fill={col} fillOpacity={0.035} stroke="none"/>
              <line x1={c2} y1={PT} x2={c2} y2={PT + iH} stroke={col} strokeWidth={1} strokeOpacity={0.3} strokeDasharray="3 3"/>
            </g>
          );
        })}
        {fcArr.length > 1 && (
          <>
            <polygon points={ciPoly} fill="#0ea5e9" fillOpacity={0.11} stroke="none"/>
            <polyline points={fcArr.map((_, i) => `${sx(months[i])},${sy(ci[i].upper)}`).join(' ')}
              fill="none" stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.35} strokeDasharray="3 2"/>
            <polyline points={fcArr.map((_, i) => `${sx(months[i])},${sy(ci[i].lower)}`).join(' ')}
              fill="none" stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.35} strokeDasharray="3 2"/>
          </>
        )}
        {stPoly && stPts.length > 1 && (
          <>
            <polyline points={stPoly} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeDasharray="5 2"/>
            {stPts.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={2.5} fill="#22c55e"/>)}
          </>
        )}
        {fcArr.length > 1 && (
          <>
            <polygon points={`${sx(months[0])},${PT+iH} ${fcPoly} ${sx(months[months.length-1])},${PT+iH}`}
              fill="#0ea5e9" fillOpacity={0.06}/>
            <polyline points={fcPoly} fill="none" stroke="#0ea5e9" strokeWidth={2.5} strokeLinejoin="round"/>
            {fcArr.map((v, i) => <circle key={i} cx={sx(months[i])} cy={sy(v)} r={3.5} fill="#0ea5e9"/>)}
          </>
        )}
        {months.filter((_, i) => i % 2 === 0 || i === months.length - 1).map(ym => (
          <text key={ym} x={sx(ym)} y={H - 6} textAnchor="middle" fontSize={9} fill="#94a3b8">
            {ym.replace('-', '/')}
          </text>
        ))}
        <line x1={PL} y1={PT} x2={PL} y2={PT + iH} stroke="#e2e8f0" strokeWidth={1}/>
        <line x1={PL} y1={PT + iH} x2={W - PR} y2={PT + iH} stroke="#e2e8f0" strokeWidth={1}/>
        <circle cx={PL+10} cy={PT-7} r={3.5} fill="#0ea5e9"/>
        <text x={PL+16} y={PT-4} fontSize={9} fill="#475569">予測消費量</text>
        <line x1={PL+76} y1={PT-7} x2={PL+88} y2={PT-7} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 2"/>
        <text x={PL+91} y={PT-4} fontSize={9} fill="#475569">予測在庫</text>
        <rect x={PL+138} y={PT-13} width={12} height={9}
          fill="#0ea5e9" fillOpacity={0.2} stroke="#0ea5e9" strokeWidth={0.5} strokeOpacity={0.5} rx={1}/>
        <text x={PL+152} y={PT-4} fontSize={9} fill="#475569">95%CI</text>
      </svg>
      <ShipTimeline ships={ships} allYms={months} PL={PL} PR={PR}/>
      {fcArr.length > 0 && ci.length > 0 && (
        <CINote fcVal0={fcArr[0]} ci0={ci[0]} ciLast={ci[ci.length - 1]}/>
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

  // ── 状態 ──
  const [fMonths, setFMonths] = useState(3);       // グラフ表示月数
  const [orderMonths, setOrderMonths] = useState(3); // 推奨発注計算月数（1〜6）
  const [dangerT, setDangerT] = useState(15);
  const [cautionT, setCautionT] = useState(35);
  const [orderStatus, setOrderStatus] = useState({});
  const [sortKey, setSortKey] = useState('statusRank');
  const [sortDir, setSortDir] = useState('asc');
  const [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');
  const [selectedSku, setSelectedSku] = useState(null);
  const [inactiveSku, setInactiveSku] = useState(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const width = useWindowWidth();
  const isMobile = width < 768;
  const isTablet = width < 1024;

  // ── 派生データ ──
  const enriched = useMemo(() => MATERIALS.map(m => {
    const status = computeStatus(m, dangerT, cautionT);
    // orderMonths で推奨発注量を計算（fMonths とは独立）
    const orderSum = Math.round((m.monthlyOrderArr || []).slice(0, orderMonths).reduce((s, v) => s + (v || 0), 0));
    return { ...m, status, statusRank: STATUS_RANK[status], orderSum };
  }), [dangerT, cautionT, orderMonths]);

  const urgentCount = useMemo(() => enriched.filter(s => s.status === 'risk').length, [enriched]);
  const cautionCount = useMemo(() => enriched.filter(s => s.status === 'caution').length, [enriched]);

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
    let list = filter === 'urgent'
      ? enriched.filter(s => s.status === 'risk' || s.status === 'caution')
      : [...enriched];
    list.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (av == null) av = sortDir === 'asc' ? Infinity : -Infinity;
      if (bv == null) bv = sortDir === 'asc' ? Infinity : -Infinity;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv, 'ja') : bv.localeCompare(av, 'ja');
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }, [enriched, filter, sortKey, sortDir]);

  // 表示中の稼働銘柄のみのMAPE（フィルター + 非稼働除外 に連動）
  const displayedMape = useMemo(() => {
    const active = displayed.filter(m => !inactiveSku.has(m.sku) && m.mapePct != null);
    if (!active.length) return null;
    return Math.round(active.reduce((s, m) => s + m.mapePct, 0) / active.length);
  }, [displayed, inactiveSku]);

  const inactiveCount = inactiveSku.size;
  const activeCountInDisplayed = displayed.filter(m => !inactiveSku.has(m.sku)).length;

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

  const handleUploadFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setUploadMsg('⚠ xlsx ファイルのみ対応しています');
      return;
    }
    setUploading(true);
    setUploadMsg('アップロード中...');
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'アップロード失敗');
      }
      const data = await res.json();
      setUploadMsg(`✓ ${data.filename} を受信しました。「予測を再実行」ボタンで反映してください。`);
    } catch (err) {
      setUploadMsg(`エラー: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  const thProps = { curKey: sortKey, curDir: sortDir, onClick: handleSort };
  const mDate = (typeof fmtYM === 'function' && typeof MEETING_DATE !== 'undefined') ? fmtYM(MEETING_DATE) : '—';

  // ── MAPE KPIカードの動的ラベル・値（フィルター + 非稼働に連動） ──
  const mapeKpiLabel = filter === 'urgent'
    ? `要対応MAPE（${displayed.length}銘柄）`
    : inactiveCount > 0
      ? `稼働MAPE（真の予測精度）`
      : '予測精度 (MAPE)';
  const mapeKpiValue = fmtMape(displayedMape);
  const mapeKpiUnit = filter === 'urgent'
    ? `要対応銘柄の平均 ／ 全体: ${fmtMape(globalMape)}`
    : inactiveCount > 0
      ? `稼働${activeCountInDisplayed}銘柄 ／ 非稼働${inactiveCount}銘柄除外`
      : `全${enriched.length}銘柄の平均`;
  const mapeKpiColor = mapeColor(displayedMape);

  // ── KPIカードデータ ──
  const kpiCards = selectedMaterial ? [
    { label: '現在庫', value: fmt(selectedMaterial.current) + ' kg', unit: selectedMaterial.isStockSynthesized ? '（推定値）' : '', color: '#0f172a' },
    { label: '残日数', value: daysToText(selectedMaterial.daysLeft), unit: `月間消費 ${fmt(selectedMaterial.monthly)} kg`, color: selectedMaterial.status === 'risk' ? '#dc2626' : selectedMaterial.status === 'caution' ? '#b45309' : '#15803d' },
    { label: `推奨発注量（${orderMonths}か月）`, value: fmt(selectedMaterial.orderSum) + ' kg', unit: `MAPE参考: ${fmtMape(displayedMape)}`, color: '#0f172a' },
  ] : [
    { label: '総予測重量', value: fmt(summary.total_forecast_kg), unit: `kg ／ ${months.length}か月`, color: '#0f172a' },
    { label: mapeKpiLabel, value: mapeKpiValue, unit: mapeKpiUnit, color: mapeKpiColor },
    { label: '要対応', value: `${urgentCount + cautionCount}件`, unit: `危険 ${urgentCount}件 ／ 注意 ${cautionCount}件`, color: urgentCount > 0 ? '#dc2626' : cautionCount > 0 ? '#b45309' : '#15803d' },
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
          <label style={{
            background: uploading ? '#334155' : '#059669', color: '#fff',
            borderRadius: 8, padding: '0 14px', fontWeight: 700, fontSize: 13,
            cursor: uploading ? 'not-allowed' : 'pointer',
            userSelect: 'none', minHeight: 44, display: 'flex', alignItems: 'center',
          }}>
            <input type="file" accept=".xlsx" onChange={handleUploadFile}
              style={{ display: 'none' }} disabled={uploading} />
            {uploading ? '送信中…' : '📤 Excel更新'}
          </label>
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
      {uploadMsg && (
        <div style={{
          background: uploadMsg.startsWith('エラー') ? '#fee2e2' : '#f0fdf4',
          padding: '6px 20px', fontSize: 12,
          color: uploadMsg.startsWith('エラー') ? '#dc2626' : '#15803d',
          borderBottom: '1px solid #bbf7d0',
          display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1 }}>{uploadMsg}</span>
          <button onClick={() => setUploadMsg('')} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'inherit', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>✕</button>
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
            {filter === 'urgent' ? '要対応MAPE' : inactiveCount > 0 ? '稼働MAPE' : 'MAPE'}
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
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>グラフ表示月数</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
              {[1, 3, 6, 12].map(n => (
                <button key={n} onClick={() => setFMonths(n)} style={{
                  padding: '7px 0', fontSize: 13, fontWeight: 600,
                  background: fMonths === n ? '#0f172a' : '#f1f5f9',
                  color: fMonths === n ? '#fff' : '#475569',
                  border: 'none', borderRadius: 6, cursor: 'pointer', minHeight: 40,
                }}>{n}か月</button>
              ))}
            </div>
          </div>

          {/* 推奨発注計算期間（スライダー: 1〜6か月） */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
              発注計算期間
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <input
                type="range" min="1" max="6" step="1" value={orderMonths}
                onChange={e => setOrderMonths(Number(e.target.value))}
                style={{ flex: 1, accentColor: '#0ea5e9', cursor: 'pointer' }}
              />
              <span style={{
                minWidth: 36, textAlign: 'center', fontSize: 14, fontWeight: 700,
                color: '#0f172a', background: '#f1f5f9', borderRadius: 6,
                padding: '3px 6px',
              }}>{orderMonths}か月</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8' }}>
              <span>1か月</span><span>6か月</span>
            </div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
              推奨発注量・KPIカードに即時反映
            </div>
          </div>

          {/* アラート閾値 */}
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>アラート閾値</div>
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
              { key: 'urgent', label: `要対応 (${urgentCount + cautionCount}件)` },
            ].map(({ key, label }) => (
              <button key={key} onClick={() => setFilter(key)} style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '7px 10px', marginBottom: 4, fontSize: 12,
                fontWeight: filter === key ? 700 : 500,
                background: filter === key ? '#f1f5f9' : 'transparent',
                color: filter === key ? '#0f172a' : '#64748b',
                border: 'none', borderRadius: 6, cursor: 'pointer', minHeight: 40,
              }}>{label}</button>
            ))}
            {/* フィルター別MAPE速報 */}
            <div style={{ background: '#f8fafc', borderRadius: 6, padding: '6px 10px', border: '1px solid #e2e8f0', marginTop: 4 }}>
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>
                {filter === 'urgent' ? '要対応銘柄MAPE' : '表示中MAPE'}
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
                {filter === 'urgent' ? '要対応' : '全体'}MAPE: {fmtMape(displayedMape)}
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
                      {filter === 'urgent' ? '要対応' : '全体'}MAPE: <b style={{ color: mapeColor(displayedMape) }}>{fmtMape(displayedMape)}</b>
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
                <SkuForecastChart material={selectedMaterial} months={months} mape_pct={displayedMape || globalMape} ships={SHIPS}/>
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 10 }}>月次予測推移（使用量 kg）</div>
                <ForecastChart series={series} months={months} skus={rawSkus} mape_pct={displayedMape || globalMape} ships={SHIPS}/>
              </>
            )}
          </div>

          {/* 材料一覧テーブル */}
          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                {filter === 'urgent' ? '要対応銘柄 一覧' : '全材料在庫一覧'}
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
                    <ThSort label={`発注推奨 (${orderMonths}か月・kg)`} sortKey="orderSum" textAlign="right" {...thProps}/>
                    <ThSort label="MAPE" sortKey="mapePct" textAlign="center" {...thProps}/>
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
                    return (
                      <tr key={m.sku} style={{
                        background: isSel ? '#f0f9ff' : i % 2 === 0 ? '#fff' : '#fafafa',
                        borderBottom: '1px solid #f1f5f9',
                        outline: isSel ? '2px solid #0ea5e9' : 'none',
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
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#0f172a' }}>{fmt(m.orderSum)}</td>
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
