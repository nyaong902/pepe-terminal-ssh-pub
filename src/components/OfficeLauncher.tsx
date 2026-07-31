// src/components/OfficeLauncher.tsx
// 오피스 워크스페이스 진입점 — 상단 탭 바에는 이미 형식이 정해진 탭(한글/워드/엑셀/파워포인트/PDF)만
// 나타난다. "+" 를 누르면 형식 선택 화면이 그 자리에 잠깐 나타날 뿐 탭으로 남지 않고, 형식을
// 고르는 즉시 그 이름의 탭이 새로 생긴다. 각 형식 에디터 내부에는 문서 단위 미니탭이 별도로 있다.
import { useEffect, useRef, useState } from 'react';
import { OfficeWorkspace } from './OfficeWorkspace';
import { ZiziyiOfficeWorkspace } from './ZiziyiOfficeWorkspace';
import { PdfWorkspace } from './PdfWorkspace';
import { FlowChartWorkspace } from './FlowChartWorkspace';

export type OfficeFormat = 'hwp' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'drawio';

const FORMATS: { id: OfficeFormat; label: string; icon: string; desc: string }[] = [
  { id: 'hwp', label: '한글', icon: '📄', desc: 'HWP / HWPX' },
  { id: 'docx', label: '워드', icon: '📝', desc: 'Word (.docx)' },
  { id: 'xlsx', label: '엑셀', icon: '📊', desc: 'Excel (.xlsx)' },
  { id: 'pptx', label: '파워포인트', icon: '📽️', desc: 'PowerPoint (.pptx)' },
  { id: 'pdf', label: 'PDF', icon: '🗎', desc: 'PDF' },
  { id: 'drawio', label: 'FlowChart', icon: '🧩', desc: 'draw.io (.drawio)' },
];

const cardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
  width: 140, padding: '24px 12px', borderRadius: 12,
  border: '1px solid var(--win-border, #30363d)', background: 'var(--win-surface, #161b22)',
  color: 'var(--win-text, #e6edf3)', cursor: 'pointer', fontSize: 14,
};

function FormatPicker({ onSelect }: { onSelect: (f: OfficeFormat) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: '1 1 0', width: '100%', height: '100%', gap: 24, background: 'var(--win-bg, #0d1117)' }}>
      <div style={{ fontSize: 16, color: 'var(--win-text, #e6edf3)', fontWeight: 600 }}>오피스 — 문서 형식을 선택하세요</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
        {FORMATS.map(f => (
          <div key={f.id} style={cardStyle} onClick={() => onSelect(f.id)}>
            <div style={{ fontSize: 36 }}>{f.icon}</div>
            <div style={{ fontWeight: 600 }}>{f.label}</div>
            <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

type Slot = { id: string; format: OfficeFormat };
let nextSlotId = 0;

const slotTabStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: '6px 6px 0 0',
  background: active ? 'var(--win-surface, #161b22)' : 'transparent',
  border: '1px solid var(--win-border, #30363d)',
  color: 'var(--win-text, #e6edf3)', fontSize: 12, cursor: 'pointer', maxWidth: 160, whiteSpace: 'nowrap',
});

type OfficeLauncherState = { slots: Slot[]; activeId: string | null; pickerOpen: boolean };

export function OfficeLauncher({ instanceId, initialState, onStateChange, initialFile }: {
  instanceId: string;
  // 다른 창으로 분리될 때 "어떤 형식 탭이 열려 있었는지"만 가볍게 보존한다 — 편집기(iframe)
  // 내부의 실제 문서 편집 내용까지는 살릴 수 없다(그 안은 각 에디터 프로세스 고유 상태).
  initialState?: OfficeLauncherState;
  onStateChange?: (state: OfficeLauncherState) => void;
  // Pepe-Thing(파일 검색) 등에서 "이 파일을 오피스 워크스페이스로 열기"를 선택했을 때 — 탭 생성과
  // 동시에 해당 형식 슬롯을 만들고 그 파일을 바로 연다. 탭당 1회만 적용(같은 값이 재전달돼도 무시).
  initialFile?: { format: OfficeFormat; filePath: string };
}) {
  const [slots, setSlots] = useState<Slot[]>(initialState?.slots || []);
  const [activeId, setActiveId] = useState<string | null>(initialState?.activeId ?? null);
  const [pickerOpen, setPickerOpen] = useState(initialState ? initialState.pickerOpen : !initialFile);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const initialFileAppliedRef = useRef(false);

  useEffect(() => {
    onStateChange?.({ slots, activeId, pickerOpen });
  }, [slots, activeId, pickerOpen]);

  const selectFormat = (format: OfficeFormat) => {
    const id = `slot-${++nextSlotId}`;
    setSlots(prev => [...prev, { id, format }]);
    setActiveId(id);
    setPickerOpen(false);
    return id;
  };

  useEffect(() => {
    if (!initialFile || initialFileAppliedRef.current) return;
    initialFileAppliedRef.current = true;
    selectFormat(initialFile.format);
    setPendingFilePath(initialFile.filePath);
  }, [initialFile]);

  // pendingFilePath 는 슬롯 생성 직후 하위 워크스페이스가 마운트 시점에 한 번 읽도록 하는 용도일
  // 뿐이라, 그 다음 렌더에서는 지워야 한다 — 자식(OfficeWorkspace 등)의 useEffect 는 부모보다 먼저
  // 커밋되므로 여기서 지워도 최초 오픈에는 영향이 없다. 지우지 않으면 이 슬롯이 활성인 동안 매
  // 렌더마다 initialFilePath prop 이 계속 전달되는데, 자식의 1회성 ref 가드 덕에 실제 버그(재오픈
  // 반복)로 이어지진 않지만 의도가 불분명한 상태가 계속 남는 건 피한다.
  useEffect(() => {
    if (pendingFilePath === null) return;
    setPendingFilePath(null);
  }, [pendingFilePath]);

  const closeSlot = (id: string) => {
    const idx = slots.findIndex(s => s.id === id);
    const next = slots.filter(s => s.id !== id);
    setSlots(next);
    if (activeId !== id) return;
    if (next.length) {
      setActiveId(next[Math.min(idx, next.length - 1)].id);
    } else {
      setActiveId(null);
      setPickerOpen(true);
    }
  };

  const showingPicker = pickerOpen || slots.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
      {slots.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '4px 8px', borderBottom: '1px solid var(--win-border, #30363d)', overflowX: 'auto', flex: '0 0 auto' }}>
          {slots.map(slot => {
            const meta = FORMATS.find(f => f.id === slot.format)!;
            return (
              <div key={slot.id} onClick={() => { setActiveId(slot.id); setPickerOpen(false); }} style={slotTabStyle(!pickerOpen && slot.id === activeId)}>
                <span>{meta.icon}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.label}</span>
                <span onClick={(e) => { e.stopPropagation(); closeSlot(slot.id); }} style={{ opacity: 0.7, padding: '0 2px', borderRadius: 4 }}>×</span>
              </div>
            );
          })}
          <button
            onClick={() => setPickerOpen(true)}
            title="새 형식 탭"
            style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--win-border, #30363d)', background: 'transparent', color: 'var(--win-text, #e6edf3)', fontSize: 13, cursor: 'pointer' }}
          >＋</button>
        </div>
      )}
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative' }}>
        {showingPicker && <FormatPicker onSelect={selectFormat} />}
        {slots.map(slot => {
          // pendingFilePath 는 initialFile 로 생성된 슬롯에만 1회성으로 흘려보낸다 — 다른 슬롯이나
          // 이후 재렌더에 재사용되면 안 되므로 여기서 꺼내는 즉시 지운다(각 하위 워크스페이스는
          // 마운트 시 1회만 여는 자체 ref 가드를 갖고 있어 중복 오픈은 없지만, prop 자체를 슬롯
          // 고유값으로 한정해 의도를 명확히 한다).
          const filePathForThisSlot = pendingFilePath && slot.id === activeId ? pendingFilePath : undefined;
          return (
            <div key={slot.id} style={{ position: 'absolute', inset: 0, display: !pickerOpen && slot.id === activeId ? 'flex' : 'none', flexDirection: 'column' }}>
              {slot.format === 'hwp' ? (
                <OfficeWorkspace instanceId={instanceId} initialFilePath={filePathForThisSlot} />
              ) : slot.format === 'pdf' ? (
                <PdfWorkspace instanceId={instanceId} initialFilePath={filePathForThisSlot} />
              ) : slot.format === 'drawio' ? (
                <FlowChartWorkspace instanceId={instanceId} />
              ) : (
                <ZiziyiOfficeWorkspace instanceId={instanceId} kind={slot.format} initialFilePath={filePathForThisSlot} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
