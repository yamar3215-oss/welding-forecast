/* 共通UI部品 — 全バリアントで使用 */

const { useState, useEffect, useMemo, useRef } = React;

// ===== KPI カード =====
function KpiCard({ label, value, unit, sub, tone = 'neutral', highlight }) {
  const tones = {
    neutral: { border: '#e5e7eb', bg: '#ffffff', text: '#0f172a', sub: '#64748b' },
    danger:  { border: '#fecaca', bg: '#fef2f2', text: '#b91c1c', sub: '#b91c1c' },
    info:    { border: '#bfdbfe', bg: '#eff6ff', text: '#1d4ed8', sub: '#1d4ed8' },
    muted:   { border: '#e5e7eb', bg: '#fafafa', text: '#64748b', sub: '#94a3b8' },
  };
  const t = tones[tone];
  return (
    <div style={{
      border: `1px solid ${t.border}`, background: t.bg,
      borderRadius: 10, padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 4,
      outline: highlight ? `2px solid ${t.text}` : 'none', outlineOffset: -1,
    }}>
      <div style={{ fontSize: 12, color: t.sub, fontWeight: 500 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <div style={{ fontSize: 30, fontWeight: 700, color: t.text, lineHeight: 1 }}>{value}</div>
        {unit && <div style={{ fontSize: 13, color: t.sub }}>{unit}</div>}
      </div>
      {sub && <div style={{ fontSize: 11, color: t.sub }}>{sub}</div>}
    </div>
  );
}

// ===== ステータスバッジ =====
function StatusBadge({ status, size = 'md' }) {
  const meta = STATUS_META[status] || STATUS_META.safe;
  const padding = size === 'sm' ? '2px 8px' : '4px 10px';
  const fontSize = size === 'sm' ? 11 : 12;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: meta.bg, color: meta.color,
      borderRadius: 999, padding, fontSize, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.dot }} />
      {meta.label}
    </span>
  );
}

// ===== 横バー（残日数 / 充足率） =====
function HBar({ value, max, color = '#0ea5e9', height = 6, showLabel, unit = '日' }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div>
      <div style={{
        height, borderRadius: height, background: '#f1f5f9', overflow: 'hidden',
      }}>
        <div style={{
          width: `${pct}%`, height: '100%', background: color, borderRadius: height,
          transition: 'width .3s ease',
        }} />
      </div>
      {showLabel && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b', marginTop: 3 }}>
          <span>残り{value}{unit}分</span>
          <span>基準 {max}{unit}</span>
        </div>
      )}
    </div>
  );
}

// ===== 予測月数セグメント =====
function ForecastSegment({ value, onChange, size = 'md' }) {
  const opts = [1, 3, 6, 12];
  const pad = size === 'sm' ? '5px 10px' : '7px 14px';
  const fs = size === 'sm' ? 12 : 13;
  return (
    <div style={{
      display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 3,
      border: '1px solid #e2e8f0',
    }}>
      {opts.map(o => {
        const active = o === value;
        return (
          <button key={o} onClick={() => onChange(o)}
            style={{
              padding: pad, fontSize: fs, fontWeight: 600, lineHeight: 1,
              background: active ? '#ffffff' : 'transparent',
              color: active ? '#0f172a' : '#64748b',
              border: 'none', borderRadius: 6, cursor: 'pointer',
              boxShadow: active ? '0 1px 2px rgba(15,23,42,.08)' : 'none',
            }}>
            {o}か月
          </button>
        );
      })}
    </div>
  );
}

// ===== セクション見出し =====
function SectionTitle({ title, sub, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{sub}</div>}
      </div>
      <div>{right}</div>
    </div>
  );
}

// ===== 船表（鍵アイコン展開） =====
function ShipPanel({ defaultOpen = false, compact }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{
      border: '1px solid #e2e8f0', borderRadius: 10, background: '#ffffff',
      overflow: 'hidden',
    }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', background: open ? '#f8fafc' : '#ffffff',
        border: 'none', cursor: 'pointer',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14 }}>{open ? '🔓' : '🔒'}</span>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
            ケミカル船表 {STATS.ships}隻稼働中
          </div>
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: '#fef3c7', color: '#b45309', fontWeight: 600,
          }}>社外秘</span>
        </div>
        <div style={{ fontSize: 11, color: '#64748b' }}>{open ? '閉じる ▴' : '展開 ▾'}</div>
      </button>
      {open && (
        <div style={{
          maxHeight: compact ? 200 : 280, overflowY: 'auto',
          padding: '6px 10px 10px', fontSize: 11,
          fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
        }}>
          {SHIPS.map(s => (
            <div key={s.id} style={{
              display: 'grid', gridTemplateColumns: '64px 1fr auto auto',
              gap: 8, padding: '3px 4px', alignItems: 'center',
              color: s.overdue ? '#dc2626' : '#334155',
              borderBottom: '1px dashed #f1f5f9',
            }}>
              <span style={{ fontWeight: 600 }}>{s.id}</span>
              <span style={{ color: '#64748b' }}>({s.vessel})</span>
              <span>搭載</span>
              <span>{s.load}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== モーダル =====
function Modal({ open, onClose, title, children, footer, width = 480 }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{
      position: 'absolute', inset: 0, background: 'rgba(15,23,42,.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width, maxHeight: '85%', background: '#ffffff', borderRadius: 12,
        boxShadow: '0 24px 48px rgba(15,23,42,.25)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{title}</div>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8' }}>×</button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>{children}</div>
        {footer && <div style={{ padding: '12px 20px', borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  );
}

// ===== ボタン =====
function Btn({ children, onClick, kind = 'default', size = 'md', style, disabled }) {
  const kinds = {
    primary: { bg: '#0f172a', color: '#ffffff', border: '#0f172a' },
    default: { bg: '#ffffff', color: '#0f172a', border: '#cbd5e1' },
    ghost:   { bg: 'transparent', color: '#475569', border: 'transparent' },
    danger:  { bg: '#dc2626', color: '#ffffff', border: '#dc2626' },
    accent:  { bg: '#0ea5e9', color: '#ffffff', border: '#0ea5e9' },
  };
  const sizes = { sm: '6px 10px', md: '8px 14px', lg: '10px 20px' };
  const k = kinds[kind];
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: sizes[size], fontSize: size === 'sm' ? 12 : 13, fontWeight: 600,
      background: k.bg, color: k.color, border: `1px solid ${k.border}`,
      borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer', lineHeight: 1,
      opacity: disabled ? 0.5 : 1,
      ...(style || {}),
    }}>{children}</button>
  );
}

// ===== 印刷プレビューモーダルの中身 =====
function PrintPreviewBody({ title, monthsAhead }) {
  return (
    <div style={{
      background: '#f8fafc', padding: 24, borderRadius: 8,
      fontSize: 12, color: '#334155',
    }}>
      <div style={{ background: '#ffffff', padding: 20, border: '1px solid #e2e8f0', minHeight: 240 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>{title}</div>
        <div style={{ color: '#64748b', marginBottom: 16 }}>
          溶材会議日: {fmtYM(MEETING_DATE)} / 予測: {monthsAhead}か月先（{fmtYMSlash(addMonths(MEETING_DATE, monthsAhead))}）
        </div>
        <div style={{
          background: 'repeating-linear-gradient(45deg, #f8fafc 0 8px, #ffffff 8px 16px)',
          height: 120, border: '1px dashed #cbd5e1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#94a3b8', fontFamily: 'ui-monospace, Menlo, monospace',
        }}>
          [ ダッシュボード印刷プレビュー — A4横 ]
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: '#94a3b8' }}>
          ※ プレビューはダミー表示です
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  KpiCard, StatusBadge, HBar, ForecastSegment, SectionTitle,
  ShipPanel, Modal, Btn, PrintPreviewBody,
});
