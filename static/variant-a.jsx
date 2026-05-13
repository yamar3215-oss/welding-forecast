/* Variant A — 現行リファイン
   現行のレイアウトを踏襲しつつ、ミーティング指摘事項を反映:
   - ヘッダーに溶材会議日 + 予測月数セグメント
   - 選択銘柄を大きめに、切替えボタン
   - 船表は鍵アイコンで展開
   - 残日数バー、印刷/PDF、発注確認モーダル
*/

function VariantA() {
  const [monthsAhead, setMonthsAhead] = useState(3);
  const [danger, setDanger] = useState(15);
  const [caution, setCaution] = useState(35);

  // 閾値に応じて status を動的注入した materials
  const materials = useMemo(
    () => MATERIALS.map(m => ({ ...m, status: computeStatus(m, danger, caution) })),
    [danger, caution]
  );
  const needOrderCount = useMemo(
    () => materials.filter(m => m.status === 'risk').length,
    [materials]
  );

  // 最重要管理銘柄: ステンレス系優先、足りなければ予測量上位を補完
  const stainless = useMemo(() => {
    const ss = materials.filter(m => m.cat === 'stainless' && m.priority === '最重要');
    if (ss.length >= 4) return ss.slice(0, 12);
    return materials.slice(0, 8);
  }, [materials]);
  const [focusIdx, setFocusIdx] = useState(0);
  const focus = stainless[focusIdx] || materials[0];

  const [orderTarget, setOrderTarget] = useState(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [showOnlyAlerts, setShowOnlyAlerts] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [running, setRunning] = useState(false);

  const rerunPipeline = async () => {
    setRunning(true);
    try {
      const res = await fetch('/api/run', { method: 'POST' });
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).detail || ''; } catch (_) { msg = await res.text(); }
        throw new Error(msg || res.statusText);
      }
      location.reload();
    } catch (e) {
      alert('予測実行に失敗: ' + (e.message || String(e)));
      setRunning(false);
    }
  };

  const forecastDate = addMonths(MEETING_DATE, monthsAhead);
  const listed = materials.filter(m => !showOnlyAlerts || (m.status === 'risk' || m.status === 'caution'));

  return (
    <div style={{
      width: '100%', height: '100%', background: '#f8fafc',
      fontFamily: '"Hiragino Sans", "Yu Gothic", "Noto Sans JP", system-ui, sans-serif',
      color: '#0f172a', padding: 28, boxSizing: 'border-box',
      overflow: 'auto', position: 'relative',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>在庫ダッシュボード</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#ffffff', border: '1px solid #e2e8f0',
            borderRadius: 8, padding: '6px 12px',
          }}>
            <span style={{ fontSize: 11, color: '#64748b' }}>溶材会議日</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{fmtYM(MEETING_DATE)}</span>
          </div>
          <ForecastSegment value={monthsAhead} onChange={setMonthsAhead} />
          <div style={{ fontSize: 11, color: '#64748b' }}>
            → 予測: <strong style={{ color: '#0f172a' }}>{fmtYMSlash(forecastDate)}</strong>
          </div>
          <Btn kind="primary" size="sm" disabled={running} onClick={rerunPipeline}>
            {running ? '⏳ 実行中…' : '🔄 予測を再実行'}
          </Btn>
          <Btn kind="default" size="sm" onClick={() => setPrintOpen(true)}>🖨 印刷</Btn>
        </div>
      </div>

      {/* データ出所 */}
      <div style={{
        background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8,
        padding: '8px 14px', marginBottom: 14, fontSize: 11, color: '#475569',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      }}>
        <div>
          🧮 入力データ: 溶接棒在庫管理表　在庫評価追加_RES.xlsx
          <span style={{ color: '#94a3b8', marginLeft: 8 }}>
            予測期間 {STATS.periodStart} 〜 {STATS.periodEnd} ／ 生成 {STATS.generatedAt || '—'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          <span>総予測 <strong style={{ color: '#0f172a' }}>{STATS.totalForecastKg ? STATS.totalForecastKg.toLocaleString() : '—'} kg</strong></span>
          <span>MAPE <strong style={{ color: '#0f172a' }}>{STATS.mape != null ? STATS.mape + '%' : '—'}</strong></span>
          <span>在庫評価一致率 <strong style={{ color: '#0f172a' }}>{STATS.evalMatch != null ? STATS.evalMatch + '%' : '—'}</strong></span>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        <KpiCard label="管理SKU数" value={STATS.total} unit="銘柄" sub="実データ取込み済み" />
        <KpiCard label="要発注銘柄" value={needOrderCount} unit="銘柄" sub={`残日数<${danger}日`} tone="danger" highlight />
        <KpiCard label="ケミカル船稼働" value={STATS.ships} unit={`隻 (建造中 全${STATS.shipsTotal}隻)`} tone="info" />
        <KpiCard label="予測総使用量" value={STATS.totalForecastKg ? (STATS.totalForecastKg / 1000).toFixed(0) : '—'} unit="t / 12ヶ月" tone="muted" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 14, marginBottom: 18 }}>
        {/* Hero: 選択銘柄 */}
        <div style={{
          background: '#ffffff', border: '1px solid #fecaca',
          borderRadius: 12, padding: 20,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#dc2626' }} />
              <div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#dc2626' }}>
                  {CATEGORIES[focus.cat].label}（最重要管理）
                </div>
                <div style={{ fontSize: 12, color: '#dc2626' }}>
                  在庫切れ厳禁・リードタイム{focus.lead}日・将来予測・推奨発注量表示
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Btn size="sm" onClick={() => setFocusIdx((focusIdx - 1 + stainless.length) % stainless.length)}>‹ 前</Btn>
              <div style={{ fontSize: 11, color: '#64748b', minWidth: 50, textAlign: 'center' }}>
                {focusIdx + 1} / {stainless.length}
              </div>
              <Btn size="sm" onClick={() => setFocusIdx((focusIdx + 1) % stainless.length)}>次 ›</Btn>
            </div>
          </div>

          {/* Selected hero card */}
          <FocusCard material={focus} monthsAhead={monthsAhead} forecastDate={forecastDate} onOrder={setOrderTarget} large />

          {/* Sibling cards (smaller) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 14 }}>
            {stainless.filter((_, i) => i !== focusIdx).slice(0, 3).map((m, i) => (
              <button key={m.code} onClick={() => setFocusIdx(stainless.findIndex(x => x.code === m.code))}
                style={{
                  textAlign: 'left', cursor: 'pointer', border: '1px solid #e2e8f0',
                  borderRadius: 8, padding: 12, background: '#ffffff',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'ui-monospace, Menlo, monospace' }}>{m.code}</div>
                  <StatusBadge status={m.status} size="sm" />
                </div>
                <div style={{ fontSize: 11, color: '#64748b' }}>現在 {m.current} kg</div>
                <div style={{ marginTop: 6 }}>
                  <HBar value={Math.round(m.current / m.monthly * 30)} max={Math.max(180, monthsAhead * 30)} color="#94a3b8" />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Sidebar: alerts + ship */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Overdue alert */}
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
            padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#b91c1c', marginBottom: 4 }}>
              ⚠ 発注期限が過ぎています！
            </div>
            <div style={{ fontSize: 11, color: '#7f1d1d', lineHeight: 1.6 }}>
              s6278 搭載開始（2025-06-27）の6ヶ月前：<br/>
              <strong>2024年12月27日</strong>
            </div>
          </div>

          <ShipPanel />

          <div style={{
            background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>⚙ アラート閾値</div>
            <ThresholdSliders danger={danger} caution={caution} setDanger={setDanger} setCaution={setCaution} />
          </div>
        </div>
      </div>

      {/* Inventory list */}
      <div style={{
        background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 18,
      }}>
        <SectionTitle
          title="全材料 在庫一覧"
          sub={`${STATS.total} 銘柄管理中  ⚠ ${needOrderCount} 銘柄が要対応`}
          right={
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn size="sm" kind={showOnlyAlerts ? 'primary' : 'default'} onClick={() => setShowOnlyAlerts(s => !s)}>
                🔴🟡 要対応のみ ({needOrderCount}件)
              </Btn>
              <Btn size="sm" onClick={() => setShowInactive(s => !s)}>
                {showInactive ? '✓' : '◯'} 非アクティブも表示
              </Btn>
            </div>
          }
        />
        <div style={{
          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8,
          padding: '8px 12px', fontSize: 11, color: '#1e3a8a', marginBottom: 12,
        }}>
          ⓘ 不要マークした材料は発注アラートから除外されます。材料カードの[不要にする]ボタンで切替可能
        </div>
        <InventoryTable rows={listed} onFocus={(m) => {
          const idx = stainless.findIndex(x => x.code === m.code);
          if (idx >= 0) setFocusIdx(idx);
        }} onOrder={setOrderTarget} monthsAhead={monthsAhead} />
      </div>

      {/* Order modal */}
      <Modal open={!!orderTarget} onClose={() => setOrderTarget(null)} title="発注依頼の確認（デモ）"
        footer={<>
          <Btn onClick={() => setOrderTarget(null)}>キャンセル</Btn>
          <Btn kind="primary" onClick={() => setOrderTarget(null)}>発注依頼を送信</Btn>
        </>}>
        {orderTarget && (
          <div>
            <div style={{ fontSize: 13, marginBottom: 14, color: '#64748b' }}>
              以下の内容で発注を作成します。<br/>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>※ 現バージョンはダミー。本番では現行発注フローに連携します。</span>
            </div>
            <div style={{
              background: '#f8fafc', borderRadius: 8, padding: 14,
              display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 14px', fontSize: 13,
            }}>
              <div style={{ color: '#64748b' }}>銘柄</div>
              <div style={{ fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace' }}>{orderTarget.code}</div>
              <div style={{ color: '#64748b' }}>カテゴリ</div>
              <div>{CATEGORIES[orderTarget.cat].label}</div>
              <div style={{ color: '#64748b' }}>現在在庫</div>
              <div>{orderTarget.current} kg</div>
              <div style={{ color: '#64748b' }}>推奨発注量</div>
              <div style={{ fontWeight: 700, color: '#0ea5e9' }}>{recommendOrder(orderTarget, monthsAhead)} kg</div>
              {(() => {
                const c = confirmedOrder(orderTarget, monthsAhead);
                return c.hasAny ? (
                  <>
                    <div style={{ color: '#64748b' }}>発注済（確定）</div>
                    <div style={{ fontWeight: 700, color: '#0f172a' }}>{c.sum.toLocaleString()} kg</div>
                  </>
                ) : null;
              })()}
              <div style={{ color: '#64748b' }}>予測基準</div>
              <div>{fmtYM(MEETING_DATE)} → {monthsAhead}か月先（{fmtYMSlash(forecastDate)}）</div>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={printOpen} onClose={() => setPrintOpen(false)} title="印刷プレビュー / PDF出力" width={560}
        footer={<>
          <Btn onClick={() => setPrintOpen(false)}>閉じる</Btn>
          <Btn kind="primary" onClick={() => setPrintOpen(false)}>PDFを保存</Btn>
        </>}>
        <PrintPreviewBody title="在庫ダッシュボード" monthsAhead={monthsAhead} />
      </Modal>
    </div>
  );
}

// ===== 大きいフォーカスカード =====
function FocusCard({ material, monthsAhead, forecastDate, onOrder, large }) {
  const p = predictStock(material, monthsAhead);
  const p3 = predictStock(material, 3);
  const p6 = predictStock(material, 6);
  const rec = recommendOrder(material, monthsAhead);
  const confirmed = confirmedOrder(material, monthsAhead);
  const meta = STATUS_META[material.status];
  return (
    <div style={{
      border: `1.5px solid ${meta.bg}`, background: '#ffffff',
      borderRadius: 12, padding: 18,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: large ? 26 : 18, fontWeight: 700, fontFamily: 'ui-monospace, Menlo, monospace', letterSpacing: -.3 }}>
            {material.code}
          </div>
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
            {material.shape} ・ {material.spool} ・ 月消費 {material.monthly} kg ・ リードタイム {material.lead}日
          </div>
        </div>
        <StatusBadge status={material.status} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div>
          <div style={{ fontSize: 11, color: '#64748b' }}>
            現在在庫{material.isStockSynthesized && <span style={{ color: '#94a3b8', marginLeft: 6 }}>※在庫マスタ未連携（推定値）</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
            <div style={{
              fontSize: 34, fontWeight: 700, lineHeight: 1,
              color: material.current === 0 ? '#dc2626' : (material.isStockSynthesized ? '#94a3b8' : '#0f172a'),
              fontStyle: material.isStockSynthesized ? 'italic' : 'normal',
            }}>{material.current.toLocaleString()}</div>
            <div style={{ fontSize: 13, color: '#64748b' }}>kg</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 4 }}>残日数（現在庫÷月間消費）</div>
            <HBar value={p.daysLeft} max={Math.max(180, monthsAhead * 30)} color={meta.dot} height={8} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginTop: 4 }}>
              <span><strong style={{ color: '#0f172a' }}>{p.daysLeft}日分</strong></span>
              <span>予測期間 {monthsAhead * 30}日</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ForecastRow label={`${monthsAhead}か月後予測`} sub={fmtYMSlash(forecastDate)} value={p.estimatedKg} level={p.level} />
          <ForecastRow label="3か月後予測" sub={fmtYMSlash(addMonths(MEETING_DATE, 3))} value={p3.estimatedKg} level={p3.level} muted />
          <ForecastRow label="6か月後予測" sub={fmtYMSlash(addMonths(MEETING_DATE, 6))} value={p6.estimatedKg} level={p6.level} muted />
        </div>
      </div>

      <div style={{
        marginTop: 16, padding: 14, background: '#f8fafc', borderRadius: 10,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 11, color: '#64748b' }}>推奨発注量（リード考慮）</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: rec > 0 ? '#0ea5e9' : '#15803d' }}>{rec}</div>
            <div style={{ fontSize: 12, color: '#64748b' }}>kg</div>
            <div style={{ fontSize: 11, color: rec > 0 ? '#0369a1' : '#15803d', marginLeft: 6 }}>
              {rec > 0 ? '要発注' : '充足'}
            </div>
          </div>
          {confirmed.hasAny && (
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span style={{ color: '#94a3b8' }}>発注済（確定）:</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{confirmed.sum.toLocaleString()}</span>
              <span style={{ color: '#94a3b8' }}>kg</span>
            </div>
          )}
        </div>
        <Btn kind="primary" size="md" onClick={() => onOrder(material)}>📦 発注を作成</Btn>
      </div>
    </div>
  );
}

function ForecastRow({ label, sub, value, level, muted }) {
  const lm = LEVEL_META[level];
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 10px', borderRadius: 8,
      background: muted ? '#fafafa' : '#ffffff',
      border: `1px solid ${muted ? '#f1f5f9' : '#e2e8f0'}`,
    }}>
      <div>
        <div style={{ fontSize: 11, color: '#475569', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 10, color: '#94a3b8' }}>{sub}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{value} <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>kg</span></div>
        <div style={{ fontSize: 10, color: lm.color, fontWeight: 600 }}>評価{level}（{lm.label}）</div>
      </div>
    </div>
  );
}

function ThresholdSliders({ danger, caution, setDanger, setCaution }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[
        { label: '危険', val: danger, set: setDanger, color: '#dc2626' },
        { label: '注意', val: caution, set: setCaution, color: '#b45309' },
      ].map(r => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#475569', marginBottom: 4 }}>
            <span style={{ color: r.color, fontWeight: 600 }}>● {r.label}</span>
            <span>残 {r.val} 日以下</span>
          </div>
          <input type="range" min="0" max="90" value={r.val} onChange={e => r.set(+e.target.value)} style={{ width: '100%', accentColor: r.color }} />
        </div>
      ))}
      <div style={{ fontSize: 10, color: '#94a3b8' }}>※ 在庫評価4-5は「過剰」表示／一覧で右に</div>
    </div>
  );
}

function InventoryTable({ rows, onFocus, onOrder, monthsAhead }) {
  return (
    <div>
      <div style={{
        display: 'grid', gridTemplateColumns: '60px 60px 1.6fr 90px 1fr 90px 80px 36px',
        gap: 8, padding: '8px 8px',
        borderBottom: '1px solid #e2e8f0', fontSize: 11, color: '#64748b', fontWeight: 600,
      }}>
        <div>状態</div>
        <div>優先度</div>
        <div>材料名</div>
        <div style={{ textAlign: 'right' }}>現在在庫</div>
        <div>残日数</div>
        <div style={{ textAlign: 'right' }}>月間消費</div>
        <div style={{ textAlign: 'center' }}>発注</div>
        <div></div>
      </div>
      {rows.map(m => {
        const p = predictStock(m, monthsAhead);
        return (
          <div key={m.code} style={{
            display: 'grid', gridTemplateColumns: '60px 60px 1.6fr 90px 1fr 90px 80px 36px',
            gap: 8, padding: '10px 8px',
            borderBottom: '1px solid #f1f5f9', fontSize: 13, alignItems: 'center',
          }}>
            <div><StatusBadge status={m.status} size="sm" /></div>
            <div style={{ fontSize: 11, color: m.priority === '最重要' ? '#dc2626' : '#64748b', fontWeight: 600 }}>{m.priority}</div>
            <div>
              <button onClick={() => onFocus(m)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: '#0f172a',
                padding: 0, textAlign: 'left', textDecoration: 'underline', textDecorationColor: '#cbd5e1',
              }}>{m.code}</button>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{CATEGORIES[m.cat].label} ・ {m.shape}</div>
            </div>
            <div style={{ textAlign: 'right', fontWeight: 600, color: m.isStockSynthesized ? '#94a3b8' : '#0f172a', fontStyle: m.isStockSynthesized ? 'italic' : 'normal' }}
              title={m.isStockSynthesized ? '在庫マスタ未連携のため、パイプライン予測からの逆算値' : undefined}>
              {m.current.toLocaleString()}
              <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}> kg</span>
              {m.isStockSynthesized && <span style={{ fontSize: 10, color: '#cbd5e1', marginLeft: 4 }}>(推定)</span>}
            </div>
            <div>
              <HBar value={p.daysLeft} max={Math.max(180, monthsAhead * 30)} color={STATUS_META[m.status].dot} />
              <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>残 {p.daysLeft} 日分</div>
            </div>
            <div style={{ textAlign: 'right', color: '#64748b' }}>{m.monthly} kg</div>
            <div style={{ textAlign: 'center' }}>
              <Btn size="sm" kind={m.status === 'risk' ? 'accent' : 'default'} onClick={() => onOrder(m)}>
                {STATUS_META[m.status].label}
              </Btn>
            </div>
            <div style={{ textAlign: 'center', color: '#94a3b8', cursor: 'pointer' }}>⋯</div>
          </div>
        );
      })}
    </div>
  );
}

window.VariantA = VariantA;
window.FocusCard = FocusCard;
window.ForecastRow = ForecastRow;
window.ThresholdSliders = ThresholdSliders;
window.InventoryTable = InventoryTable;
