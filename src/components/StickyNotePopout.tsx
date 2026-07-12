// src/components/StickyNotePopout.tsx
// 포스트잇 — 화면 어디든 붙일 수 있는 독립 창(BrowserWindow) 전용 렌더 진입점.
// electron/main.ts 가 '#sticky-note?id=<id>' 해시로 이 창을 로드한다.
import React, { useEffect, useRef, useState } from 'react';

const StickyNotePopout: React.FC<{ noteId: string }> = ({ noteId }) => {
  const editableRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const note = await (window as any).api?.stickyNoteGet?.(noteId);
        if (note && editableRef.current) editableRef.current.innerHTML = note.html || '';
      } catch {}
      setLoaded(true);
    })();
  }, [noteId]);

  useEffect(() => {
    const api = (window as any).api;
    api?.windowIsMaximized?.().then((m: boolean) => setMaximized(!!m)).catch(() => {});
    const unsub = api?.onWindowMaximized?.((m: boolean) => setMaximized(m));
    return () => { try { unsub?.(); } catch {} };
  }, []);

  // 최소화 — OS 최소화 대신 창을 숨기고 메인 앱 창의 우측 사이드바에서 관리한다.
  // (skipTaskbar 라 OS 최소화로는 작업표시줄에도 안 잡혀 복구할 방법이 없었음)
  const handleMinimize = () => { try { (window as any).api?.stickyNoteMinimizeToSidebar?.(noteId); } catch {} };
  const handleToggleMaximize = () => { try { (window as any).api?.windowToggleMaximize?.(); } catch {} };

  const scheduleSave = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const html = editableRef.current?.innerHTML || '';
      try { (window as any).api?.stickyNoteUpdateContent?.(noteId, html); } catch {}
    }, 400);
  };

  const insertImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = document.createElement('img');
      img.src = String(reader.result || '');
      img.style.maxWidth = '100%';
      img.style.display = 'block';
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editableRef.current?.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        range.insertNode(img);
      } else {
        editableRef.current?.appendChild(img);
      }
      scheduleSave();
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) insertImageFile(file);
        return;
      }
    }
    // 순수 텍스트는 기본 붙여넣기 동작에 맡김 (서식 없는 붙여넣기로 강제)
    const text = e.clipboardData?.getData('text/plain');
    if (text != null) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
      scheduleSave();
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      Array.from(files).forEach(f => { if (f.type.startsWith('image/')) insertImageFile(f); });
    }
  };

  const handleDelete = () => {
    try { (window as any).api?.stickyNoteDelete?.(noteId); } catch {}
  };

  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
      background: '#fff6a8', border: '1px solid #d8c95a', borderRadius: 8,
      boxSizing: 'border-box', overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
    }}>
      <div
        // 이 바를 드래그하면 창 전체가 화면 어디로든 이동 (Electron 의 -webkit-app-region)
        style={{
          WebkitAppRegion: 'drag' as any,
          height: 30, minHeight: 30, boxSizing: 'border-box', flex: '0 0 30px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          padding: '0 6px', background: 'rgba(0,0,0,0.06)', cursor: 'move', gap: 4,
        } as React.CSSProperties}
      >
        <button
          onClick={handleMinimize}
          title="최소화"
          style={{
            WebkitAppRegion: 'no-drag' as any,
            flex: '0 0 auto', width: 22, height: 22, lineHeight: '22px', textAlign: 'center', padding: 0,
            border: 'none', borderRadius: 4, background: 'rgba(0,0,0,0.12)', color: '#3a3320',
            cursor: 'pointer', fontSize: 12, fontWeight: 700,
          } as React.CSSProperties}
        >
          &#8211;
        </button>
        <button
          onClick={handleToggleMaximize}
          title={maximized ? '이전 크기로' : '최대화'}
          style={{
            WebkitAppRegion: 'no-drag' as any,
            flex: '0 0 auto', width: 22, height: 22, lineHeight: '22px', textAlign: 'center', padding: 0,
            border: 'none', borderRadius: 4, background: 'rgba(0,0,0,0.12)', color: '#3a3320',
            cursor: 'pointer', fontSize: 11, fontWeight: 700,
          } as React.CSSProperties}
        >
          {maximized ? '❐' : '□'}
        </button>
        <button
          onClick={handleDelete}
          title="삭제"
          style={{
            WebkitAppRegion: 'no-drag' as any,
            flex: '0 0 auto', width: 22, height: 22, lineHeight: '22px', textAlign: 'center', padding: 0,
            border: 'none', borderRadius: 4, background: 'rgba(0,0,0,0.12)', color: '#3a3320',
            cursor: 'pointer', fontSize: 12, fontWeight: 700,
          } as React.CSSProperties}
        >
          🗑️
        </button>
      </div>
      <div
        ref={editableRef}
        contentEditable={loaded}
        suppressContentEditableWarning
        onInput={scheduleSave}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={e => e.preventDefault()}
        style={{
          flex: 1, minHeight: 0, minWidth: 0, boxSizing: 'border-box', overflowY: 'auto', overflowX: 'hidden', padding: '10px 12px',
          color: '#3a3320', fontSize: 14, lineHeight: 1.5, outline: 'none',
          wordBreak: 'break-word', overflowWrap: 'anywhere', WebkitAppRegion: 'no-drag' as any,
        } as React.CSSProperties}
      />
    </div>
  );
};

export default StickyNotePopout;
