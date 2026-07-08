import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CUSTOM_WORKSPACE_KIND_ORDER,
  CUSTOM_WORKSPACE_LAYOUTS,
  type CustomWorkspaceKind,
  type CustomWorkspaceLayoutPreset,
  type CustomWorkspaceTemplate,
  createCustomWorkspaceTemplate,
  createCustomWorkspaceTemplateDraft,
  customWorkspaceSlotCount,
  normalizeCustomWorkspaceTemplate,
} from '../utils/customWorkspaces';

const KIND_META: Record<CustomWorkspaceKind, { label: string; icon: string }> = {
  terminal: { label: '터미널 워크스페이스', icon: '⌨️' },
  browser: { label: '브라우저 워크스페이스', icon: '🌐' },
  compare: { label: '파일 비교 워크스페이스', icon: '🔍' },
  fileTransfer: { label: '파일전송 워크스페이스', icon: '📁' },
  logAnalyzer: { label: '로그분석 워크스페이스', icon: '📊' },
  microSip: { label: 'micro SIP 워크스페이스', icon: '📞' },
  vpn: { label: 'VPN 워크스페이스', icon: '🔒' },
};

const PRESET_ORDER: CustomWorkspaceLayoutPreset[] = ['row2', 'row3', 'column2', 'column3', 'grid4', 'grid6'];

export const CustomWorkspaceDialog: React.FC<{
  open: boolean;
  initialTemplate?: CustomWorkspaceTemplate | null;
  onCancel: () => void;
  onSave: (template: CustomWorkspaceTemplate) => void;
}> = ({ open, initialTemplate, onCancel, onSave }) => {
  const { t } = useTranslation('options');
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState(initialTemplate?.name || '');
  const [layout, setLayout] = useState<CustomWorkspaceLayoutPreset>(initialTemplate?.layout || 'row2');
  const [slots, setSlots] = useState(createCustomWorkspaceTemplateDraft('', 'row2').slots);
  const [activeSlotId, setActiveSlotId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const seed = initialTemplate ? normalizeCustomWorkspaceTemplate(initialTemplate) : createCustomWorkspaceTemplateDraft('', 'row2');
    setStep(1);
    setName(initialTemplate?.name || '');
    setLayout(seed.layout);
    setSlots(seed.slots.map(s => ({ ...s })));
    setActiveSlotId(null);
  }, [open, initialTemplate]);

  useEffect(() => {
    const count = customWorkspaceSlotCount(layout);
    setSlots(prev => Array.from({ length: count }, (_, i) => prev[i] || { id: `slot-${i + 1}`, kind: null }));
  }, [layout]);

  if (!open) return null;

  const currentPreset = CUSTOM_WORKSPACE_LAYOUTS[layout];
  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const base = initialTemplate && initialTemplate.id
      ? { ...normalizeCustomWorkspaceTemplate(initialTemplate), name: trimmed, layout, slots }
      : createCustomWorkspaceTemplate(trimmed, layout);
    const next = normalizeCustomWorkspaceTemplate({ ...base, name: trimmed, layout, slots } as CustomWorkspaceTemplate);
    onSave({ ...next, name: trimmed, layout, slots, updatedAt: Date.now() });
  };

  return (
    <div className="session-editor-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <section
        className="session-editor custom-workspace-dialog"
        onMouseDown={e => e.stopPropagation()}
        style={{ width: 980, maxWidth: '96vw', display: 'flex', flexDirection: 'column', maxHeight: '92vh' }}
      >
        <h3 style={{ margin: 0, cursor: 'default' }}>{initialTemplate ? '커스텀 워크스페이스 편집' : '커스텀 워크스페이스 추가'}</h3>

        {step === 1 && (
          <div className="options-content" style={{ paddingTop: 12, height: 'auto', flex: 1, minHeight: 0 }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>워크스페이스 이름</div>
              <input
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="예: 개발 대시보드"
                style={{ width: '100%', boxSizing: 'border-box', background: '#121a1f', color: '#e7f7ff', border: '1px solid #335b67', borderRadius: 6, padding: '10px 12px', fontSize: 14 }}
              />
            </div>
            <div style={{ marginBottom: 14, color: '#ccc', fontSize: 13, fontWeight: 600 }}>분할 레이아웃 선택</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
              {PRESET_ORDER.map(p => {
                const spec = CUSTOM_WORKSPACE_LAYOUTS[p];
                const selected = layout === p;
                return (
                  <label key={p} className={`custom-layout-card ${selected ? 'selected' : ''}`} style={{ display: 'block', cursor: 'pointer' }}>
                    <input type="radio" name="custom-layout" checked={selected} onChange={() => setLayout(p)} style={{ display: 'none' }} />
                    <div style={{ border: `1px solid ${selected ? '#6bd0ff' : '#355461'}`, background: selected ? 'rgba(65, 127, 164, 0.16)' : '#102229', borderRadius: 10, padding: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                        <strong style={{ color: '#eef' }}>{t(spec.labelKey, { defaultValue: p })}</strong>
                        <span style={{ color: '#89c', fontSize: 12 }}>{spec.cols}x{spec.rows}</span>
                      </div>
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: `repeat(${spec.cols}, minmax(0, 1fr))`,
                        gridTemplateRows: `repeat(${spec.rows}, 28px)`,
                        gap: 6,
                        minHeight: 66,
                      }}>
                        {Array.from({ length: spec.cols * spec.rows }, (_, i) => (
                          <div key={i} style={{ borderRadius: 6, border: '1px solid #345', background: i % 2 === 0 ? '#163140' : '#122733' }} />
                        ))}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="session-editor-actions" style={{ marginTop: 18 }}>
              <button className="btn-cancel" onClick={onCancel}>{t('actions.cancel')}</button>
              <button className="btn-save" onClick={() => setStep(2)} disabled={!name.trim()}>{'다음'}</button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="options-content" style={{ paddingTop: 12, height: 'auto', flex: 1, minHeight: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>슬롯에 워크스페이스 추가</div>
                <div style={{ color: '#88a', fontSize: 12 }}>{currentPreset.cols} x {currentPreset.rows} 레이아웃</div>
              </div>
              <button className="btn-add" onClick={() => setStep(1)}>이전</button>
            </div>
            <div className="custom-workspace-grid" style={{ display: 'grid', gap: 10, ...({
              gridTemplateColumns: `repeat(${currentPreset.cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${currentPreset.rows}, minmax(110px, 1fr))`,
            } as React.CSSProperties) }}>
              {slots.map(slot => {
                const kind = slot.kind ? KIND_META[slot.kind] : null;
                return (
                  <div key={slot.id} style={{ position: 'relative', border: '1px solid #355461', borderRadius: 10, overflow: 'visible', background: '#0c1b21', minHeight: 110 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderBottom: '1px solid #23424b', background: '#10242b' }}>
                      <div style={{ color: '#def', fontSize: 13, fontWeight: 600 }}>{kind ? `${kind.icon} ${kind.label}` : `슬롯 ${slot.id.replace('slot-', '')}`}</div>
                      <button
                        className="btn-add"
                        style={{ padding: '5px 10px', fontSize: 12 }}
                        onClick={() => setActiveSlotId(slot.id)}
                      >
                        {kind ? '변경' : '추가'}
                      </button>
                    </div>
                    <div style={{ padding: 10, minHeight: 72 }}>
                      {kind ? (
                        <div style={{ color: '#9cb', fontSize: 12, lineHeight: 1.5 }}>
                          <div style={{ fontWeight: 600, color: '#dff' }}>{kind.label}</div>
                          <div style={{ opacity: 0.85, marginTop: 4 }}>추가된 워크스페이스가 이 슬롯에 배치됩니다.</div>
                        </div>
                      ) : (
                        <div style={{ color: '#7e9', fontSize: 12, opacity: 0.95 }}>아직 선택되지 않았습니다.</div>
                      )}
                    </div>
                    {activeSlotId === slot.id && (
                      <div
                        style={{
                          position: 'absolute',
                          right: 10,
                          top: 46,
                          zIndex: 20,
                          minWidth: 220,
                          maxHeight: 'calc(92vh - 220px)',
                          overflowY: 'auto',
                          border: '1px solid #35606d',
                          borderRadius: 10,
                          background: '#081419',
                          boxShadow: '0 14px 30px rgba(0,0,0,0.35)',
                        }}
                      >
                        {CUSTOM_WORKSPACE_KIND_ORDER.map(kindId => (
                          <button
                            key={kindId}
                            className="custom-workspace-kind-item"
                            onClick={() => {
                              setSlots(prev => prev.map(s => s.id === slot.id ? { ...s, kind: kindId } : s));
                              setActiveSlotId(null);
                            }}
                            style={{
                              display: 'block',
                              width: '100%',
                              textAlign: 'left',
                              padding: '9px 12px',
                              border: 0,
                              background: 'transparent',
                              color: '#e7f3ff',
                              cursor: 'pointer',
                              borderBottom: '1px solid rgba(255,255,255,0.05)',
                            }}
                          >
                            {KIND_META[kindId].icon} {KIND_META[kindId].label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="session-editor-actions" style={{ marginTop: 18 }}>
              <button className="btn-cancel" onClick={() => setStep(1)}>{'이전'}</button>
              <button className="btn-save" onClick={commit} disabled={!name.trim()}>{initialTemplate ? '저장' : '생성'}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};

export const CustomWorkspaceManager: React.FC<{
  templates: CustomWorkspaceTemplate[];
  onCreate: () => void;
  onOpen: (templateId: string) => void;
  onEdit: (templateId: string) => void;
  onRename: (templateId: string, name: string) => void;
  onDelete: (templateId: string) => void;
}> = ({ templates, onCreate, onOpen, onEdit, onRename, onDelete }) => {
  const { t } = useTranslation('options');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    setDrafts(prev => {
      const next: Record<string, string> = {};
      for (const tpl of templates) next[tpl.id] = prev[tpl.id] ?? tpl.name;
      return next;
    });
  }, [templates]);

  return (
    <div className="options-content">
      <div style={{ marginBottom: 14 }}>
        <div style={{ color: '#ccc', fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('workspace.heading', { defaultValue: '워크스페이스' })}</div>
        <div style={{ color: '#879', fontSize: 12, marginBottom: 10 }}>{t('workspace.desc', { defaultValue: '저장된 커스텀 워크스페이스를 관리합니다.' })}</div>
        <button className="btn-add" onClick={onCreate}>+ {t('workspace.addCustom', { defaultValue: '커스텀 워크스페이스 추가' })}</button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {templates.length === 0 && (
          <div style={{ color: '#788', fontSize: 13, padding: '8px 0' }}>{t('workspace.empty', { defaultValue: '아직 저장된 커스텀 워크스페이스가 없습니다.' })}</div>
        )}
        {templates.map(tpl => (
          <div key={tpl.id} style={{ border: '1px solid #355461', borderRadius: 10, background: '#0d1d23', padding: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={drafts[tpl.id] || tpl.name}
                onChange={e => setDrafts(prev => ({ ...prev, [tpl.id]: e.target.value }))}
                style={{ flex: 1, minWidth: 200, background: '#11262d', color: '#eaf8ff', border: '1px solid #31505c', borderRadius: 6, padding: '8px 10px' }}
              />
              <button className="btn-add" onClick={() => onRename(tpl.id, drafts[tpl.id] || tpl.name)}>{t('workspace.rename', { defaultValue: '이름변경' })}</button>
              <button className="btn-add" onClick={() => onOpen(tpl.id)}>{t('workspace.open', { defaultValue: '열기' })}</button>
              <button className="btn-add" onClick={() => onEdit(tpl.id)}>{t('workspace.edit', { defaultValue: '편집' })}</button>
              <button className="btn-cancel" onClick={() => onDelete(tpl.id)}>{t('workspace.delete', { defaultValue: '삭제' })}</button>
            </div>
            <div style={{ color: '#8aa', fontSize: 12, marginTop: 8 }}>
              {t('workspace.layout', { defaultValue: '레이아웃' })}: {tpl.layout} / {tpl.slots.length} slots
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
