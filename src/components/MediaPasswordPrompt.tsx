// src/components/MediaPasswordPrompt.tsx
// #!ENC 로 암호화된 음원 파일을 열 때 표시하는 평문 비밀번호 입력 모달.
import { useState } from 'react';

export function MediaPasswordPrompt({ fileName, error, onSubmit, onCancel }: {
  fileName: string;
  error?: string | null;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');

  const submit = () => {
    if (!password) return;
    onSubmit(password);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
      <div style={{ width: 360, borderRadius: 10, border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--win-text, #e6edf3)' }}>🔒 암호화된 음원</div>
        <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', wordBreak: 'break-all' }}>
          <b>{fileName}</b> 파일은 암호화되어 있습니다. 재생하려면 비밀번호를 입력하세요.
        </div>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }}
          placeholder="비밀번호"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 6,
            border: '1px solid var(--win-border, #30363d)', background: 'var(--win-bg, #0d1117)',
            color: 'var(--win-text, #e6edf3)', fontSize: 13,
          }}
        />
        {error && <div style={{ fontSize: 12, color: '#e5534b' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            onClick={onCancel}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer' }}
          >취소</button>
          <button
            onClick={submit}
            disabled={!password}
            style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--win-accent, #2b6b9b)', color: '#fff', fontSize: 12, cursor: password ? 'pointer' : 'not-allowed', opacity: password ? 1 : 0.6 }}
          >확인</button>
        </div>
      </div>
    </div>
  );
}
