// src/components/OfficeBackBar.tsx
// 오피스 형식별 에디터 상단 공통 헤더 바 — 라벨 + 우측 도구모음. 탭 닫기는 상위 탭 자체의 × 로 처리.
export function OfficeBackBar({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--win-border, #30363d)', flex: '0 0 auto' }}>
      <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)' }}>{label}</div>
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}
