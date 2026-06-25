// src/components/ChmodDialog.tsx
// 권한 변경 다이얼로그 — SSH/SFTP 세션 전용
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const api = (window as any).api || {};

type Props = {
  mode: string;           // 'local' | 'remote'
  termId?: string;
  paths: string[];        // 절대 경로
  initialMode?: number;   // 0o600 등 (없으면 0o644)
  hasDir?: boolean;       // 선택 중 디렉토리 포함 여부
  onClose: () => void;
  onApplied: () => void;
};

export const ChmodDialog: React.FC<Props> = ({ mode, termId, paths, initialMode, hasDir, onClose, onApplied }) => {
  const { t: tr } = useTranslation('fileExplorer');
  const initOctal = (initialMode ?? 0o644) & 0o777;
  const [octal, setOctal] = useState<string>(initOctal.toString(8).padStart(3, '0'));
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // octal → 체크박스
  const parseBits = (oct: string) => {
    const n = parseInt(oct, 8);
    if (isNaN(n)) return { o: 0, g: 0, t: 0 };
    return { o: (n >> 6) & 7, g: (n >> 3) & 7, t: n & 7 };
  };
  const { o, g, t } = parseBits(octal);

  const bitOn = (group: 'o' | 'g' | 't', bit: number, on: boolean) => {
    const cur = parseBits(octal);
    const v = on ? (cur[group] | bit) : (cur[group] & ~bit);
    const next = { ...cur, [group]: v };
    const n = (next.o << 6) | (next.g << 3) | next.t;
    setOctal(n.toString(8).padStart(3, '0'));
  };

  const onOctalChange = (v: string) => {
    // 0~7 만 허용, 최대 4자리
    const clean = v.replace(/[^0-7]/g, '').slice(0, 4);
    setOctal(clean);
  };

  const apply = async () => {
    setBusy(true);
    setErr(null);
    try {
      const m = parseInt(octal, 8);
      if (isNaN(m) || m < 0 || m > 0o7777) { setErr(tr('chmodInvalidValue')); setBusy(false); return; }
      const r = await api.feChmod?.({ mode, termId, paths, octal: m, recursive });
      if (r?.success === false) {
        setErr(r.error || tr('chmodFail'));
        setBusy(false);
        return;
      }
      onApplied();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
      setBusy(false);
    }
  };

  // ESC 닫기, Enter 적용
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'Enter' && !busy) apply();
  };

  useEffect(() => {
    // 다이얼로그 마운트 시 input 에 포커스
    const t = setTimeout(() => { (document.querySelector('.chmod-octal-input') as HTMLInputElement)?.focus(); }, 30);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="cf-backdrop">
      <div className="cf-dialog chmod-dialog" onKeyDown={onKeyDown} tabIndex={-1}>
        <div className="cf-titlebar">
          <span className="cf-title">{tr('chmodTitle')}</span>
          <button className="cf-close" onClick={onClose} title={tr('cancel')}>✕</button>
        </div>
        <div className="cf-body">
          <div className="cf-row chmod-octal-row">
            <span className="cf-label">{tr('chmodPermLabel')}</span>
            <input
              className="cf-input chmod-octal-input"
              value={octal}
              onChange={e => onOctalChange(e.target.value)}
              style={{ width: 90 }}
            />
          </div>
          <div className="chmod-grid">
            <div className="chmod-col">
              <div className="chmod-col-title">{tr('chmodOwner')}</div>
              <label><input type="checkbox" checked={!!(o & 4)} onChange={e => bitOn('o', 4, e.target.checked)} /> {tr('chmodRead')}</label>
              <label><input type="checkbox" checked={!!(o & 2)} onChange={e => bitOn('o', 2, e.target.checked)} /> {tr('chmodWrite')}</label>
              <label><input type="checkbox" checked={!!(o & 1)} onChange={e => bitOn('o', 1, e.target.checked)} /> {tr('chmodExec')}</label>
            </div>
            <div className="chmod-col">
              <div className="chmod-col-title">{tr('chmodGroup')}</div>
              <label><input type="checkbox" checked={!!(g & 4)} onChange={e => bitOn('g', 4, e.target.checked)} /> {tr('chmodRead')}</label>
              <label><input type="checkbox" checked={!!(g & 2)} onChange={e => bitOn('g', 2, e.target.checked)} /> {tr('chmodWrite')}</label>
              <label><input type="checkbox" checked={!!(g & 1)} onChange={e => bitOn('g', 1, e.target.checked)} /> {tr('chmodExec')}</label>
            </div>
            <div className="chmod-col">
              <div className="chmod-col-title">{tr('chmodOther')}</div>
              <label><input type="checkbox" checked={!!(t & 4)} onChange={e => bitOn('t', 4, e.target.checked)} /> {tr('chmodRead')}</label>
              <label><input type="checkbox" checked={!!(t & 2)} onChange={e => bitOn('t', 2, e.target.checked)} /> {tr('chmodWrite')}</label>
              <label><input type="checkbox" checked={!!(t & 1)} onChange={e => bitOn('t', 1, e.target.checked)} /> {tr('chmodExec')}</label>
            </div>
          </div>
          {hasDir && (
            <label className="chmod-recursive">
              <input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} />
              {tr('chmodRecursive')}
            </label>
          )}
          <div className="chmod-note">{tr('chmodNote')}</div>
          {err && <div className="chmod-error">{err}</div>}
          <div className="chmod-target-list">
            {paths.length > 1 ? tr('chmodItemCount', { count: paths.length }) : paths[0]}
          </div>
        </div>
        <div className="cf-actions">
          <button className="cf-btn cf-btn-primary" disabled={busy} onClick={apply}>{busy ? tr('chmodApplying') : tr('confirm')}</button>
          <button className="cf-btn" onClick={onClose}>{tr('cancel')}</button>
        </div>
      </div>
    </div>
  );
};
