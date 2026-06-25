// src/components/DriverManagerModal.tsx
//
// DBeaver-style JDBC driver manager. Lets the user:
//  - browse all registered drivers (built-in + user-defined),
//  - edit name / className / URL template / default port / JAR list,
//  - import JAR files from disk into the user driver folder,
//  - "Test load" — calls jdbc:load-driver to verify URLClassLoader + class instantiation,
//  - save (creates a user override for the same id),
//  - remove (user-defined only — removing a user override restores the built-in).

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Dialect = 'altibase' | 'mysql' | 'postgres' | 'oracle' | 'mssql' | 'sqlite' | 'generic';

export interface JdbcDriverDef {
  id: string;
  name: string;
  className: string;
  urlTemplate: string;
  defaultPort: number;
  jars: string[];
  builtin: boolean;
  dialect: Dialect;
  note?: string;
  // DBeaver 와 동일하게 driver 별 JDBC properties 보존 (DriverManager.getConnection props 로 전달).
  properties?: Record<string, string>;
  // 그 외 메타데이터 (e.g. URL template variants, vendor flags 등). 자유 형식.
  meta?: Record<string, string>;
  // Enriched by main process listDrivers — JAR diagnostics.
  diag?: { usable: boolean; existing: string[]; missing: string[]; resolved: string[] };
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  background: '#1e1e1e', color: '#d4d4d4', border: '1px solid #444',
  borderRadius: 3, padding: '4px 8px', fontSize: 12, fontFamily: 'monospace',
};

// 키/값 맵 편집기 — properties / advanced 탭에서 공용 사용
const PropertyEditor: React.FC<{
  title: string;
  map: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}> = ({ title, map, onChange }) => {
  const { t: tr } = useTranslation('sqlTool');
  const entries = Object.entries(map);
  const setKey = (oldKey: string, newKey: string) => {
    if (oldKey === newKey) return;
    const { [oldKey]: v, ...rest } = map;
    onChange({ ...rest, [newKey]: v });
  };
  const setVal = (key: string, v: string) => onChange({ ...map, [key]: v });
  const remove = (key: string) => { const { [key]: _, ...rest } = map; onChange(rest); };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ color: '#bbb', fontSize: 11 }}>{title}</span>
        <button onClick={() => onChange({ ...map, '': '' })}
          style={{ marginLeft: 'auto', background: '#3a7d3a', color: '#fff', border: 0, padding: '3px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
        >{tr('driverAddItem')}</button>
      </div>
      {entries.length === 0 && <div style={{ color: '#888', fontSize: 11, padding: '6px 0' }}>{tr('driverEmpty')}</div>}
      <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontFamily: 'monospace', fontSize: 12 }}>
        {entries.length > 0 && (
          <thead><tr style={{ color: '#9cdcfe' }}>
            <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #3f3f46' }}>Key</th>
            <th style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid #3f3f46' }}>Value</th>
            <th style={{ width: 30 }} />
          </tr></thead>
        )}
        <tbody>
          {entries.map(([k, v], i) => (
            <tr key={i}>
              <td style={{ padding: '2px 4px' }}>
                <input value={k} onChange={e => setKey(k, e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="key" />
              </td>
              <td style={{ padding: '2px 4px' }}>
                <input value={v} onChange={e => setVal(k, e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="value" />
              </td>
              <td style={{ textAlign: 'center' }}>
                <button onClick={() => remove(k)} style={{ background: 'transparent', color: '#888', border: 0, cursor: 'pointer', fontSize: 14 }}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const newDraft = (): JdbcDriverDef => ({
  id: `user-${Date.now().toString(36)}`,
  name: '신규 드라이버',
  className: '',
  urlTemplate: 'jdbc:???://{host}:{port}/{database}',
  defaultPort: 0,
  jars: [],
  builtin: false,
  dialect: 'generic',
});

type TabId = 'settings' | 'libraries' | 'properties' | 'advanced';

export const DriverManagerModal: React.FC<Props> = ({ open, onClose }) => {
  const { t: tr } = useTranslation('sqlTool');
  const TABS: { id: TabId; label: string }[] = [
    { id: 'settings',   label: 'Settings' },
    { id: 'libraries',  label: 'Libraries' },
    { id: 'properties', label: tr('driverTabBasicProps') },
    { id: 'advanced',   label: 'Advanced parameters' },
  ];
  const [drivers, setDrivers] = useState<JdbcDriverDef[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<JdbcDriverDef | null>(null);
  const [roots, setRoots] = useState<{ bundled: string; user: string }>({ bundled: '', user: '' });
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<string>('');
  const [tab, setTab] = useState<TabId>('settings');
  // Add Artifact 모달
  const [artifactModal, setArtifactModal] = useState<{ group: string; artifact: string; version: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  // 정보/에러 모달 — alert() 대체. window.alert 가 포커스를 빼앗고 모달 UX 일관성 깨는 문제 회피.
  const [infoModal, setInfoModal] = useState<{ kind: 'info' | 'success' | 'error'; title: string; message: string } | null>(null);
  const showInfo  = (title: string, message: string) => setInfoModal({ kind: 'info', title, message });
  const showOk    = (title: string, message: string) => setInfoModal({ kind: 'success', title, message });
  const showErr   = (title: string, message: string) => setInfoModal({ kind: 'error', title, message });
  // 확인 모달 — window.confirm 대체.
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onOk: () => void } | null>(null);
  // Libraries 트리 선택/펼침 상태
  const [selectedJarIdx, setSelectedJarIdx] = useState<number>(-1);
  const [expandedJars, setExpandedJars] = useState<Set<number>>(new Set());
  const [editingJarIdx, setEditingJarIdx] = useState<number>(-1);
  // Selected 항목이 사라질 때 인덱스 정리
  useEffect(() => { setSelectedJarIdx(-1); setEditingJarIdx(-1); setExpandedJars(new Set()); }, [selectedId]);

  const reload = async () => {
    const api: any = (window as any).api || {};
    const list: JdbcDriverDef[] = await api.jdbcListDrivers?.() || [];
    const r = await api.jdbcDriverRoots?.() || { bundled: '', user: '' };
    setDrivers(list);
    setRoots(r);
    setSelectedId(prev => {
      if (prev && list.find(d => d.id === prev)) return prev;
      return list[0]?.id || '';
    });
    setTestMsg('');
  };
  useEffect(() => { if (open) reload(); }, [open]);

  // Reset the draft when the selection changes (deep clone so we don't mutate state in-place)
  useEffect(() => {
    if (!selectedId) { setDraft(null); return; }
    const d = drivers.find(x => x.id === selectedId);
    setDraft(d ? JSON.parse(JSON.stringify(d)) : null);
    setTestMsg('');
  }, [selectedId, drivers]);

  if (!open) return null;

  const selectedOriginal = drivers.find(x => x.id === selectedId) || null;
  const isDirty = !!draft && JSON.stringify(draft) !== JSON.stringify(selectedOriginal);

  const apiAny: any = (window as any).api || {};

  const handleSave = async () => {
    if (!draft) return;
    const r = await apiAny.jdbcSaveDriver?.(draft);
    if (r?.success) { await reload(); setSelectedId(draft.id); }
    else showErr(tr('driverSaveFailed'), r?.error || '?');
  };

  const handleRemove = async () => {
    if (!selectedOriginal) return;
    setConfirmModal({
      title: tr('driverRemoveTitle'),
      message: tr('driverRemoveConfirm', { name: selectedOriginal.name, id: selectedOriginal.id }),
      onOk: async () => {
        const r = await apiAny.jdbcRemoveDriver?.(selectedOriginal.id);
        if (r?.success) { await reload(); }
        else showErr(tr('driverRemoveFailed'), r?.error || '?');
      },
    });
  };

  const handleAdd = () => {
    const d = newDraft();
    d.name = tr('driverNewName');
    setDrivers(prev => [...prev, d]);
    setSelectedId(d.id);
    setDraft(d);
  };
  // DBeaver "Copy" — 선택된 드라이버를 깊은 복사 후 새 id 부여, 영속화하고 선택.
  const handleDuplicate = async () => {
    if (!selectedOriginal) return;
    const base = JSON.parse(JSON.stringify(selectedOriginal)) as JdbcDriverDef;
    // diag 은 main 이 다시 계산하므로 제외
    delete (base as any).diag;
    base.id = `user-${Date.now().toString(36)}`;
    base.name = tr('driverCopyName', { name: base.name });
    base.builtin = false;
    const r = await apiAny.jdbcSaveDriver?.(base);
    if (r?.success) { await reload(); setSelectedId(base.id); }
    else showErr(tr('driverDuplicateFailed'), r?.error || '?');
  };

  const handleImportJar = async () => {
    const r = await apiAny.jdbcPickAndImportJar?.();
    if (!r || r.canceled) return;
    if (!r.success) { showErr(tr('driverJarImportFailed'), r.error || '?'); return; }
    if (draft) setDraft({ ...draft, jars: [...draft.jars, ...(r.imported || [])] });
  };
  const handleAddFolder = async () => {
    const r = await apiAny.jdbcPickAndImportFolder?.();
    if (!r || r.canceled) return;
    if (!r.success) { showErr(tr('driverFolderImportFailed'), r.error || '?'); return; }
    if (draft) setDraft({ ...draft, jars: [...draft.jars, ...(r.imported || [])] });
  };
  // DBeaver "Download/Update" — 드라이버의 모든 maven: 좌표 다운로드 (캐시된 건 스킵)
  const handleDownloadLibraries = async () => {
    if (!draft) return;
    setTesting(true); setTestMsg(tr('driverMavenDownloading'));
    try {
      const r = await apiAny.jdbcDownloadDriverLibraries?.(draft);
      if (!r?.success) { setTestMsg(`❌ ${r?.error || '?'}`); return; }
      const results: any[] = r.results || [];
      const failed = results.filter((x: any) => !x.ok);
      const downloaded = results.filter((x: any) => x.ok && !x.cached).length;
      const cached    = results.filter((x: any) => x.ok && x.cached).length;
      if (failed.length === 0) {
        setTestMsg(tr('driverMavenOk', { downloaded, cached }));
      } else {
        setTestMsg(tr('driverMavenPartialFail', { count: failed.length, coords: failed.map((f: any) => f.coord).join(', ') }));
      }
      await reload();
    } finally { setTesting(false); }
  };
  const handleDownloadArtifact = async () => {
    if (!artifactModal) return;
    const { group, artifact, version } = artifactModal;
    if (!group || !artifact || !version) { showInfo('Maven Artifact', tr('driverMavenAllRequired')); return; }
    setDownloading(true);
    try {
      const r = await apiAny.jdbcDownloadMavenArtifact?.({ groupId: group, artifactId: artifact, version });
      if (r?.success) {
        if (draft) setDraft({ ...draft, jars: [...draft.jars, r.imported] });
        setArtifactModal(null);
      } else {
        showErr(tr('driverMavenDownloadFailed'), r?.error || '?');
      }
    } finally { setDownloading(false); }
  };

  const handleTestLoad = async () => {
    if (!draft) return;
    setTesting(true); setTestMsg(tr('driverTesting'));
    try {
      // Save first if dirty — load uses the current driver definition.
      if (isDirty) {
        const sr = await apiAny.jdbcSaveDriver?.(draft);
        if (!sr?.success) { setTestMsg(`❌ ${tr('driverSaveFailed')}: ${sr?.error || '?'}`); return; }
        await reload();
      }
      // 누락된 maven: 좌표 자동 다운로드 (DBeaver 와 동일) — slf4j 같은 transitive 의존성 누락 방지
      const hasMaven = draft.jars.some(j => /^maven:/.test(j));
      if (hasMaven) {
        setTestMsg(tr('driverMavenChecking'));
        await apiAny.jdbcDownloadDriverLibraries?.(draft);
        await reload();
      }
      const r = await apiAny.jdbcLoadDriver?.(draft);
      if (r?.success) setTestMsg(tr('driverLoadOk', { className: draft.className }));
      else setTestMsg(`❌ ${r?.error || '?'}`);
    } catch (e: any) {
      setTestMsg(`❌ ${tr('driverException')}: ${e?.message || e}`);
    } finally { setTesting(false); }
  };

  const resolvedExists = (j: string, idx?: number): boolean => {
    if (!draft?.diag) return false;
    // jars[i] 와 diag.resolved[i] 가 1:1 매칭 → 인덱스 직접 사용 시 가장 정확
    if (typeof idx === 'number' && draft.diag.resolved && draft.diag.resolved[idx]) {
      return (draft.diag.existing || []).includes(draft.diag.resolved[idx]);
    }
    // fallback — 토큰 치환 후 비교 (maven: 좌표는 매칭 안 됨)
    const r = j.replace('${bundled}', roots.bundled).replace('${userJdbc}', roots.user);
    return (draft.diag.existing || []).includes(r);
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 5000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#252526', color: '#d4d4d4', fontFamily: 'system-ui, sans-serif',
          width: 920, maxWidth: '94vw', height: 620, maxHeight: '92vh',
          borderRadius: 6, display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ padding: '10px 14px', borderBottom: '1px solid #333', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>🗂 {tr('driverManagerTitle')}</span>
          <span style={{ color: '#888', fontSize: 11 }}>({drivers.length})</span>
          <button
            onClick={onClose}
            title={tr('driverClose')}
            style={{ marginLeft: 'auto', background: 'transparent', color: '#aaa', border: 0, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}
          >×</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* Left: driver list */}
          <div style={{ width: 280, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {drivers.map(d => {
                const usable = d.diag?.usable;
                const active = selectedId === d.id;
                return (
                  <div
                    key={d.id}
                    onClick={() => setSelectedId(d.id)}
                    style={{
                      padding: '6px 12px', cursor: 'pointer',
                      background: active ? '#094771' : 'transparent',
                      borderBottom: '1px solid #2a2a2a',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: usable ? '#5fb55f' : '#e07050' }}>{usable ? '✓' : '⚠'}</span>
                      <span style={{ fontWeight: 600, color: active ? '#fff' : '#ddd' }}>{d.name}</span>
                      {d.builtin && (
                        <span style={{ marginLeft: 'auto', fontSize: 10, color: '#888', background: '#2a2a2a', border: '1px solid #444', padding: '0 4px', borderRadius: 2 }}>
                          builtin
                        </span>
                      )}
                    </div>
                    <div style={{ color: '#888', fontSize: 11, marginTop: 2, marginLeft: 14 }}>{d.dialect} · {d.className || tr('driverNoClass')}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 8, borderTop: '1px solid #333', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                onClick={handleAdd}
                title={tr('driverAddTitle')}
                style={{ flex: 1, background: '#0e639c', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >{tr('driverAdd')}</button>
              {!!selectedOriginal && (
                <button
                  onClick={handleDuplicate}
                  title={tr('driverDuplicateTitle', { name: selectedOriginal.name })}
                  style={{ background: '#3a5a7d', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
                >{tr('driverDuplicate')}</button>
              )}
              {!!selectedOriginal && (
                <button
                  onClick={handleRemove}
                  title={tr('driverRemoveBtnTitle')}
                  style={{ background: '#5a1d1d', color: '#fff', border: 0, padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
                >{tr('driverRemove')}</button>
              )}
            </div>
          </div>

          {/* Right: detail with tabs (DBeaver Edit Driver 와 동일 구조) */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {!draft && <div style={{ padding: 14, color: '#888' }}>{tr('driverSelectOrAdd')}</div>}
            {draft && (<>
              {/* 탭 헤더 */}
              <div style={{ display: 'flex', borderBottom: '1px solid #333', background: '#252526' }}>
                {TABS.map(t => (
                  <div key={t.id}
                    onClick={() => setTab(t.id)}
                    style={{
                      padding: '6px 14px', cursor: 'pointer', fontSize: 12, userSelect: 'none',
                      background: tab === t.id ? '#1e1e1e' : 'transparent',
                      color: tab === t.id ? '#fff' : '#bbb',
                      borderRight: '1px solid #333',
                      borderTop: tab === t.id ? '2px solid #569cd6' : '2px solid transparent',
                    }}
                  >{t.label}</div>
                ))}
              </div>
              {/* 탭 컨텐츠 */}
              <div style={{ flex: 1, overflow: 'auto', padding: 14, minWidth: 0 }}>
                {tab === 'settings' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center' }}>
                    <label style={{ color: '#bbb', fontSize: 12 }}>{tr('driverName')}</label>
                    <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} style={inputStyle} />
                    <label style={{ color: '#bbb', fontSize: 12 }}>Dialect</label>
                    <select value={draft.dialect} onChange={e => setDraft({ ...draft, dialect: e.target.value as Dialect })} style={inputStyle}>
                      <option value="altibase">altibase</option>
                      <option value="mysql">mysql</option>
                      <option value="postgres">postgres</option>
                      <option value="oracle">oracle</option>
                      <option value="mssql">mssql</option>
                      <option value="sqlite">sqlite</option>
                      <option value="generic">generic</option>
                    </select>
                    <label style={{ color: '#bbb', fontSize: 12 }}>{tr('driverClass')}</label>
                    <input value={draft.className} onChange={e => setDraft({ ...draft, className: e.target.value })} placeholder={tr('driverClassPlaceholder')} style={inputStyle} />
                    <label style={{ color: '#bbb', fontSize: 12 }}>{tr('driverUrlTemplate')}</label>
                    <input value={draft.urlTemplate} onChange={e => setDraft({ ...draft, urlTemplate: e.target.value })} placeholder="jdbc:scheme://{host}:{port}/{database}" style={inputStyle} />
                    <label style={{ color: '#bbb', fontSize: 12 }}>{tr('driverDefaultPort')}</label>
                    <input type="number" value={draft.defaultPort} onChange={e => setDraft({ ...draft, defaultPort: parseInt(e.target.value || '0', 10) || 0 })} style={{ ...inputStyle, width: 100 }} />
                    {draft.note && (
                      <>
                        <span />
                        <div style={{ padding: 8, background: '#3a2a14', border: '1px solid #6a4a24', borderRadius: 3, color: '#ffd680', fontSize: 11, lineHeight: 1.4 }}>💡 {draft.note}</div>
                      </>
                    )}
                  </div>
                )}
                {tab === 'libraries' && (() => {
                  // DBeaver 와 동일한 좌측 트리 + 우측 버튼 컬럼 레이아웃.
                  const parseJar = (j: string) => {
                    if (/^maven:/.test(j)) {
                      // @ext (packaging) 접미사 분리
                      let body = j.slice('maven:'.length);
                      let ext = 'jar';
                      const at = body.lastIndexOf('@');
                      if (at >= 0) { ext = body.slice(at + 1) || 'jar'; body = body.slice(0, at); }
                      const parts = body.split(':');
                      if (parts.length >= 3) {
                        return { kind: 'maven' as const, group: parts[0], artifact: parts[1], version: parts[2], classifier: parts[3] || '', ext };
                      }
                    }
                    if (/\.(txt|md|html|license)$/i.test(j)) return { kind: 'license' as const };
                    return { kind: 'jar' as const };
                  };
                  // diag.resolved[i] 가 jars[i] 와 1:1 매칭. expand 시 보이는 child 파일명을 추출.
                  const resolvedPathFor = (idx: number): string | null => {
                    const arr = draft.diag?.resolved || [];
                    return arr[idx] || null;
                  };
                  const sel = selectedJarIdx;
                  const hasSel = sel >= 0 && sel < draft.jars.length;
                  return (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      {/* 좌측: 라이브러리 트리 */}
                      <div style={{ flex: 1, minWidth: 0, background: '#1e1e1e', border: '1px solid #333', borderRadius: 3, padding: 6, minHeight: 220, maxHeight: 360, overflowY: 'auto' }}>
                        {draft.jars.length === 0 && (
                          <div style={{ color: '#888', fontSize: 11, padding: '6px 0' }}>{tr('driverNoJars')}</div>
                        )}
                        {draft.jars.map((j, idx) => {
                          const meta = parseJar(j);
                          const exists = resolvedExists(j, idx);
                          const isMaven = meta.kind === 'maven';
                          const isLicense = meta.kind === 'license';
                          const expanded = expandedJars.has(idx);
                          const isSelected = sel === idx;
                          const isEditing = editingJarIdx === idx;
                          return (
                            <div key={idx}>
                              <div
                                onClick={() => setSelectedJarIdx(idx)}
                                onDoubleClick={() => setEditingJarIdx(idx)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 4,
                                  padding: '2px 4px',
                                  background: isSelected ? '#094771' : 'transparent',
                                  cursor: 'pointer', userSelect: 'none',
                                  borderRadius: 2,
                                }}
                              >
                                {/* 펼침 캐럿 — Maven 만 child 보임 */}
                                {isMaven ? (
                                  <span
                                    onClick={e => { e.stopPropagation(); setExpandedJars(prev => { const n = new Set(prev); if (n.has(idx)) n.delete(idx); else n.add(idx); return n; }); }}
                                    style={{ width: 12, color: '#888', cursor: 'pointer', textAlign: 'center' }}
                                  >{expanded ? '▾' : '▸'}</span>
                                ) : (
                                  <span style={{ width: 12 }} />
                                )}
                                {/* 상태 + 종류 아이콘 */}
                                <span style={{ color: exists ? '#5fb55f' : '#e07050', width: 12, fontSize: 11 }} title={exists ? tr('driverJarExists') : tr('driverJarMissing')}>{exists ? '✓' : '⚠'}</span>
                                <span style={{ width: 14, color: isMaven ? '#d97757' : (isLicense ? '#9cdcfe' : '#bbb'), fontWeight: 700, textAlign: 'center', fontSize: 12 }}
                                  title={isMaven ? 'Maven artifact' : (isLicense ? 'License/Text' : 'Local JAR')}>
                                  {isMaven ? '/' : (isLicense ? 'T' : '▢')}
                                </span>
                                {/* 내용 표시/편집 */}
                                {isEditing ? (
                                  <input autoFocus value={j}
                                    onClick={e => e.stopPropagation()}
                                    onChange={e => { const nx = draft.jars.slice(); nx[idx] = e.target.value; setDraft({ ...draft, jars: nx }); }}
                                    onBlur={() => setEditingJarIdx(-1)}
                                    onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); setEditingJarIdx(-1); } }}
                                    style={{ ...inputStyle, flex: 1, padding: '2px 6px', fontSize: 11 }}
                                  />
                                ) : isMaven && meta.kind === 'maven' ? (
                                  <span style={{ flex: 1, color: isSelected ? '#fff' : '#d4d4d4', fontSize: 12, fontFamily: 'monospace' }}>
                                    <span style={{ color: '#9cdcfe' }}>{meta.group}</span>
                                    <span style={{ color: '#888' }}>:</span>
                                    <span style={{ color: '#dcdcaa' }}>{meta.artifact}</span>
                                    <span style={{ color: '#888' }}>:RELEASE </span>
                                    <span style={{ color: '#888' }}>[{meta.version}{meta.classifier ? '.' + meta.classifier : ''}]</span>
                                  </span>
                                ) : (() => {
                                  // 로컬 jar: 저장된 토큰 형식(${userJdbc}/...) 대신 실제 해석 경로를 보여준다.
                                  const display = (j.replace('${userJdbc}', roots.user || '${userJdbc}')
                                                    .replace('${bundled}', roots.bundled || '${bundled}'));
                                  return (
                                    <span style={{ flex: 1, color: isSelected ? '#fff' : '#d4d4d4', fontSize: 12, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                      title={j !== display ? `${j} → ${display}` : j}
                                    >{display}</span>
                                  );
                                })()}
                              </div>
                              {/* Expanded child — resolved JAR 파일명 */}
                              {isMaven && expanded && (() => {
                                const p = resolvedPathFor(idx);
                                if (!p) return null;
                                const fname = p.split(/[\\/]/).pop() || p;
                                return (
                                  <div style={{ padding: '2px 4px 2px 36px', color: '#9cdcfe', fontSize: 11, fontFamily: 'monospace' }}>
                                    📦 {fname}
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })}
                        {/* Classpath (resolved) */}
                        {draft.diag && (
                          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #333', fontSize: 11, fontFamily: 'monospace', color: '#888' }}>
                            <div style={{ marginBottom: 4, color: '#9cdcfe' }}>Classpath (resolved):</div>
                            {(draft.diag.existing || []).map((p, i) => (<div key={i} style={{ color: '#5fb55f' }}>✓ {p}</div>))}
                            {(draft.diag.missing  || []).map((p, i) => (<div key={i} style={{ color: '#e07050' }}>⚠ {p} {tr('driverNotFoundSuffix')}</div>))}
                          </div>
                        )}
                      </div>
                      {/* 우측: 버튼 컬럼 (DBeaver 처럼) */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 130, flexShrink: 0 }}>
                        <button onClick={handleImportJar} style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '5px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>Add File</button>
                        <button onClick={handleAddFolder} style={{ background: '#3a5a7d', color: '#fff', border: 0, padding: '5px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>Add Folder</button>
                        <button onClick={() => setArtifactModal({ group: '', artifact: '', version: '' })} style={{ background: '#7d5a3a', color: '#fff', border: 0, padding: '5px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>Add Artifact</button>
                        <button onClick={() => hasSel && setEditingJarIdx(sel)} disabled={!hasSel} style={{ background: hasSel ? '#444' : '#333', color: hasSel ? '#fff' : '#666', border: 0, padding: '5px 10px', borderRadius: 3, cursor: hasSel ? 'pointer' : 'not-allowed', fontSize: 12 }}>Edit ...</button>
                        <button onClick={() => { if (!hasSel) return; setDraft({ ...draft, jars: draft.jars.filter((_, i) => i !== sel) }); setSelectedJarIdx(-1); }} disabled={!hasSel} style={{ background: hasSel ? '#5a1d1d' : '#333', color: hasSel ? '#fff' : '#666', border: 0, padding: '5px 10px', borderRadius: 3, cursor: hasSel ? 'pointer' : 'not-allowed', fontSize: 12 }}>Delete</button>
                        <div style={{ height: 8 }} />
                        <button onClick={handleDownloadLibraries} disabled={testing} style={{ background: '#0e639c', color: '#fff', border: 0, padding: '5px 10px', borderRadius: 3, cursor: testing ? 'wait' : 'pointer', fontSize: 12 }}>Download/Update</button>
                        <button onClick={() => draft && setDraft({ ...draft, jars: [...draft.jars, '${userJdbc}/'] })} style={{ background: '#444', color: '#ddd', border: 0, padding: '5px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>{tr('driverEmptyEntry')}</button>
                        <div style={{ height: 8 }} />
                        <button
                          onClick={async () => {
                            if (!draft) return;
                            // 사용자 오버라이드 제거 → 빌트인 정의 복원 (DBeaver "Reset to Defaults")
                            const r = await apiAny.jdbcRemoveDriver?.(draft.id);
                            if (r?.success) { await reload(); setSelectedId(draft.id); }
                            else showErr(tr('driverResetFailed'), r?.error || '?');
                          }}
                          title={tr('driverResetTitle')}
                          style={{ background: '#5a3d1d', color: '#fff', border: 0, padding: '5px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
                        >Reset to Defaults</button>
                      </div>
                    </div>
                  );
                })()}
                {tab === 'properties' && (
                  <PropertyEditor
                    title={tr('driverPropsEditorTitle')}
                    map={draft.properties || {}}
                    onChange={m => setDraft({ ...draft, properties: m })}
                  />
                )}
                {tab === 'advanced' && (
                  <PropertyEditor
                    title={tr('driverAdvancedEditorTitle')}
                    map={draft.meta || {}}
                    onChange={m => setDraft({ ...draft, meta: m })}
                  />
                )}
              </div>
              {/* 액션 바 */}
              <div style={{ padding: '8px 14px', borderTop: '1px solid #333', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={handleSave} disabled={!isDirty}
                  style={{ background: isDirty ? '#0e639c' : '#444', color: '#fff', border: 0, padding: '6px 14px', borderRadius: 3, cursor: isDirty ? 'pointer' : 'not-allowed', fontSize: 12 }}
                >💾 {tr('driverSave')}</button>
                <button onClick={handleTestLoad} disabled={testing}
                  style={{ background: '#3a7d3a', color: '#fff', border: 0, padding: '6px 14px', borderRadius: 3, cursor: testing ? 'wait' : 'pointer', fontSize: 12 }}
                >🧪 {tr('driverTestLoad')}</button>
                {testMsg && (
                  <span style={{ color: testMsg.startsWith('✅') ? '#5fb55f' : ((testMsg.startsWith('❌') || testMsg.startsWith('⚠')) ? '#fcc' : '#bbb'), fontSize: 12, fontFamily: 'monospace' }}>
                    {testMsg}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: '#888', fontSize: 10, fontFamily: 'monospace' }}>
                  user: <span style={{ color: '#9cdcfe' }}>{roots.user}</span>
                </span>
              </div>
            </>)}
          </div>
        </div>

        <div style={{ padding: '8px 14px', borderTop: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => {
              setConfirmModal({
                title: tr('driverSidecarRestartTitle'),
                message: tr('driverSidecarRestartConfirm'),
                onOk: async () => {
                  const r: any = await apiAny.jdbcRestartSidecar?.();
                  if (r?.success) {
                    showOk(tr('driverSidecarRestartOk'), tr('driverSidecarRestartInfo', { version: r.result?.version, javaVersion: r.result?.javaVersion }));
                    await reload();
                  } else {
                    showErr(tr('driverSidecarRestartFailed'), r?.error || '?');
                  }
                },
              });
            }}
            title={tr('driverSidecarRestartBtnTitle')}
            style={{ background: '#5a3d1d', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
          >🔄 {tr('driverSidecarRestart')}</button>
          <button
            onClick={onClose}
            style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
          >{tr('driverClose')}</button>
        </div>
      </div>
      {/* Maven artifact 입력 모달 */}
      {artifactModal && (
        <div onClick={() => !downloading && setArtifactModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 6000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#252526', color: '#d4d4d4', borderRadius: 6, padding: 20, width: 460, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
            <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>📦 {tr('driverMavenArtifactAdd')}</div>
            <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>{tr('driverMavenArtifactDesc')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'center' }}>
              <label style={{ fontSize: 12, color: '#bbb' }}>Group ID</label>
              <input autoFocus value={artifactModal.group} onChange={e => setArtifactModal({ ...artifactModal, group: e.target.value })} placeholder={tr('driverGroupIdPlaceholder')} style={inputStyle} />
              <label style={{ fontSize: 12, color: '#bbb' }}>Artifact ID</label>
              <input value={artifactModal.artifact} onChange={e => setArtifactModal({ ...artifactModal, artifact: e.target.value })} placeholder={tr('driverArtifactIdPlaceholder')} style={inputStyle} />
              <label style={{ fontSize: 12, color: '#bbb' }}>Version</label>
              <input value={artifactModal.version} onChange={e => setArtifactModal({ ...artifactModal, version: e.target.value })} placeholder={tr('driverVersionPlaceholder')} style={inputStyle} />
            </div>
            {(artifactModal.group && artifactModal.artifact && artifactModal.version) && (
              <div style={{ marginTop: 10, padding: 8, background: '#1a1a1a', border: '1px solid #333', borderRadius: 3, fontSize: 10, color: '#888', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {`https://repo1.maven.org/maven2/${artifactModal.group.replace(/\./g, '/')}/${artifactModal.artifact}/${artifactModal.version}/${artifactModal.artifact}-${artifactModal.version}.jar`}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button onClick={() => setArtifactModal(null)} disabled={downloading}
                style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: downloading ? 'not-allowed' : 'pointer', fontSize: 12 }}
              >{tr('driverCancel')}</button>
              <button onClick={handleDownloadArtifact} disabled={downloading || !artifactModal.group || !artifactModal.artifact || !artifactModal.version}
                style={{ background: downloading ? '#555' : '#0e639c', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: downloading ? 'wait' : 'pointer', fontSize: 12 }}
              >{downloading ? tr('driverDownloading') : tr('driverDownload')}</button>
            </div>
          </div>
        </div>
      )}
      {/* 정보/성공/에러 알림 모달 — alert() 대체 */}
      {infoModal && (
        <div onClick={() => setInfoModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 6200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#252526', color: '#d4d4d4', borderRadius: 6, padding: 16, minWidth: 360, maxWidth: '60vw', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13, color: infoModal.kind === 'error' ? '#fcc' : infoModal.kind === 'success' ? '#bef5be' : '#9cdcfe' }}>
              {infoModal.kind === 'error' ? '✗ ' : infoModal.kind === 'success' ? '✓ ' : 'ℹ '} {infoModal.title}
            </div>
            <div style={{ fontSize: 12, color: '#bbb', whiteSpace: 'pre-wrap', fontFamily: 'monospace', maxHeight: 320, overflowY: 'auto' }}>{infoModal.message}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button autoFocus onClick={() => setInfoModal(null)}
                style={{ background: '#0e639c', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >{tr('driverOk')}</button>
            </div>
          </div>
        </div>
      )}
      {/* 확인 모달 — confirm() 대체 */}
      {confirmModal && (
        <div onClick={() => setConfirmModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 6300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#252526', color: '#d4d4d4', borderRadius: 6, padding: 16, minWidth: 380, maxWidth: '60vw', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
            <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13 }}>{confirmModal.title}</div>
            <div style={{ fontSize: 12, color: '#bbb', marginBottom: 14, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>{confirmModal.message}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button autoFocus onClick={() => setConfirmModal(null)}
                style={{ background: '#444', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >{tr('driverCancel')}</button>
              <button onClick={() => { const ok = confirmModal.onOk; setConfirmModal(null); ok(); }}
                style={{ background: '#c0392b', color: '#fff', border: 0, padding: '5px 14px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}
              >{tr('driverOk')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
