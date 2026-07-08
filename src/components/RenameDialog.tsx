// src/components/RenameDialog.tsx
// 파일/폴더 이름 변경 다이얼로그 — portal 로 렌더
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

type Props = {
  initialName: string;
  isDir: boolean;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
};

export const RenameDialog: React.FC<Props> = ({ initialName, isDir, onConfirm, onCancel }) => {
  const { t } = useTranslation('fileExplorer');
  const [value, setValue] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const focus = () => {
      try {
        el.focus();
        const v = el.value;
        const isDotfile = v.startsWith('.');
        const dot = (isDir || isDotfile) ? -1 : v.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : v.length);
      } catch {}
    };
    focus();
    const t = setTimeout(() => focus(), 30);
    return () => { clearTimeout(t); };
  }, [isDir, initialName]);

  const submit = () => {
    const v = value.trim();
    if (!v) { onCancel(); return; }
    if (v === initialName) { onCancel(); return; }
    onConfirm(v);
  };

  return createPortal(
    <div className="rn-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="rn-dialog" onMouseDown={e => e.stopPropagation()}>
        <div className="rn-title">{t('renameTitle')}</div>
        <div className="rn-body">
          <label className="rn-label">{t('renameNewLabel')}</label>
          <input
            ref={inputRef}
            className="rn-input"
            value={value}
            onChange={e => setValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
        </div>
        <div className="rn-actions">
          <button className="rn-btn rn-btn-primary" onClick={submit}>{t('confirm')}</button>
          <button className="rn-btn" onClick={onCancel}>{t('cancel')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
