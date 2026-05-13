/* 溶材会議アプリ — 在庫ダッシュボード v2
   外部DB不要: 全データは window.FORECAST_DATA (サーバーのExcel→JSON変換結果) を参照。
   計算結果はサーバーメモリ + output/ のExcelファイルに保持。Supabase等は不使用。 */

const useCallback = React.useCallback;

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

const STATUS_RANK = { risk: 0, caution: 1, safe: 2, excess: 3 };
const ST = {
  risk:    { label: '危険', bg: '#fee2e2', color: '#dc2626', dot: '#ef4444' },
  caution: { label: '注意', bg: '#fef9c3', color: '#a16207', dot: '#eab308' },
  safe:    { label: '適正', bg: '#dcfce7', color: '#15803d', dot: '#22c55e' },
  excess:  { label: '過剰', bg: '#dbeafe', color: '#1d4ed8', dot: '#3b82f6' },
};

function computeStatus(m, dT, cT) {
  const d = m.daysLeft != null ? m.daysLeft : 999;
  if (d <= 0 || d < dT) return 'risk';
  if (d < cT) return 'caution';
  if (m.currentEval != null && m.currentEval >= 5) return 'excess';
  return 'safe';
}

const ORDER_CYCLE = ['未発注', '発注済', '保留'];
const ORD_STYLE = {
  '未発注': { bg: '#f1f5f9', color: '#475569' },
  '発注済': { bg: '#dcfce7', color: '#15803d' },
  '保留':   { bg: '#fef9c3', color: '#a16207' },
};

function ForecastChart({ series, months, skus }) {
  const W = 900, H = 200, PL = 68, PR = 20, PT = 16, PB = 40;
  const iW = W - PL - PR, iH = H - PT - PB;

  const fcPts = useMemo(() => months.map((ym, i) => ({
    ym, val: (skus || []).reduce((s, sk) => s + (sk.monthly_forecast[i] || 0), 0),
  })), [months, skus]);

  const acPts = useMemo(() =>
    (series || []).filter(s => s.actual != null).map(s => ({ ym: s.ym, val: s.actual })),
    [series]);

  const allVals = [...fcPts.map(p => p.val), ...acPts.map(p => p.val)];
  if (!allVals.length) return <div style={{ color: '#94a3b8', padding: 24, textAlign: 'center' }}>データなし</div>;

  const maxV = Math.max(...allVals, 1);
  const allYms = [...acPts.map(p => p.ym), ...fcPts.map(p => p.ym)].sort();
  const yIdx = {};
  allYms.forEach((ym, i) => { yIdx[ym] = i; });
  const total = allYms.length;
  if (total < 2) return null;

  const sx = (ym) => PL + (yIdx[ym] / (total - 1)) * iW;
  const sy = (v) => PT + (1 - v / maxV) * iH;
  const fmtK = (v) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v/1e3)}K` : `${Math.round(v)}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ v: t * maxV, y: PT + (1-t) * iH }));
  const fcPoly = fcPts.map(p => `${sx(p.ym)},${sy(p.val)}`).join(' ');
  const acPoly = acPts.length > 1 ? acPts.map(p => `${sx(p.ym)},${sy(p.val)}`).join(' ') : '';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={PL} y1={t.y} x2={W-PR} y2={t.y} stroke="#f1f5f9" strokeWidth={1}/>
          <text x={PL-6} y={t.y+4} textAnchor="end" fontSize={10} fill="#94a3b8">{fmtK(t.v)}</text>
        </g>
      ))}
      {acPoly && <>
        <polyline points={acPoly} fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2"/>
        {acPts.map((p,i) => <circle key={i} cx={sx(p.ym)} cy={sy(p.val)} r={2.5} fill="#94a3b8"/>)}
      </>}
      {fcPts.length > 1 && <>
        <polygon points={`${sx(fcPts[0].ym)},${PT+iH} ${fcPoly} ${sx(fcPts[fcPts.length-1].ym)},${PT+iH}`}
          fill="#0ea5e9" fillOpacity={0.08}/>
        <polyline points={fcPoly} fill="none" stroke="#0ea5e9" strokeWidth={2} strokeLinejoin="round"/>
        {fcPts.map((p,i) => <circle key={i} cx={sx(p.ym)} cy={sy(p.val)} r={3} fill="#0ea5e9"/>)}
      </>}
      {allYms.filter((_,i) => i%3===0 || i===allYms.length-1).map(ym => (
        <text key={ym} x={sx(ym)} y={H-8} textAnchor="middle" fontSize={9} fill="#94a3b8">
          {ym.replace('-','/')}
        </text>
      ))}
      <line x1={PL} y1={PT} x2={PL} y2={PT+iH} stroke="#e2e8f0" strokeWidth={1}/>
      <line x1={PL} y1={PT+iH} x2={W-PR} y2={PT+iH} stroke="#e2e8f0" strokeWidth={1}/>
      <circle cx={PL+12} cy={PT-5} r={3} fill="#0ea5e9"/>
      <text x={PL+18} y={PT-2} fontSize={9} fill="#64748b">予測</text>
      {acPoly && <>
        <line x1={PL+48} y1={PT-5} x2={PL+60} y2={PT-5} stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="3 2"/>
        <text x={PL+63} y={PT-2} fontSize={9} fill="#64748b">実績</text>
      </>}
    </svg>
  );
}

function ThSort({ label, sortKey, curKey, curDir, onClick }) {
  const active = sortKey === curKey;
  return (
    <th onClick={() => onClick(sortKey)} style={{
      padding: '9px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600,
      color: active ? '#0f172a' : '#64748b', cursor: 'pointer', userSelect: 'none',
      whiteSpace: 'nowrap', borderBottom: '2px solid #e2e8f0',
      background: active ? '#f1f5f9' : '#fafafa', position: 'sticky', top: 0, zIndex: 2,
    }}>
      {label} <span style={{ opacity: active?1:0.4 }}>{active?(curDir==='asc'?'▲':'▼'):'↕'}</span>
    </th>
  );
}

function VariantA() {
  const fd = window.FORECAST_DATA || {};
  const months = (window.FORECAST_PERIOD || {}).months || [];
  const summary = fd.summary || {};
  const rawSkus = fd.skus || [];
  const series = fd.series || [];

  const [fMonths, setFMonths] = useState(3);
  const [dangerT, setDangerT] = useState(15);
  const [cautionT, setCautionT] = useState(35);
  const [orderStatus, setOrderStatus] = useState({});
  const [sortKey, setSortKey] = useState('statusRank');
  const [sortDir, setSortDir] = useState('asc');
  const [filter, setFilter] = useState('all');
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');

  const enriched = useMemo(() => MATERIALS.map(m => {
    const status = computeStatus(m, dangerT, cautionT);
    const orderSum = Math.round((m.monthlyOrderArr||[]).slice(0,fMonths).reduce((s,v)=>s+(v||0),0));
    return { ...m, status, statusRank: STATUS_RANK[status], orderSum };
  }), [dangerT, cautionT, fMonths]);

  const urgentCount = useMemo(() => enriched.filter(s=>s.status==='risk').length, [enriched]);
  const cautionCount = useMemo(() => enriched.filter(s=>s.status==='caution').length, [enriched]);

  const displayed = useMemo(() => {
    let list = filter==='urgent'
      ? enriched.filter(s=>s.status==='risk'||s.status==='caution')
      : [...enriched];
    list.sort((a,b) => {
      let av=a[sortKey], bv=b[sortKey];
      if(av==null) av=sortDir==='asc'?Infinity:-Infinity;
      if(bv==null) bv=sortDir==='asc'?Infinity:-Infinity;
      if(typeof av==='string') return sortDir==='asc'?av.localeCompare(bv,'ja'):bv.localeCompare(av,'ja');
      return sortDir==='asc'?av-bv:bv-av;
    });
    return list;
  }, [enriched, filter, sortKey, sortDir]);

  const handleSort = useCallback((key) => {
    setSortKey(prev => {
      if(prev===key){ setSortDir(d=>d==='asc'?'desc':'asc'); return prev; }
      setSortDir('asc'); return key;
    });
  }, []);

  const cycleOrder = useCallback((sku) => {
    setOrderStatus(prev => {
      const cur=prev[sku]||'未発注';
      const next=ORDER_CYCLE[(ORDER_CYCLE.indexOf(cur)+1)%ORDER_CYCLE.length];
      return {...prev,[sku]:next};
    });
  }, []);

  const handleRerun = async () => {
    setRunning(true);
    setRunMsg('予測計算を開始しました。完了後にページを再読み込みしてください（1〜3分）。');
    try { await fetch('/api/run',{method:'POST'}); }
    catch(_) { setRunMsg('エラーが発生しました。'); }
    setRunning(false);
  };

  const thProps = { curKey: sortKey, curDir: sortDir, onClick: handleSort };
  const mDate = (typeof fmtYM==='function' && typeof MEETING_DATE!=='undefined') ? fmtYM(MEETING_DATE) : '—';

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', background:'#f1f5f9', overflow:'hidden' }}>

      <header style={{ background:'#0f172a', color:'#fff', padding:'10px 20px',
        display:'flex', alignItems:'center', justifyContent:'space-between',
        boxShadow:'0 2px 8px rgba(0,0,0,.3)', flexShrink:0 }}>
        <div style={{ fontSize:18, fontWeight:700 }}>🔧 在庫ダッシュボード</div>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <div style={{ fontSize:21, fontWeight:700, color:'#93c5fd' }}>溶材会議日：{mDate}</div>
          <button onClick={handleRerun} disabled={running} style={{
            background:running?'#334155':'#0ea5e9', color:'#fff', border:'none',
            borderRadius:8, padding:'8px 18px', fontWeight:700, fontSize:13,
            cursor:running?'not-allowed':'pointer' }}>
            {running?'計算中…':'▶ 予測を再実行'}
          </button>
        </div>
      </header>

      {runMsg && (
        <div style={{ background:'#eff6ff', padding:'6px 20px', fontSize:12, color:'#1d4ed8', borderBottom:'1px solid #bfdbfe', flexShrink:0 }}>
          {runMsg}
        </div>
      )}

      <div style={{ background:'#fff', borderBottom:'1px solid #e2e8f0',
        padding:'5px 20px', fontSize:11, color:'#64748b',
        display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
        <span>予測期間 {fd.period_start} 〜 {fd.period_end} ／ 生成: {fd.generated_at}</span>
        <span style={{ fontWeight:600, color:'#334155' }}>
          総予測 {fmt(summary.total_forecast_kg)} kg ｜ MAPE {summary.mape_constrained!=null?summary.mape_constrained+'%':'—'} ｜ 警告 {summary.warnings??'—'} 件
        </span>
      </div>

      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

        <aside style={{ width:210, flexShrink:0, background:'#fff', borderRight:'1px solid #e2e8f0',
          padding:'16px 14px', display:'flex', flexDirection:'column', gap:22, overflowY:'auto' }}>

          <div>
            <div style={{ fontSize:10, fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>予測表示月数</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
              {[1,3,6,12].map(n => (
                <button key={n} onClick={()=>setFMonths(n)} style={{
                  padding:'7px 0', fontSize:13, fontWeight:600,
                  background:fMonths===n?'#0f172a':'#f1f5f9',
                  color:fMonths===n?'#fff':'#475569',
                  border:'none', borderRadius:6, cursor:'pointer' }}>{n}か月</button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize:10, fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>アラート閾値</div>
            {[
              { label:'危険', color:'#dc2626', val:dangerT, set:setDangerT },
              { label:'注意', color:'#eab308', val:cautionT, set:setCautionT },
            ].map(({label,color,val,set}) => (
              <div key={label} style={{ marginBottom:10 }}>
                <div style={{ fontSize:12, fontWeight:600, color, marginBottom:4 }}>● {label}</div>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <input type="number" value={val} min={1} max={360}
                    onChange={e=>set(Math.max(1,Number(e.target.value)))}
                    style={{ width:56, padding:'4px 6px', borderRadius:6, border:'1px solid #cbd5e1', fontSize:12, textAlign:'right' }}/>
                  <span style={{ fontSize:11, color:'#64748b' }}>日以下</span>
                </div>
              </div>
            ))}
          </div>

          <div>
            <div style={{ fontSize:10, fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>絞り込み</div>
            {[
              { key:'all', label:`全銘柄 (${enriched.length}件)` },
              { key:'urgent', label:`要対応 (${urgentCount+cautionCount}件)` },
            ].map(({key,label}) => (
              <button key={key} onClick={()=>setFilter(key)} style={{
                display:'block', width:'100%', textAlign:'left',
                padding:'7px 10px', marginBottom:4, fontSize:12,
                fontWeight:filter===key?700:500,
                background:filter===key?'#f1f5f9':'transparent',
                color:filter===key?'#0f172a':'#64748b',
                border:'none', borderRadius:6, cursor:'pointer' }}>{label}</button>
            ))}
          </div>

        </aside>

        <main style={{ flex:1, padding:16, overflowY:'auto', display:'flex', flexDirection:'column', gap:14 }}>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
            {[
              { label:'総予測重量', value:fmt(summary.total_forecast_kg), unit:`kg ／ ${months.length}か月`, color:'#0f172a' },
              { label:'前回比', value:'—', unit:'初回実行のため比較データなし', color:'#94a3b8' },
              { label:'予測精度（MAPE）',
                value:summary.mape_constrained!=null?summary.mape_constrained+'%':'—',
                unit:`要対応 ${urgentCount}件（危険）／ ${cautionCount}件（注意）`,
                color:summary.mape_constrained!=null&&summary.mape_constrained<80?'#15803d':'#b45309' },
            ].map(({label,value,unit,color}) => (
              <div key={label} style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:12, padding:'14px 18px' }}>
                <div style={{ fontSize:11, color:'#64748b', fontWeight:500, marginBottom:6 }}>{label}</div>
                <div style={{ fontSize:34, fontWeight:800, color, lineHeight:1 }}>{value}</div>
                <div style={{ fontSize:11, color:'#94a3b8', marginTop:4 }}>{unit}</div>
              </div>
            ))}
          </div>

          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:12, padding:'14px 16px' }}>
            <div style={{ fontSize:13, fontWeight:700, color:'#0f172a', marginBottom:10 }}>月次予測推移（使用量 kg）</div>
            <ForecastChart series={series} months={months} skus={rawSkus}/>
          </div>

          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:12, overflow:'hidden' }}>
            <div style={{ padding:'12px 16px', borderBottom:'1px solid #e2e8f0',
              display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ fontSize:14, fontWeight:700, color:'#0f172a' }}>
                全材料在庫一覧
                <span style={{ fontSize:12, color:'#64748b', fontWeight:400, marginLeft:8 }}>{displayed.length}銘柄</span>
              </div>
              <div style={{ fontSize:11, color:'#94a3b8' }}>列ヘッダーをクリックしてソート</div>
            </div>

            <div style={{ overflowX:'auto', maxHeight:480, overflowY:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr>
                    <ThSort label="現在庫状態" sortKey="statusRank" {...thProps}/>
                    <ThSort label="材料名" sortKey="code" {...thProps}/>
                    <ThSort label="現在在庫 (kg)" sortKey="current" {...thProps}/>
                    <ThSort label="残日数" sortKey="daysLeft" {...thProps}/>
                    <ThSort label="月間消費 (kg)" sortKey="monthly" {...thProps}/>
                    <ThSort label={`推奨発注量 (${fMonths}か月・kg)`} sortKey="orderSum" {...thProps}/>
                    <th style={{ padding:'9px 10px', fontSize:11, fontWeight:600, color:'#64748b',
                      borderBottom:'2px solid #e2e8f0', background:'#fafafa',
                      whiteSpace:'nowrap', position:'sticky', top:0, zIndex:2 }}>発注状況</th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((m,i) => {
                    const st=ST[m.status];
                    const ord=orderStatus[m.sku]||'未発注';
                    const os=ORD_STYLE[ord];
                    const bc=barColor(m.daysLeft,dangerT,cautionT);
                    const pct=Math.min(100,Math.max(0,((m.daysLeft||0)/(cautionT*2))*100));
                    return (
                      <tr key={m.sku} style={{ background:i%2===0?'#fff':'#fafafa', borderBottom:'1px solid #f1f5f9' }}>
                        <td style={{ padding:'8px 10px' }}>
                          <span style={{ display:'inline-flex', alignItems:'center', gap:5,
                            background:st.bg, color:st.color,
                            borderRadius:999, padding:'2px 9px', fontSize:11, fontWeight:600 }}>
                            <span style={{ width:6, height:6, borderRadius:'50%', background:st.dot }}/>
                            {st.label}
                          </span>
                        </td>
                        <td style={{ padding:'8px 10px', fontWeight:500, color:'#0f172a', whiteSpace:'nowrap' }}>{m.code}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', color:m.isStockSynthesized?'#94a3b8':'#0f172a' }}>
                          {fmt(m.current)}
                          {m.isStockSynthesized&&<span style={{ fontSize:9, color:'#b0bec5', marginLeft:3 }}>推定</span>}
                        </td>
                        <td style={{ padding:'8px 10px', minWidth:130 }}>
                          <div style={{ fontSize:11, color:'#334155', marginBottom:3, fontWeight:500 }}>{daysToText(m.daysLeft)}</div>
                          <div style={{ height:5, borderRadius:3, background:'#f1f5f9', overflow:'hidden' }}>
                            <div style={{ width:`${pct}%`, height:'100%', background:bc, borderRadius:3 }}/>
                          </div>
                        </td>
                        <td style={{ padding:'8px 10px', textAlign:'right', color:'#334155' }}>{fmt(m.monthly)}</td>
                        <td style={{ padding:'8px 10px', textAlign:'right', fontWeight:700, color:'#0f172a' }}>{fmt(m.orderSum)}</td>
                        <td style={{ padding:'8px 10px' }}>
                          <button onClick={()=>cycleOrder(m.sku)} style={{
                            padding:'3px 12px', borderRadius:999, fontSize:11, fontWeight:600,
                            cursor:'pointer', border:'none', background:os.bg, color:os.color, minWidth:56 }}>
                            {ord}
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
