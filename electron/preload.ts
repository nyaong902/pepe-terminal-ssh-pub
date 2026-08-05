// electron/preload.ts — updated with folder support
import { contextBridge, ipcRenderer } from 'electron';

// ── rhwp-studio 브리지 (webview 게스트에서만 동작) ──────────────────────────────────
// 한글 편집기는 rhwp-studio 페이지와 postMessage 로 통신한다(@rhwp/editor 가 하던 일).
// 예전에는 iframe 이라 부모가 contentWindow.postMessage 로 바로 보냈지만, 메모리를 프로세스째
// 회수하려고 <webview> 로 바꾸면서 그 통로가 끊겼다 — webview 게스트에서 window.parent 는
// 자기 자신이라, 스튜디오가 보내는 응답이 호스트에 닿지 않는다.
//
// 그래서 이 preload 가 양쪽을 잇는다:
//   호스트 -> webview.send('rhwp-request')  -> window.postMessage  -> 스튜디오
//   스튜디오 -> window.parent.postMessage(= 자기 window) -> sendToHost('rhwp-response') -> 호스트
// 이 preload 는 앱 본체에도 쓰이므로, rhwp-studio 페이지일 때만 브리지를 켠다.
try {
  if (location.pathname.includes('/rhwp-studio/')) {
    console.log('[rhwp-bridge] 부착됨', location.pathname);
    ipcRenderer.on('rhwp-request', (_e, payload) => {
      try { window.postMessage(payload, '*'); } catch {}
    });
    window.addEventListener('message', (e) => {
      const d: any = e.data;
      if (d && d.type === 'rhwp-response') {
        try { ipcRenderer.sendToHost('rhwp-response', d); } catch {}
      }
    });
  }
} catch {}

// ── draw.io(flowchart-editor) 브리지 (webview 게스트에서만 동작) ──────────────────────
// rhwp 와 같은 이유로 <webview> 로 바꿨다(iframe 은 같은 프로세스라 닫아도 메모리가 안 돌아온다).
// draw.io 임베드 프로토콜은 JSON 문자열을 주고받는다:
//   게스트 -> 부모: {"event":"init"|"autosave"|"save"|"load", ...}
//   부모 -> 게스트: {"action":"load", ...}
// webview 에서는 window.parent 가 자기 자신이므로 이 preload 가 양쪽을 잇는다.
//
// 주의: 우리가 window.postMessage 로 게스트에 넣은 메시지를 다시 호스트로 되돌리면 메아리가 된다.
// 방향을 내용으로 구분한다 — 게스트가 보내는 것에는 event 가 있고, 호스트가 보내는 것에는 action 만 있다.
try {
  // 중계 페이지(flowchart-host.html)가 webview 의 최상위 문서다 — preload 는 여기서 돈다.
  if (location.pathname.includes('flowchart-host.html') || location.pathname.includes('/flowchart-editor/')) {
    console.log('[drawio-bridge] 부착됨', location.pathname);
    ipcRenderer.on('drawio-to-guest', (_e, payload: string) => {
      try { window.postMessage(payload, '*'); } catch {}
    });
    window.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      let d: any;
      try { d = JSON.parse(e.data); } catch { return; }
      if (!d || typeof d.event !== 'string') return;   // 호스트가 보낸 것(action)은 되돌리지 않는다
      try { ipcRenderer.sendToHost('drawio-to-host', e.data); } catch {}
    });
  }
} catch {}

// ── PDF 뷰어(pdf-host.html) 브리지 (webview 게스트에서만 동작) ────────────────────────
// draw.io/rhwp 와 같은 이유로 PDF 도 <webview> 에서 그린다. 방향은 내용으로 구분한다 —
// 게스트가 보내는 것에는 event, 호스트가 보내는 것에는 method 가 있다(서로 되돌리면 메아리).
try {
  if (location.pathname.includes('pdf-host')) {
    console.log('[pdf-bridge] 부착됨', location.pathname);
    // PDF 는 저장 바이트(ArrayBuffer)를 주고받아야 해서 문자열이 아니라 객체로 넘긴다 —
    // JSON 으로 직렬화하면 ArrayBuffer 가 {} 가 되어 빈 파일이 저장된다.
    ipcRenderer.on('pdf-to-guest', (_e, payload: any) => {
      try { window.postMessage(payload, '*'); } catch {}
    });
    window.addEventListener('message', (e) => {
      const d: any = e.data;
      if (!d || typeof d !== 'object' || typeof d.event !== 'string') return;
      try { ipcRenderer.sendToHost('pdf-to-host', d); } catch {}
    });
  }
} catch {}

contextBridge.exposeInMainWorld('api', {
  // Sessions
  getSessionsPath: () => ipcRenderer.invoke('sessions:path'),
  openSessionsFolder: () => ipcRenderer.invoke('sessions:open-folder'),
  openSessionsEditor: () => ipcRenderer.invoke('sessions:open-editor'),
  setSessionsPath: () => ipcRenderer.invoke('sessions:set-path'),
  resetSessionsPath: () => ipcRenderer.invoke('sessions:reset-path'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveSession: (s: any) => ipcRenderer.invoke('sessions:save', s),
  duplicateSession: (args: { sessionId: string; targetFolderId?: string | null; nameSuffix?: string }) => ipcRenderer.invoke('sessions:duplicate', args),
  deleteSession: (id: string) => ipcRenderer.invoke('sessions:delete', id),
  moveToFolder: (sessionId: string, targetFolderId: string | null) => ipcRenderer.invoke('sessions:move-to-folder', { sessionId, targetFolderId }),
  reorderSession: (id: string, type: 'session' | 'folder', direction: 'up' | 'down' | 'top' | 'bottom') => ipcRenderer.invoke('sessions:reorder', { id, type, direction }),
  dropReorderSession: (id: string, type: 'session' | 'folder', targetParentId: string | null, beforeId?: string | null) => ipcRenderer.invoke('sessions:drop-reorder', { id, type, targetParentId, beforeId }),

  // UI Prefs (config.json 에 저장 — sessionData 멀티인스턴스 분리와 무관하게 영속)
  getUIPrefs: () => ipcRenderer.invoke('ui-prefs:get'),
  setUIPrefs: (prefs: Record<string, any>) => ipcRenderer.invoke('ui-prefs:set', prefs),
  // AI 채팅 기록 — config.json 이 커지지 않게 별도 파일에 저장한다.
  // 터미널 텍스트를 임시 파일로 저장하고 외부 편집기로 열기 (내장 편집기는 렌더러가 자체 처리)
  openInTextEditor: (payload: { text: string; name?: string; target?: 'default' | 'custom'; path?: string; args?: string }) =>
    ipcRenderer.invoke('text-editor:open', payload),
  // <webview> preload 경로 (한글 편집기 브리지용)
  getWebviewPreloadUrl: () => ipcRenderer.invoke('app:webview-preload-url'),
  // 브라우저 워크스페이스를 닫을 때 그 파티션의 캐시/스토리지를 비운다(메모리 회수).
  releaseBrowserPartition: (partition: string) => ipcRenderer.invoke('browser:release-partition', partition),
  getChatHistory: () => ipcRenderer.invoke('chat-history:get'),
  setChatHistory: (entries: any[]) => ipcRenderer.invoke('chat-history:set', entries),
  // 작업일지 — 앱 전체에서 공유되는 일별 todo 저장소 (worklog.json)
  worklogGetAll: () => ipcRenderer.invoke('worklog:get-all'),
  worklogSaveDay: (date: string, day: { todos: any[] }) => ipcRenderer.invoke('worklog:save-day', { date, day }),
  onWorklogEvent: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('worklog:event', handler);
    return () => ipcRenderer.removeListener('worklog:event', handler);
  },
  // 작업일지 알람 — main 프로세스가 1분마다 스캔해 도달한 알람을 여기로 push.
  onWorklogReminder: (cb: (p: { date: string; todo: any }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('worklog:reminder', handler);
    return () => ipcRenderer.removeListener('worklog:reminder', handler);
  },
  // 포스트잇 — 화면 어디든 붙일 수 있는 독립 창 (stickyNotes.json)
  stickyNoteCreate: () => ipcRenderer.invoke('sticky-note:create'),
  stickyNoteGet: (id: string) => ipcRenderer.invoke('sticky-note:get', id),
  stickyNoteUpdateContent: (id: string, html: string) => ipcRenderer.invoke('sticky-note:update-content', { id, html }),
  stickyNoteDelete: (id: string) => ipcRenderer.invoke('sticky-note:delete', id),
  stickyNoteMinimizeToSidebar: (id: string) => ipcRenderer.invoke('sticky-note:minimize-to-sidebar', id),
  stickyNoteFocus: (id: string) => ipcRenderer.invoke('sticky-note:focus', id),
  stickyNoteGetList: () => ipcRenderer.invoke('sticky-note:get-list'),
  onStickyNoteList: (cb: (list: { id: string; html: string; updatedAt: number; minimized: boolean }[]) => void) => {
    const listener = (_e: any, list: any[]) => cb(list);
    ipcRenderer.on('sticky-note:list', listener);
    return () => ipcRenderer.removeListener('sticky-note:list', listener);
  },
  // 시계 위젯(스위스 철도 시계 + 뽀모도로 타이머) — 단일 인스턴스 독립 창 (clockWidget.json)
  clockWidgetToggle: () => ipcRenderer.invoke('clock-widget:toggle'),
  clockWidgetGetState: () => ipcRenderer.invoke('clock-widget:get-state'),
  clockWidgetSetTimer: (endTime: number | null, totalMs: number | null) => ipcRenderer.invoke('clock-widget:set-timer', { endTime, totalMs }),
  clockWidgetClose: () => ipcRenderer.invoke('clock-widget:close'),
  onClockWidgetVisibility: (cb: (visible: boolean) => void) => {
    const listener = (_e: any, visible: boolean) => cb(visible);
    ipcRenderer.on('clock-widget:visibility', listener);
    return () => ipcRenderer.removeListener('clock-widget:visibility', listener);
  },
  // main 프로세스의 네이티브 Notification 모듈로 OS 알림을 띄운다 — 렌더러의 Web Notification API
  // 보다 Windows 에서 훨씬 신뢰성 있게 뜬다(타이머 종료 알림 등).
  notifyShow: (title: string, body: string) => ipcRenderer.invoke('notify:show', { title, body }),
  // 뽀모도로 타이머 종료 — 위젯 창에서 호출하면 메인 앱 창에 화면 중앙 팝업을 띄운다.
  clockWidgetNotifyDone: (totalMs: number | null) => ipcRenderer.invoke('clock-widget:notify-done', { totalMs }),
  onClockWidgetTimerDone: (cb: (p: { totalMs: number | null; ts: number }) => void) => {
    const listener = (_e: any, p: any) => cb(p);
    ipcRenderer.on('clock-widget:timer-done', listener);
    return () => ipcRenderer.removeListener('clock-widget:timer-done', listener);
  },
  shellOpenExternal: (url: string) => ipcRenderer.invoke('shell:open-external', { url }),
  // 윈도우 테마 — 저장 + 모든 창(메인/팝아웃/분리)에 변경 브로드캐스트
  setWindowTheme: (id: string) => ipcRenderer.invoke('window-theme:set', id),
  onWindowTheme: (cb: (id: string) => void) => {
    const handler = (_e: any, id: string) => cb(id);
    ipcRenderer.on('window-theme:changed', handler);
    return () => ipcRenderer.removeListener('window-theme:changed', handler);
  },

  // 폰 미러링 QR 페어링 — 모바일 앱이 callbackUrl 로 POST 할 수 있도록 임시 LAN 서버를 띄운다.
  plainAppStart: () => ipcRenderer.invoke('plainapp:start'),
  plainAppState: () => ipcRenderer.invoke('plainapp:state'),
  plainAppStop: () => ipcRenderer.invoke('plainapp:stop'),
  // 서버(포트/네트워크 인터페이스 목록)는 그대로 두고 requestId 만 새로 발급 — QR 코드만
  // 갱신되고 IP 목록 화면은 깜빡이지 않는다.
  plainAppResetRequest: () => ipcRenderer.invoke('plainapp:reset-request'),
  onPlainAppEvent: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('plainapp:event', handler);
    return () => ipcRenderer.removeListener('plainapp:event', handler);
  },

  // PePe Messenger
  messengerStart: (prefs?: any) => ipcRenderer.invoke('messenger:start', prefs),
  messengerStop: () => ipcRenderer.invoke('messenger:stop'),
  messengerGetState: () => ipcRenderer.invoke('messenger:get-state'),
  messengerUpdatePrefs: (prefs: any) => ipcRenderer.invoke('messenger:update-prefs', prefs),
  messengerSendMessage: (peerId: string, text: string) => ipcRenderer.invoke('messenger:send-message', { peerId, text }),
  messengerSendWorklogShare: (peerId: string, share: any) => ipcRenderer.invoke('messenger:send-worklog-share', { peerId, share }),
  messengerRespondWorklogShare: (peerId: string, messageId: string, decision: 'accepted' | 'rejected') => ipcRenderer.invoke('messenger:respond-worklog-share', { peerId, messageId, decision }),
  messengerMarkRead: (peerId: string, messageId: string) => ipcRenderer.invoke('messenger:mark-read', { peerId, messageId }),
  messengerRecallMessage: (peerId: string, messageId: string) => ipcRenderer.invoke('messenger:recall-message', { peerId, messageId }),
  messengerSaveFileAs: (args: { filePath: string; fileName?: string; peerId?: string; messageId?: string }): Promise<{ success: boolean; filePath?: string; canceled?: boolean; error?: string }> => ipcRenderer.invoke('messenger:save-file-as', args),
  messengerSendFiles: (peerId: string) => ipcRenderer.invoke('messenger:send-files', { peerId }),
  messengerPickFiles: () => ipcRenderer.invoke('messenger:pick-files'),
  messengerSendFilePaths: (peerId: string, files: { path: string; name?: string }[]) => ipcRenderer.invoke('messenger:send-file-paths', { peerId, files }),
  messengerSendStickerPaths: (peerId: string, filePaths: string[]) => ipcRenderer.invoke('messenger:send-sticker-paths', { peerId, filePaths }),
  messengerOpenEmoticonFolder: () => ipcRenderer.invoke('messenger:open-emoticon-folder'),
  messengerSendRemoteFiles: (peerId: string, connId: string, remotePaths: string[]) => ipcRenderer.invoke('messenger:send-remote-files', { peerId, connId, remotePaths }),
  messengerScanRange: (prefix?: string) => ipcRenderer.invoke('messenger:scan-range', { prefix }),
  messengerDeleteConversation: (peerId: string) => ipcRenderer.invoke('messenger:delete-conversation', { peerId }),
  messengerDeletePeer: (peerId: string) => ipcRenderer.invoke('messenger:delete-peer', { peerId }),
  messengerClearAll: () => ipcRenderer.invoke('messenger:clear-all'),
  messengerClearPeers: () => ipcRenderer.invoke('messenger:clear-peers'),
  onMessengerEvent: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('messenger:event', handler);
    return () => ipcRenderer.removeListener('messenger:event', handler);
  },

  // Folders
  saveFolder: (f: any) => ipcRenderer.invoke('folders:save', f),
  deleteFolder: (id: string) => ipcRenderer.invoke('folders:delete', id),

  // Export/Import
  exportSessions: () => ipcRenderer.invoke('sessions:export'),
  importSessions: () => ipcRenderer.invoke('sessions:import'),
  sessionsClear: () => ipcRenderer.invoke('sessions:clear'),
  sessionsReplaceAll: (data: any) => ipcRenderer.invoke('sessions:replace-all', data),

  // File Explorer
  feListDir: (mode: string, dirPath: string, termId?: string, encoding?: string) => ipcRenderer.invoke('fe:list-dir', { mode, termId, dirPath, encoding }),
  feGetDrives: () => ipcRenderer.invoke('fe:get-drives'),
  feGetFileIcon: (filePath: string, size?: 'small' | 'normal' | 'large') => ipcRenderer.invoke('fe:get-file-icon', { filePath, size }),
  feGetFileIconsBatch: (filePaths: string[]) => ipcRenderer.invoke('fe:get-file-icons-batch', { filePaths }),
  feGetIconsByExt: (exts: string[], isDir?: boolean) => ipcRenderer.invoke('fe:get-icons-by-ext', { exts, isDir }),
  feGetHome: () => ipcRenderer.invoke('fe:get-home'),
  feTransfer: (src: any, dst: any, filename: string, workspaceId?: string) => ipcRenderer.invoke('fe:transfer', { src, dst, filename, workspaceId }),
  onFeTransferDone: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('fe:transfer-done', handler);
    return () => ipcRenderer.removeListener('fe:transfer-done', handler);
  },
  onFeDeleteDone: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('fe:delete-done', handler);
    return () => ipcRenderer.removeListener('fe:delete-done', handler);
  },
  onSFTPDirList: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:dir-list', handler);
    return () => ipcRenderer.removeListener('sftp:dir-list', handler);
  },
  onSFTPDeleteStart: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:delete-start', handler);
    return () => ipcRenderer.removeListener('sftp:delete-start', handler);
  },
  onSFTPDeleteProgress: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:delete-progress', handler);
    return () => ipcRenderer.removeListener('sftp:delete-progress', handler);
  },
  onSFTPDeleteComplete: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:delete-complete', handler);
    return () => ipcRenderer.removeListener('sftp:delete-complete', handler);
  },
  feMkdir: (mode: string, dirPath: string, termId?: string) => ipcRenderer.invoke('fe:mkdir', { mode, termId, dirPath }),
  feCreateFile: (mode: string, filePath: string, termId?: string) => ipcRenderer.invoke('fe:create-file', { mode, termId, filePath }),
  feDelete: (mode: string, filePath: string, termId?: string, workspaceId?: string) => ipcRenderer.invoke('fe:delete', { mode, termId, filePath, workspaceId }),
  feRename: (mode: string, oldPath: string, newPath: string, termId?: string) => ipcRenderer.invoke('fe:rename', { mode, termId, oldPath, newPath }),
  feHomeDir: (mode: string, termId?: string) => ipcRenderer.invoke('fe:home-dir', { mode, termId }),
  feSftpConnect: (connId: string, host: string, port: number, username: string, auth?: any, jumpOpts?: { host: string; user?: string; port?: number; password?: string }, jumps?: { host: string; user?: string; port?: number; password?: string }[]) => ipcRenderer.invoke('fe:sftp-connect', { connId, host, port, username, auth, jumpOpts, jumps }),
  pickFiles: (multi?: boolean) => ipcRenderer.invoke('dialog:pick-files', { multi }),
  pickFolder: () => ipcRenderer.invoke('dialog:pick-folder'),
  feSftpDisconnect: (connId: string) => ipcRenderer.invoke('fe:sftp-disconnect', { connId }),
  // ClearCase 뷰 루트/SFTP 채널 진단 로그 토글 (기본 꺼짐) — 필요할 때만 devtools 에서 켠다
  setSftpDebugLog: (on: boolean) => ipcRenderer.invoke('fe:set-sftp-debug-log', on),
  feGetViewRoot: (termId: string) => ipcRenderer.invoke('fe:get-view-root', { termId }),
  feSetViewRoot: (termId: string, root: string) => ipcRenderer.invoke('fe:set-view-root', { termId, root }),
  feReleaseSftp: (panelId: string) => ipcRenderer.invoke('fe:release-sftp', { panelId }),
  sqlExec: (connId: string, command: string, timeoutMs?: number) => ipcRenderer.invoke('sql:exec', { connId, command, timeoutMs }),
  sqlSaveCsv: (defaultName: string, content: string) => ipcRenderer.invoke('sql:save-csv', { defaultName, content }),
  // JDBC 사이드카 진단 — Java 프로세스 ping. 성공 시 { success, result:{version,javaVersion,...}, jar, java }
  jdbcPing: () => ipcRenderer.invoke('jdbc:ping'),
  // 사이드카 JVM 재시작 — JAR 업데이트 후 새 코드 적용용. 모든 활성 JDBC 연결 끊김.
  jdbcRestartSidecar: () => ipcRenderer.invoke('jdbc:restart-sidecar'),
  // Driver Manager (DBeaver 스타일).
  jdbcListDrivers: () => ipcRenderer.invoke('jdbc:list-drivers'),
  jdbcSaveDriver: (def: any) => ipcRenderer.invoke('jdbc:save-driver', def),
  jdbcRemoveDriver: (id: string) => ipcRenderer.invoke('jdbc:remove-driver', id),
  jdbcDriverRoots: () => ipcRenderer.invoke('jdbc:driver-roots'),
  jdbcPickAndImportJar: () => ipcRenderer.invoke('jdbc:pick-and-import-jar'),
  jdbcResolveJars: (def: any) => ipcRenderer.invoke('jdbc:resolve-jars', def),
  // 사이드카 정식 RPC 래퍼. 모두 { success, result|error } 반환.
  jdbcLoadDriver: (def: any) => ipcRenderer.invoke('jdbc:load-driver', def),
  jdbcConnect: (args: { connectionId: string; driver: any; url: string; user?: string; password?: string; props?: Record<string,string> }) =>
    ipcRenderer.invoke('jdbc:connect', args),
  jdbcIsConnected: (connectionId: string) => ipcRenderer.invoke('jdbc:is-connected', connectionId),
  jdbcDisconnect: (connectionId: string) => ipcRenderer.invoke('jdbc:disconnect', connectionId),
  jdbcExec: (args: { connectionId: string; sql: string; maxRows?: number }) => ipcRenderer.invoke('jdbc:exec', args),
  jdbcTxBegin: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:tx-begin', args),
  jdbcTxCommit: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:tx-commit', args),
  jdbcTxRollback: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:tx-rollback', args),
  jdbcAltibaseExplain: (args: { connectionId: string; sql: string }) => ipcRenderer.invoke('jdbc:altibase-explain', args),
  jdbcPickAndImportFolder: () => ipcRenderer.invoke('jdbc:pick-and-import-folder'),
  jdbcDownloadMavenArtifact: (args: { groupId: string; artifactId: string; version: string }) =>
    ipcRenderer.invoke('jdbc:download-maven-artifact', args),
  jdbcDownloadDriverLibraries: (def: any) => ipcRenderer.invoke('jdbc:download-driver-libraries', def),
  sshOpenLocalForward: (args: { sessionId: string; remoteHost: string; remotePort: number }) =>
    ipcRenderer.invoke('ssh:open-local-forward', args),
  sshCloseLocalForward: (args: { forwardId: string }) =>
    ipcRenderer.invoke('ssh:close-local-forward', args),
  // 활성 터미널 없이 세션의 점프 체인으로(또는 SQL Tool 독립 세션의 자체 sshConn 으로)
  // 백그라운드 SSH 연결 후 DB 포트 포워딩
  sshOpenDedicatedForward: (args: { sessionId?: string; remoteHost: string; remotePort: number; sshConn?: { host: string; port?: number; username: string; auth?: any } }) =>
    ipcRenderer.invoke('ssh:open-dedicated-forward', args),
  sshCloseDedicatedForward: (args: { forwardId?: string; connId?: string }) =>
    ipcRenderer.invoke('ssh:close-dedicated-forward', args),
  sshListActiveSessions: () => ipcRenderer.invoke('ssh:list-active-sessions'),
  sshOpenSocksProxy: (args: { panelId: string }) => ipcRenderer.invoke('ssh:open-socks-proxy', args),
  sshCloseSocksProxy: (args: { proxyId: string }) => ipcRenderer.invoke('ssh:close-socks-proxy', args),
  // 활성 터미널 없이 세션의 점프 체인으로 백그라운드 SSH 연결 후 SOCKS 프록시 (브라우저)
  sshOpenDedicatedSocks: (args: { sessionId: string }) => ipcRenderer.invoke('ssh:open-dedicated-socks', args),
  sshCloseDedicatedSocks: (args: { proxyId?: string; connId?: string }) => ipcRenderer.invoke('ssh:close-dedicated-socks', args),

  // MicroSIP / SSW 소프트폰 — 네이티브 PJSIP 사이드카 제어. 둘은 독립된 sipd.exe 프로세스라
  // 모든 호출에 engine('microsip'|'ssw', 생략 시 'microsip')을 실어 어느 엔진으로 갈지 지정한다.
  sipEngineStatus: (args?: { engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:engine-status', args),
  sipRegister: (args: { endpoint: any; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:register', args),
  sipUnregister: (args: { endpointId: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:unregister', args),
  sipCall: (args: { endpointId: string; target: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:call', args),
  sipHangup: (args: { endpointId: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:hangup', args),
  sipAnswer: (args: { endpointId: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:answer', args),
  sipReject: (args: { endpointId: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:reject', args),
  sipHold: (args: { endpointId: string; hold: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:hold', args),
  sipCtrTransfer: (args: { endpointId: string; digits: string; number: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:ctr-transfer', args),
  sipMute: (args: { endpointId: string; mute: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:mute', args),
  sipSpeakerMute: (args: { endpointId: string; mute: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:speaker-mute', args),
  sipTransfer: (args: { endpointId: string; target: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:transfer', args),
  sipSendInfo: (args: { endpointId: string; header: string; value: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:send-info', args),
  sipRecord: (args: { endpointId: string; on: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:record', args),
  sipMediaPickFile: (): Promise<string | null> => ipcRenderer.invoke('sip:media-pick-file'),
  sipMediaReadFile: (args: { file: string }): Promise<ArrayBuffer | { error: string }> => ipcRenderer.invoke('sip:media-read-file', args),
  sipMediaWriteTempWav: (args: { data: ArrayBuffer }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('sip:media-write-temp-wav', args),
  sipMediaPlay: (args: { endpointId: string; file: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:media-play', args),
  sipMediaStop: (args: { endpointId: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:media-stop', args),
  sipSendDtmf: (args: { endpointId: string; digit: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:send-dtmf', args),
  sipSetAudioDevices: (args: { input?: string; output?: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:set-audio-devices', args),
  sipSetAccountAudioDevices: (args: { endpointId: string; input?: string; output?: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:set-account-audio-devices', args),
  sipSetAccountVolume: (args: { endpointId: string; mic: number; speaker: number; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:set-account-volume', args),
  sipListAudioDevices: (args?: { engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:list-audio-devices', args),
  sipSetVolume: (args: { mic: number; speaker: number; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:volume', args),
  sipSetDnd: (args: { endpointId: string; dnd: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:dnd', args),
  sipSendIm: (args: { endpointId: string; target: string; text: string; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:im', args),
  sipSetPresence: (args: { endpointId: string; online: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:presence', args),
  sipSubscribePresence: (args: { endpointId: string; target: string; subscribe: boolean; engine?: 'microsip' | 'ssw' }) => ipcRenderer.invoke('sip:subscribe', args),
  onSipEvent: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sip:event', handler);
    return () => ipcRenderer.removeListener('sip:event', handler);
  },

  // MicroSIP 단말별 패킷 캡처 (dumpcap.exe, 로컬 설치 필요 — capture-local-package)
  captureAvailable: () => ipcRenderer.invoke('capture:available'),
  captureListInterfaces: () => ipcRenderer.invoke('capture:list-interfaces'),
  capturePickFolder: () => ipcRenderer.invoke('capture:pick-folder'),
  captureStart: (args: { endpointId: string; label: string; iface: string; dir: string }) => ipcRenderer.invoke('capture:start', args),
  captureStop: (args: { endpointId: string }) => ipcRenderer.invoke('capture:stop', args),
  captureStatus: (args: { endpointId: string }) => ipcRenderer.invoke('capture:status', args),

  // SIPp 워크스페이스 — 네이티브 SIPp 부하 발생기 제어. id 는 탭마다 독립된 인스턴스를
  // 구분하는 워크스페이스 탭 id (여러 SIPp 탭을 동시에 서로 다른 대상으로 돌릴 수 있음).
  sippStatus: (args: { id: string }) => ipcRenderer.invoke('sipp:status', args),
  sippStart: (args: { id: string; opts: any }) => ipcRenderer.invoke('sipp:start', args),
  sippStop: (args: { id: string }) => ipcRenderer.invoke('sipp:stop', args),
  sippSetRate: (args: { id: string; cps: number }) => ipcRenderer.invoke('sipp:set-rate', args),
  sippSetPaused: (args: { id: string; paused: boolean }) => ipcRenderer.invoke('sipp:set-paused', args),
  sippDispose: (args: { id: string }) => ipcRenderer.invoke('sipp:dispose', args),
  sippScenarioList: () => ipcRenderer.invoke('sipp-scenario:list'),
  sippScenarioSave: (args: { id?: string; name: string; mode: 'blocks' | 'xml'; blocksData?: any; rawXml?: string; targetSettings?: any; injectionCsv?: string }) => ipcRenderer.invoke('sipp-scenario:save', args),
  sippScenarioDelete: (args: { id: string }) => ipcRenderer.invoke('sipp-scenario:delete', args),
  onSippEvent: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sipp:event', handler);
    return () => ipcRenderer.removeListener('sipp:event', handler);
  },
  // 오피스 워크스페이스 — 워드/엑셀/파워포인트/PDF 파일 열기 (office-editor iframe 용).
  officeDocOpenFile: (kind: 'hwp' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'drawio') => ipcRenderer.invoke('office-doc:open-file', { kind }),
  officeDocReadFile: (filePath: string) => ipcRenderer.invoke('office-doc:read-file', { filePath }),
  officeDocSaveFile: (args: { data: ArrayBuffer; defaultName?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('office-doc:save-file', args),
  officeRecentsGet: (kind: string) => ipcRenderer.invoke('office-recents:get', { kind }),
  officeRecentsAdd: (kind: string, doc: { filePath: string; fileName: string }) => ipcRenderer.invoke('office-recents:add', { kind, doc }),
  officeRecentsRemove: (kind: string, filePath: string) => ipcRenderer.invoke('office-recents:remove', { kind, filePath }),

  // 미디어 플레이어 — 파일 열기/판별, #!ENC 복호화, 로컬 코덱(wav/alaw/ulaw/raw) 디코딩, 최근 재생 목록.
  mediaOpenFile: () => ipcRenderer.invoke('media:open-file'),
  mediaProbeFile: (filePath: string) => ipcRenderer.invoke('media:probe-file', { filePath }),
  mediaCryptoAvailable: () => ipcRenderer.invoke('media:crypto-available'),
  mediaDecrypt: (filePath: string, password: string) => ipcRenderer.invoke('media:decrypt', { filePath, password }),
  mediaDecodeLocal: (filePath: string, codec: string) => ipcRenderer.invoke('media:decode-local', { filePath, codec }),
  mediaDecodeGstreamer: (filePath: string, codec: string) => ipcRenderer.invoke('media:decode-gstreamer', { filePath, codec }),
  mediaReadVideo: (filePath: string) => ipcRenderer.invoke('media:read-video', { filePath }),
  getAvailableFeatures: (): Promise<{ vpn: boolean; microsip: boolean; sswPhone: boolean; sipp: boolean; office: boolean; media: boolean; cdrTool: boolean; chatArchive: boolean; pepeThing: boolean; pepeBox: boolean }> => ipcRenderer.invoke('features:get-available'),
  mediaRecentsGet: () => ipcRenderer.invoke('media-recents:get'),
  mediaRecentsAdd: (doc: { filePath: string; fileName: string; durationSec?: number; codec?: string }) => ipcRenderer.invoke('media-recents:add', { doc }),
  mediaRecentsRemove: (filePath: string) => ipcRenderer.invoke('media-recents:remove', { filePath }),
  mediaRecentsSetPosition: (filePath: string, positionSec: number) => ipcRenderer.invoke('media-recents:set-position', { filePath, positionSec }),
  mediaPlaylistGet: () => ipcRenderer.invoke('media-playlist:get'),
  mediaPlaylistAdd: (items: { filePath: string; fileName: string; codec?: string }[]) => ipcRenderer.invoke('media-playlist:add', { items }),
  mediaPlaylistRemove: (filePath: string) => ipcRenderer.invoke('media-playlist:remove', { filePath }),
  mediaPlaylistReorder: (orderedFilePaths: string[]) => ipcRenderer.invoke('media-playlist:reorder', { orderedFilePaths }),
  pcapProbeFile: (filePath: string) => ipcRenderer.invoke('pcap:probe-file', { filePath }),
  pcapExtractStream: (filePath: string, streamId: string, forcedCodec?: string, evsFormat?: string) => ipcRenderer.invoke('pcap:extract-stream', { filePath, streamId, forcedCodec, evsFormat }),
  mediaSaveAllCodecs: (args: { wavData: ArrayBuffer; baseFileName: string; excludeCodec: string }) => ipcRenderer.invoke('media:save-all-codecs', args),
  mediaSaveEncryptedAllCodecs: (args: { wavData: ArrayBuffer; baseFileName: string; password: string; version: number }) => ipcRenderer.invoke('media:save-encrypted-all-codecs', args),

  onBrowserWebviewNewWindow: (cb: (p: { guestId: number; url: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('browser-webview:new-window', handler);
    return () => ipcRenderer.removeListener('browser-webview:new-window', handler);
  },
  browserCredGet: (args: { url?: string; siteKey?: string }) => ipcRenderer.invoke('browser-creds:get', args),
  browserCredSave: (args: { url?: string; siteKey?: string; username: string; password: string }) => ipcRenderer.invoke('browser-creds:save', args),
  browserCredDelete: (args: { url?: string; siteKey?: string }) => ipcRenderer.invoke('browser-creds:delete', args),
  browserCredList: () => ipcRenderer.invoke('browser-creds:list'),

  // ── Cloud Box (Pepe-Box) ──
  cloudboxListProviders: () => ipcRenderer.invoke('cloudbox:list-providers'),
  cloudboxListAccounts: () => ipcRenderer.invoke('cloudbox:list-accounts'),
  cloudboxGetProviderSettings: (provider: string) => ipcRenderer.invoke('cloudbox:get-provider-settings', { provider }),
  cloudboxSaveProviderSettings: (provider: string, clientId: string, clientSecret: string) =>
    ipcRenderer.invoke('cloudbox:save-provider-settings', { provider, clientId, clientSecret }),
  cloudboxConnect: (provider: string) => ipcRenderer.invoke('cloudbox:connect', { provider }),
  cloudboxDisconnect: (accountId: string) => ipcRenderer.invoke('cloudbox:disconnect', { accountId }),
  cloudboxReauth: (accountId: string) => ipcRenderer.invoke('cloudbox:reauth', { accountId }),
  cloudboxRefreshLabel: (accountId: string) => ipcRenderer.invoke('cloudbox:refresh-label', { accountId }),
  onCloudboxEvent: (cb: (payload: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('cloudbox:event', handler);
    return () => ipcRenderer.removeListener('cloudbox:event', handler);
  },

  sshTestWebTarget: (args: { panelId: string; url: string }) => ipcRenderer.invoke('ssh:test-web-target', args),
  sshGetShellCwd: (args: { termId: string }) => ipcRenderer.invoke('ssh:get-shell-cwd', args),
  saveTextFile: (args: { defaultName?: string; content: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke('dialog:save-text-file', args),
  jdbcMetaTables: (args: { connectionId: string; catalog?: string; schema?: string; types?: string[] }) =>
    ipcRenderer.invoke('jdbc:meta-tables', args),
  jdbcMetaColumns: (args: { connectionId: string; catalog?: string; schema?: string; table: string }) =>
    ipcRenderer.invoke('jdbc:meta-columns', args),
  jdbcMetaPrimaryKeys: (args: { connectionId: string; catalog?: string; schema?: string; table: string }) =>
    ipcRenderer.invoke('jdbc:meta-primary-keys', args),
  jdbcMetaSchemas: (args: { connectionId: string }) => ipcRenderer.invoke('jdbc:meta-schemas', args),
  jdbcMetaFunctions: (args: { connectionId: string; catalog?: string; schema?: string }) => ipcRenderer.invoke('jdbc:meta-functions', args),
  jdbcMetaProcedures: (args: { connectionId: string; catalog?: string; schema?: string }) => ipcRenderer.invoke('jdbc:meta-procedures', args),
  jdbcMetaIndexes: (args: { connectionId: string; catalog?: string; schema?: string; table: string }) => ipcRenderer.invoke('jdbc:meta-indexes', args),
  jdbcMetaProcedureColumns: (args: { connectionId: string; catalog?: string; schema?: string; procedureName: string }) => ipcRenderer.invoke('jdbc:meta-procedure-columns', args),
  jdbcMetaFunctionColumns: (args: { connectionId: string; catalog?: string; schema?: string; functionName: string }) => ipcRenderer.invoke('jdbc:meta-function-columns', args),
  // SQL Tool 세션 상태 영속화 (localStorage 대체)
  sqlToolGetState: (sessionId: string) => ipcRenderer.invoke('sql-tool:get-state', sessionId),
  sqlToolSetState: (sessionId: string, partial: any) => ipcRenderer.invoke('sql-tool:set-state', { sessionId, partial }),
  // SQL Tool 독립 DB 연결 프로필 (SSH 세션과 분리)
  sqlSessionsList: () => ipcRenderer.invoke('sql-sessions:list'),
  sqlSessionsSave: (session: any) => ipcRenderer.invoke('sql-sessions:save', session),
  sqlSessionsDelete: (id: string) => ipcRenderer.invoke('sql-sessions:delete', id),
  sqlSessionsSaveFolder: (folder: any) => ipcRenderer.invoke('sql-sessions:save-folder', folder),
  sqlSessionsDeleteFolder: (id: string) => ipcRenderer.invoke('sql-sessions:delete-folder', id),
  sqlSessionsMoveToFolder: (sessionId: string, folderId: string | null) => ipcRenderer.invoke('sql-sessions:move-to-folder', sessionId, folderId),
  sqlSessionsReorder: (id: string, type: 'session' | 'folder', direction: 'up' | 'down' | 'top' | 'bottom') => ipcRenderer.invoke('sql-sessions:reorder', { id, type, direction }),
  sqlSessionsExport: () => ipcRenderer.invoke('sql-sessions:export'),
  sqlSessionsImport: () => ipcRenderer.invoke('sql-sessions:import'),
  feConnectedSessions: () => ipcRenderer.invoke('fe:connected-sessions'),

  // SFTP
  sftpDownload: (panelId: string, remotePath: string, isDir?: boolean) => ipcRenderer.invoke('sftp:download', { panelId, remotePath, isDir }),
  sftpDownloadMulti: (panelId: string, items: { path: string; isDir: boolean }[]) => ipcRenderer.invoke('sftp:download-multi', { panelId, items }),
  sftpQuickShare: (panelId: string, items: { path: string; isDir: boolean }[]) => ipcRenderer.invoke('sftp:quick-share', { panelId, items }),
  sftpDownloadToTemp: (panelId: string, remotePath: string) => ipcRenderer.invoke('sftp:download-to-temp', { panelId, remotePath }),
  pepeTransferReadFile: (localPath: string, fileName: string) => ipcRenderer.invoke('pepe-transfer:read-file', { localPath, fileName }),
  sftpUpload: (panelId: string, remotePath: string, kind?: 'file' | 'folder' | 'multi-file') => ipcRenderer.invoke('sftp:upload', { panelId, remotePath, kind }),
  sftpListDir: (panelId: string, remotePath: string) => ipcRenderer.invoke('sftp:list-dir', { panelId, remotePath }),
  sftpReadFile: (panelId: string, remotePath: string, encoding?: string) => ipcRenderer.invoke('sftp:read-file', { panelId, remotePath, encoding }),
  sftpWriteFile: (panelId: string, remotePath: string, content: string, encoding?: string) => ipcRenderer.invoke('sftp:write-file', { panelId, remotePath, content, encoding }),
  gitBlameFile: (termId: string, remotePath: string) => ipcRenderer.invoke('git:blame-file', { termId, remotePath }),
  ctagsFindDefinition: (termId: string, remotePath: string, symbol: string) => ipcRenderer.invoke('ctags:find-definition', { termId, remotePath, symbol }),
  chatArchiveAppendChunks: (roomId: string, chunks: Array<{ ts: number; sender: string; text: string }>) => ipcRenderer.invoke('chat-archive:append-chunks', { roomId, chunks }),
  chatArchiveEmbedText: (text: string) => ipcRenderer.invoke('chat-archive:embed-text', { text }),
  // 검색 워크스페이스를 닫을 때 임베딩 프로세스(모델 300MB 대)를 내린다.
  chatArchiveReleaseEmbedder: () => ipcRenderer.invoke('chat-archive:release-embedder'),
  chatArchiveSearch: (queryText: string, embedding: number[], topK?: number) => ipcRenderer.invoke('chat-archive:search', { queryText, embedding, topK }),
  chatArchiveGetStats: () => ipcRenderer.invoke('chat-archive:get-stats'),
  chatArchiveFilterUnknown: (roomId: string, items: Array<{ ts: number; sender: string }>) => ipcRenderer.invoke('chat-archive:filter-unknown', { roomId, items }),
  // 진단용 — 특정 문구가 아카이브에 순수 문자열 포함으로 존재하는지 확인(임베딩/스코어링 없음).
  chatArchiveRawContains: (substring: string, roomId?: string) => ipcRenderer.invoke('chat-archive:raw-contains', { substring, roomId }),
  everythingSearch: (query: string, opts?: { matchPath?: boolean; matchCase?: boolean; matchWholeWord?: boolean; regex?: boolean; sort?: number; offset?: number; max?: number }) =>
    ipcRenderer.invoke('everything:search', { query, ...opts }),
  everythingIsAvailable: () => ipcRenderer.invoke('everything:is-available'),
  onSFTPProgress: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:progress', handler);
    return () => ipcRenderer.removeListener('sftp:progress', handler);
  },
  onSFTPComplete: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:complete', handler);
    return () => ipcRenderer.removeListener('sftp:complete', handler);
  },
  onSFTPTransferStart: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:transfer-start', handler);
    return () => ipcRenderer.removeListener('sftp:transfer-start', handler);
  },
  onSFTPFileStart: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:file-start', handler);
    return () => ipcRenderer.removeListener('sftp:file-start', handler);
  },
  onSFTPBatch: (cb: (batch: Array<{ channel: string; payload: any }>) => void) => {
    const handler = (_: any, batch: any) => cb(batch);
    ipcRenderer.on('sftp:batch', handler);
    return () => ipcRenderer.removeListener('sftp:batch', handler);
  },
  onSFTPError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:error', handler);
    return () => ipcRenderer.removeListener('sftp:error', handler);
  },
  onSFTPConflict: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('sftp:conflict', handler);
    return () => ipcRenderer.removeListener('sftp:conflict', handler);
  },
  feResolveConflict: (requestId: string, decision: any) => ipcRenderer.invoke('fe:resolve-conflict', { requestId, decision }),
  feCancelTransfer: (transferId: string) => ipcRenderer.invoke('fe:cancel-transfer', { transferId }),
  shellShowItem: (fullPath: string) => ipcRenderer.invoke('shell:show-item', { fullPath }),
  shellOpenPath: (dirPath: string) => ipcRenderer.invoke('shell:open-path', { dirPath }),
  feChmod: (opts: { mode: string; termId?: string; paths: string[]; octal: number; recursive?: boolean }) => ipcRenderer.invoke('fe:chmod', opts),

  // Window
  windowStartDrag: (mouseX: number, mouseY: number) => ipcRenderer.send('window:start-drag', { mouseX, mouseY }),
  windowDragMove: (mouseX: number, mouseY: number) => ipcRenderer.send('window:drag-move', { mouseX, mouseY }),
  windowEndDrag: () => ipcRenderer.send('window:end-drag'),
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),
  windowFocus: () => ipcRenderer.invoke('window:focus'),
  remoteShareState: () => ipcRenderer.invoke('remote-share:state'),
  remoteShareStart: (options?: { port?: number; pinMode?: 'random' | 'fixed'; fixedPin?: string }) =>
    ipcRenderer.invoke('remote-share:start', options),
  remoteShareStop: () => ipcRenderer.invoke('remote-share:stop'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  windowToggleDevTools: () => ipcRenderer.invoke('window:toggle-devtools'),
  // 탭 분리(멀티 윈도우)
  detachTab: (payload: any, bounds?: any) => ipcRenderer.invoke('window:detach-tab', { payload, bounds }),
  dropTab: (payload: any, point?: any, opts?: { sourceTabCount?: number }) => ipcRenderer.invoke('window:drop-tab', { payload, point, sourceTabCount: opts?.sourceTabCount }),
  onAdoptTab: (cb: (payload: any) => void) => {
    const listener = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('window:adopt-tab', listener);
    return () => ipcRenderer.removeListener('window:adopt-tab', listener);
  },
  getDetachedInit: () => ipcRenderer.invoke('window:get-detached-init'),
  getConnectedPanels: () => ipcRenderer.invoke('ssh:connected-panels'),
  setWebviewProxy: (args: { webContentsId: number; proxyRules: string | null; proxyBypassRules?: string }) => ipcRenderer.invoke('browser:set-proxy', args),
  // webview 내비게이션은 메인에서 수행한다 — 취소(ERR_ABORTED)가 메인 로그를 오류로 뒤덮는 것을 막기 위함.
  navigateWebview: (args: { webContentsId: number; url: string }) => ipcRenderer.invoke('browser:navigate', args),
  resizeBrowserGuest: (args: { webContentsId: number; width: number; height: number }) => ipcRenderer.invoke('browser:resize-guest', args),
  bumpWebviewMaxListeners: (args: { webContentsId: number }) => ipcRenderer.invoke('browser:bump-max-listeners', args),
  agentIsRunning: (args: { sessionId?: string; requestId?: string }) => ipcRenderer.invoke('agent:is-running', args),
  getCursorPoint: () => ipcRenderer.invoke('window:cursor-point'),
  getWindowBounds: () => ipcRenderer.invoke('window:get-bounds'),
  tabDragGhostStart: (opts: { x: number; y: number; width: number; height: number; label: string; bg?: string; color?: string; accent?: string }) => ipcRenderer.send('tab-drag:ghost-start', opts),
  tabDragGhostMove: (x: number, y: number) => ipcRenderer.send('tab-drag:ghost-move', { x, y }),
  tabDragGhostEnd: () => ipcRenderer.send('tab-drag:ghost-end'),
  onWindowMaximized: (cb: (m: boolean) => void) => {
    const listener = (_e: any, m: boolean) => cb(m);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  onDebugLog: (cb: (msg: string) => void) => {
    const listener = (_e: any, msg: string) => cb(msg);
    ipcRenderer.on('debug:log', listener);
    return () => ipcRenderer.removeListener('debug:log', listener);
  },
  debugLog: (msg: string) => ipcRenderer.send('debug:log', msg),

  // SSH control
  resetSSHState: (panelId: string) => ipcRenderer.invoke('ssh:reset-state', panelId),
  connectSSH: (panelId: string, sessionId: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:connect', { panelId, sessionId, cols, rows }),
  connectSSHWithPassword: (panelId: string, sessionId: string, password: string, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:connect-with-password', { panelId, sessionId, password, cols, rows }),
  quickConnectSSH: (panelId: string, session: any, cols?: number, rows?: number) =>
    ipcRenderer.invoke('ssh:quick-connect', { panelId, session, cols, rows }),
  // 텔넷(raw TCP) 접속 — 접근통제 솔루션 로컬 평문 프록시용
  telnetConnect: (panelId: string, host: string, port: number, cols?: number, rows?: number, encoding?: string) =>
    ipcRenderer.invoke('telnet:connect', { panelId, host, port, cols, rows, encoding }),
  isSSHConnected: (panelId: string) =>
    ipcRenderer.invoke('ssh:is-connected', panelId),
  setTermVisibility: (panelId: string, visible: boolean) =>
    ipcRenderer.send('term:set-visibility', { panelId, visible }),
  // ── 탭별 프로세스 분리(Wave Terminal 방식) relay ──────────────────────────
  // host(App.tsx) 쪽에서 사용: 탭 프로세스에 등록된 termId 를 향한 커맨드/쿼리 전송.
  termRegisterTerm: (termId: string, tabId?: string) =>
    ipcRenderer.send('term:register-term', { termId, tabId }),
  termUnregisterTerm: (termId: string) =>
    ipcRenderer.send('term:unregister-term', { termId }),
  termCall: (termId: string, fn: string, args: any[]) =>
    ipcRenderer.send('term:call', { termId, fn, args }),
  termInvoke: (termId: string, fn: string, args: any[]) =>
    ipcRenderer.invoke('term:invoke', { termId, fn, args }),
  onTermStateUpdate: (cb: (p: { termId: string; patch: any }) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('term:state-update', handler);
    return () => ipcRenderer.removeListener('term:state-update', handler);
  },
  // 탭 프로세스 쪽에서 사용: host 가 보낸 커맨드/쿼리 수신 + 상태 push.
  onTermDispatch: (cb: (p: { termId: string; fn: string; args: any[] }) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('term:dispatch', handler);
    return () => ipcRenderer.removeListener('term:dispatch', handler);
  },
  onTermDispatchInvoke: (cb: (p: { termId: string; fn: string; args: any[]; requestId: string }) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('term:dispatch-invoke', handler);
    return () => ipcRenderer.removeListener('term:dispatch-invoke', handler);
  },
  termInvokeReply: (requestId: string, result: any) =>
    ipcRenderer.send('term:invoke-reply', { requestId, result }),
  pushTermState: (termId: string, patch: any) =>
    ipcRenderer.send('term:state-update', { termId, patch }),
  // 탭 간 세션 이동(release/adopt) — 어느 한쪽이라도 격리된 탭/패널 프로세스면 레이아웃
  // 트리 조작만으로는 안 되고, 실제 소유 프로세스에 release/adopt 를 relay 해야 한다.
  sendReleaseSession: (tabId: string, payload: any) =>
    ipcRenderer.send('tab:release-session', { tabId, payload }),
  onReleaseSession: (cb: (payload: any) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('tab:release-session', handler);
    return () => ipcRenderer.removeListener('tab:release-session', handler);
  },
  sendAdoptSession: (tabId: string, payload: any) =>
    ipcRenderer.send('tab:adopt-session', { tabId, payload }),
  onAdoptSession: (cb: (payload: any) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('tab:adopt-session', handler);
    return () => ipcRenderer.removeListener('tab:adopt-session', handler);
  },
  devToggleTabPocView: () => ipcRenderer.invoke('dev:toggle-poc-view'),
  devGetTabPids: () => ipcRenderer.invoke('dev:get-tab-pids'),
  devCaptureScreenshot: (): Promise<{ success: boolean; file?: string; dir?: string; layers?: number; error?: string }> => ipcRenderer.invoke('dev:capture-screenshot'),
  devGetCaptureDir: (): Promise<string> => ipcRenderer.invoke('dev:get-capture-dir'),
  devGetTermTabMap: () => ipcRenderer.invoke('dev:get-term-tab-map'),
  // ── 실제 탭 프로세스 분리 lifecycle (host 쪽에서 사용) ──────────────────
  tabCreateView: (tabId: string, route?: string) => ipcRenderer.invoke('tab:create-view', { tabId, route }),
  tabDestroyView: (tabId: string) => ipcRenderer.send('tab:destroy-view', { tabId }),
  tabSetVisibility: (tabId: string, visible: boolean, bounds?: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.send('tab:set-visibility', { tabId, visible, bounds }),
  sendSSHInput: (panelId: string, data?: string, b64?: string) =>
    ipcRenderer.send('ssh:input', { panelId, data, b64 }),
  disconnectSSH: (panelId: string) =>
    ipcRenderer.send('ssh:disconnect', { panelId }),
  resizeSSH: (panelId: string, cols: number, rows: number, force?: boolean) =>
    ipcRenderer.send('ssh:resize', { panelId, cols, rows, force }),
  setSSHEncoding: (panelId: string, encoding: string) =>
    ipcRenderer.invoke('ssh:set-encoding', { panelId, encoding }),
  getSSHEncoding: (panelId: string) =>
    ipcRenderer.invoke('ssh:get-encoding', panelId),
  setSSHAutoTrack: (panelId: string, enabled: boolean) =>
    ipcRenderer.invoke('ssh:set-auto-track', { panelId, enabled }),

  // App
  refocusWindow: () => ipcRenderer.invoke('win:refocus'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getReleaseNotes: () => ipcRenderer.invoke('app:get-release-notes'),
  // AI Chat: paste/drop 된 이미지·바이너리를 디스크 임시 파일로 저장 후 경로 반환
  chatSavePastedBlob: (dataUrl: string, name?: string, mimeType?: string) => ipcRenderer.invoke('chat:save-pasted-blob', { dataUrl, name, mimeType }),
  // 외부 드래그(Explorer) 로 받은 File 의 실제 파일시스템 경로 조회 (Electron 30+ webUtils API)
  getPathForFile: (file: File): string | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { webUtils } = require('electron');
      const p = webUtils?.getPathForFile?.(file);
      return p || null;
    } catch { return null; }
  },
  // 메인 프로세스에서 절대경로 파일을 chat 첨부 디렉토리로 복사 후 경로 반환
  chatCopyExternalFile: (srcPath: string, displayName?: string) => ipcRenderer.invoke('chat:copy-external-file', { srcPath, displayName }),
  // 전송 전에 대기 목록에서 첨부를 제거했을 때 그 임시 사본 삭제 (pepe-chat-attachments 안의 파일만)
  chatRemovePendingAttachment: (filePath: string) => ipcRenderer.invoke('chat:remove-pending-attachment', { filePath }),
  aiAttachMirror: (args: { panelId: string; remotePath: string; isDir: boolean }) => ipcRenderer.invoke('ai-attach:mirror-remote', args),
  aiAttachDispose: (args: { panelId: string; remotePath: string }) => ipcRenderer.invoke('ai-attach:dispose-remote', args),
  aiAttachDisposePanel: (args: { panelId: string }) => ipcRenderer.invoke('ai-attach:dispose-panel', args),
  localReadFile: (filePath: string) => ipcRenderer.invoke('local-fs:read-file', { filePath }),
  // transparent BrowserWindow drag-drop 우회 — 메인의 will-navigate 가 file:// 을 가로채면
  // 여기로 파일 경로가 도착. ClaudeChat 이 구독해 첨부 처리.
  onChatExternalFileDropped: (handler: (payload: { path: string }) => void) => {
    const listener = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('chat:external-file-dropped', listener);
    return () => ipcRenderer.removeListener('chat:external-file-dropped', listener);
  },
  // native drag-drop 등록 결과 진단용 (DevTools 콘솔에서 확인 가능)
  onChatDragDropStatus: (handler: (payload: { ok: boolean; msg: string }) => void) => {
    const listener = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('chat:drag-drop-status', listener);
    return () => ipcRenderer.removeListener('chat:drag-drop-status', listener);
  },

  // ── 자동 업데이트 (electron-updater / GitHub Releases) ──
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterQuitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
  updaterGetState: () => ipcRenderer.invoke('updater:state'),
  onUpdaterStatus: (handler: (payload: any) => void) => {
    const listener = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  getStartupCwd: () => ipcRenderer.invoke('app:startup-cwd'),
  clearStartupCwd: () => ipcRenderer.invoke('app:clear-startup-cwd'),
  // 외부 프로그램이 ssh://host:port 인자로 호출 시 자동 접속 대상
  getStartupSshTarget: () => ipcRenderer.invoke('app:startup-ssh-target'),
  clearStartupSshTarget: () => ipcRenderer.invoke('app:clear-startup-ssh-target'),
  registerContextMenu: () => ipcRenderer.invoke('app:register-context-menu'),
  unregisterContextMenu: () => ipcRenderer.invoke('app:unregister-context-menu'),
  checkContextMenu: () => ipcRenderer.invoke('app:check-context-menu'),

  // Local Shell (PTY)
  ptyListShells: () => ipcRenderer.invoke('pty:list-shells'),
  ptySpawn: (panelId: string, shell?: string, cols?: number, rows?: number, cwd?: string) =>
    ipcRenderer.invoke('pty:spawn', { panelId, shell, cols, rows, cwd }),
  ptyInput: (panelId: string, data: string) =>
    ipcRenderer.send('pty:input', { panelId, data }),
  ptyResize: (panelId: string, cols: number, rows: number) =>
    ipcRenderer.send('pty:resize', { panelId, cols, rows }),
  ptyKill: (panelId: string) =>
    ipcRenderer.send('pty:kill', { panelId }),
  onPtyData: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('pty:data', handler);
    return () => ipcRenderer.removeListener('pty:data', handler);
  },
  onPtyExit: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('pty:exit', handler);
    return () => ipcRenderer.removeListener('pty:exit', handler);
  },

  onSSHData: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:data', handler);
    return () => ipcRenderer.removeListener('ssh:data', handler);
  },
  onSSHConnected: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:connected', handler);
    return () => ipcRenderer.removeListener('ssh:connected', handler);
  },
  onSSHClosed: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:closed', handler);
    return () => ipcRenderer.removeListener('ssh:closed', handler);
  },
  onSSHError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:error', handler);
    return () => ipcRenderer.removeListener('ssh:error', handler);
  },
  onSSHAutoTrack: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:auto-track', handler);
    return () => ipcRenderer.removeListener('ssh:auto-track', handler);
  },
  onSSHPwd: (cb: (p: { panelId: string; pwd: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:pwd', handler);
    return () => ipcRenderer.removeListener('ssh:pwd', handler);
  },
  onSSHAuthPrompt: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('ssh:auth-prompt', handler);
    return () => ipcRenderer.removeListener('ssh:auth-prompt', handler);
  },
  sshAuthResponse: (panelId: string, responses: string[]) =>
    ipcRenderer.invoke('ssh:auth-response', { panelId, responses }),

  // Git 상태 — local cwd 또는 원격 SSH 세션의 git repo
  gitStatus: (params: { mode: 'local' | 'remote'; termId?: string; cwd?: string }) => ipcRenderer.invoke('git:status', params),

  // Claude Code CLI
  claudeCheck: () => ipcRenderer.invoke('claude:check'),
  claudeSend: (sessionId: string, prompt: string, addDirs?: string[], disallowBash?: boolean, sshTermId?: string, resumeSessionId?: string | null, permissionMode?: string, model?: string, perToolApproval?: boolean, requestId?: string, effort?: string, sshSessions?: { id: string; label: string }[], localAttachmentRoots?: string[], maxThinkingTokens?: number) =>
    ipcRenderer.invoke('claude:send', { sessionId, prompt, addDirs, disallowBash, sshTermId, resumeSessionId, permissionMode, model, perToolApproval, requestId, effort, sshSessions, localAttachmentRoots, maxThinkingTokens }),
  claudeHookRespond: (approvalId: string, decision: 'allow' | 'deny', reason?: string) =>
    ipcRenderer.invoke('claude:hook-respond', { approvalId, decision, reason }),
  onClaudeHookApprovalRequest: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('claude:hook-approval-request', handler);
    return () => ipcRenderer.removeListener('claude:hook-approval-request', handler);
  },
  claudeRegisterMount: (panelId: string, sessionLabel: string) =>
    ipcRenderer.invoke('claude:register-mount', { panelId, sessionLabel }),
  claudeUnregisterMount: (panelId: string) =>
    ipcRenderer.invoke('claude:unregister-mount', { panelId }),
  claudeGetMountPath: (panelId: string, remotePath: string) =>
    ipcRenderer.invoke('claude:get-mount-path', { panelId, remotePath }),
  claudeStop: (sessionId: string, requestId?: string) => ipcRenderer.invoke('claude:stop', { sessionId, requestId }),
  geminiCheck: () => ipcRenderer.invoke('gemini:check'),
  geminiModelInfo: () => ipcRenderer.invoke('gemini:modelInfo'),
  debugDump: (name: string, content: string) => ipcRenderer.invoke('debug:dump', { name, content }),
  geminiSend: (sessionId: string, prompt: string, requestId?: string, model?: string, yolo?: boolean, addDirs?: string[], sshTermId?: string, sshSessions?: { id: string; label: string }[], localAttachmentRoots?: string[]) =>
    ipcRenderer.invoke('gemini:send', { sessionId, prompt, requestId, model, yolo, addDirs, sshTermId, sshSessions, localAttachmentRoots }),
  geminiStop: (sessionId: string, requestId?: string) => ipcRenderer.invoke('gemini:stop', { sessionId, requestId }),
  codexCheck: () => ipcRenderer.invoke('codex:check'),
  codexRateLimits: () => ipcRenderer.invoke('codex:rateLimits'),
  codexSend: (sessionId: string, prompt: string, requestId?: string, model?: string, approvalPolicy?: string, effort?: string, sshTermId?: string, sshSessions?: Array<{ id: string; label: string }>, localAttachmentRoots?: string[]) =>
    ipcRenderer.invoke('codex:send', { sessionId, prompt, requestId, model, approvalPolicy, effort, sshTermId, sshSessions, localAttachmentRoots }),
  codexStop: (sessionId: string, requestId?: string) => ipcRenderer.invoke('codex:stop', { sessionId, requestId }),
  customCheck: () => ipcRenderer.invoke('custom-llm:check'),
  customSend: (sessionId: string, messages: Array<{ role: string; content: string }>, requestId?: string, sshTermId?: string) =>
    ipcRenderer.invoke('custom-llm:send', { sessionId, messages, requestId, sshTermId }),
  customStop: (sessionId: string, requestId?: string) =>
    ipcRenderer.invoke('custom-llm:stop', { sessionId, requestId }),
  customListModels: (baseUrl?: string, apiKey?: string) => ipcRenderer.invoke('custom-llm:list-models', { baseUrl, apiKey }),
  antigravityCheck: () => ipcRenderer.invoke('antigravity:check'),
  antigravityModelInfo: () => ipcRenderer.invoke('antigravity:modelInfo'),
  antigravityOpenUsage: () => ipcRenderer.invoke('antigravity:openUsage'),
  antigravityProbeUsageTui: () => ipcRenderer.invoke('antigravity:probeUsageTui'),
  antigravitySend: (sessionId: string, prompt: string, requestId?: string, model?: string, yolo?: boolean, addDirs?: string[], sshTermId?: string, sshSessions?: { id: string; label: string }[], localAttachmentRoots?: string[]) =>
    ipcRenderer.invoke('antigravity:send', { sessionId, prompt, requestId, model, yolo, addDirs, sshTermId, sshSessions, localAttachmentRoots }),
  antigravityStop: (sessionId: string, requestId?: string) =>
    ipcRenderer.invoke('antigravity:stop', { sessionId, requestId }),
  claudeProbeUsage: () => ipcRenderer.invoke('claude:probe-usage'),
  claudeProbeUsageTui: () => ipcRenderer.invoke('claude:probe-usage-tui'),
  claudeFetchUsageApi: () => ipcRenderer.invoke('claude:fetch-usage-api'),
  claudeFetchModels: () => ipcRenderer.invoke('claude:fetch-models'),
  claudeReadSettings: () => ipcRenderer.invoke('claude:read-settings'),
  clipboardWriteImage: (dataUrl: string) => ipcRenderer.invoke('clipboard:write-image', { dataUrl }),
  x11Start: (displayNum?: number) => ipcRenderer.invoke('x11:start', displayNum ?? 0),
  x11Stop: (displayNum?: number) => ipcRenderer.invoke('x11:stop', displayNum ?? 0),
  x11Status: () => ipcRenderer.invoke('x11:status'),
  pasteModalOpen: (id: string, text: string, accumulate?: boolean) => ipcRenderer.invoke('paste-modal:open', { id, text, accumulate: !!accumulate }),
  onPasteModalResult: (cb: (p: { id: string; action: 'paste' | 'cancel'; text: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('paste-modal:result', handler);
    return () => ipcRenderer.removeListener('paste-modal:result', handler);
  },
  searchHistoryGet: (): Promise<string[]> => ipcRenderer.invoke('search:history-get'),
  searchHistoryAdd: (q: string) => ipcRenderer.send('search:history-add', q),
  optionsOpen: () => ipcRenderer.invoke('options:open'),
  optionsClose: () => ipcRenderer.send('options:close'),
  optionsSaved: () => ipcRenderer.send('options:saved'),
  onOptionsSaved: (cb: () => void) => {
    const h = () => cb(); ipcRenderer.on('options:saved', h);
    return () => ipcRenderer.removeListener('options:saved', h);
  },
  sessionEditorOpen: (sessionId: string) => ipcRenderer.invoke('session-editor:open', { sessionId }),
  sessionEditorClose: () => ipcRenderer.send('session-editor:close'),
  sessionEditorSaved: (payload: any) => ipcRenderer.send('session-editor:saved', payload),
  onSessionEditorSaved: (cb: (p: any) => void) => {
    const h = (_: any, p: any) => cb(p); ipcRenderer.on('session-editor:saved', h);
    return () => ipcRenderer.removeListener('session-editor:saved', h);
  },
  // i18n
  i18nListLanguages: () => ipcRenderer.invoke('i18n:list-languages'),
  i18nListNamespaces: (lang: string) => ipcRenderer.invoke('i18n:list-namespaces', { lang }),
  i18nLoad: (lang: string, ns: string) => ipcRenderer.invoke('i18n:load', { lang, ns }),
  i18nLoadBundled: (lang: string, ns: string) => ipcRenderer.invoke('i18n:load-bundled', { lang, ns }),
  i18nLoadOverride: (lang: string, ns: string) => ipcRenderer.invoke('i18n:load-override', { lang, ns }),
  i18nSaveOverride: (lang: string, ns: string, kv: Record<string, string>) => ipcRenderer.invoke('i18n:save-override', { lang, ns, kv }),
  i18nAddLanguage: (lang: string) => ipcRenderer.invoke('i18n:add-language', { lang }),
  i18nRemoveLanguage: (lang: string) => ipcRenderer.invoke('i18n:remove-language', { lang }),
  i18nAutoTranslate: (sourceLang: string, targetLang: string, items: Record<string, string>, apiKey?: string) =>
    ipcRenderer.invoke('i18n:auto-translate', { sourceLang, targetLang, items, apiKey }),
  i18nSetLang: (lang: string) => ipcRenderer.invoke('i18n:set-lang', { lang }),

  // OpenVPN
  vpnAvailable: () => ipcRenderer.invoke('vpn:available'),
  vpnState: () => ipcRenderer.invoke('vpn:state'),
  vpnLogs: () => ipcRenderer.invoke('vpn:logs'),
  vpnListConfigs: () => ipcRenderer.invoke('vpn:list-configs'),
  vpnImportConfig: (srcPath?: string) => ipcRenderer.invoke('vpn:import-config', { srcPath }),
  vpnRemoveConfig: (filePath: string) => ipcRenderer.invoke('vpn:remove-config', { filePath }),
  vpnConnect: (configPath: string, username?: string, password?: string) =>
    ipcRenderer.invoke('vpn:connect', { configPath, username, password }),
  vpnDisconnect: () => ipcRenderer.invoke('vpn:disconnect'),
  vpnSaveCreds: (configPath: string, username: string, password: string) => ipcRenderer.invoke('vpn:save-creds', { configPath, username, password }),
  vpnLoadCreds: (configPath: string) => ipcRenderer.invoke('vpn:load-creds', { configPath }),
  vpnClearCreds: (configPath: string) => ipcRenderer.invoke('vpn:clear-creds', { configPath }),
  vpnHasCreds: (configPath: string) => ipcRenderer.invoke('vpn:has-creds', { configPath }),
  onVpnState: (cb: (state: any) => void) => {
    const h = (_: any, st: any) => cb(st);
    ipcRenderer.on('vpn:state', h);
    return () => ipcRenderer.removeListener('vpn:state', h);
  },
  onVpnLog: (cb: (line: string) => void) => {
    const h = (_: any, line: string) => cb(line);
    ipcRenderer.on('vpn:log', h);
    return () => ipcRenderer.removeListener('vpn:log', h);
  },
  onVpnPasswordRequired: (cb: (line: string) => void) => {
    const h = (_: any, line: string) => cb(line);
    ipcRenderer.on('vpn:password-required', h);
    return () => ipcRenderer.removeListener('vpn:password-required', h);
  },
  onVpnAuthFailed: (cb: (line: string) => void) => {
    const h = (_: any, line: string) => cb(line);
    ipcRenderer.on('vpn:auth-failed', h);
    return () => ipcRenderer.removeListener('vpn:auth-failed', h);
  },

  // 파일 비교 (CompareWorkspace)
  compareWalk: (mode: string, basePath: string, termId?: string, maxEntries?: number, ignoreBinaryFiles?: boolean) =>
    ipcRenderer.invoke('compare:walk', { mode, termId, basePath, maxEntries, ignoreBinaryFiles }),
  compareDirCompare: (
    leftMode: string, leftBasePath: string, leftTermId: string | undefined,
    rightMode: string, rightBasePath: string, rightTermId: string | undefined,
    maxEntries?: number, ignoreBinaryFiles?: boolean, skipOrphanDirectories?: boolean, requestId?: string,
  ) =>
    ipcRenderer.invoke('compare:dir-compare', {
      leftMode, leftBasePath, leftTermId,
      rightMode, rightBasePath, rightTermId,
      maxEntries, ignoreBinaryFiles, skipOrphanDirectories, requestId,
    }),
  compareStop: (requestId: string) => ipcRenderer.invoke('compare:stop', { requestId }),
  compareHash: (mode: string, filePath: string, termId?: string, maxBytes?: number, wsMode?: string) =>
    ipcRenderer.invoke('compare:hash', { mode, termId, filePath, maxBytes, wsMode }),
  compareDownload: (defaultName: string, content: string, encoding?: string) =>
    ipcRenderer.invoke('compare:download', { defaultName, content, encoding }),
  logWatchStart: (watchId: string, mode: string, filePath: string, termId?: string) =>
    ipcRenderer.invoke('log:watch-start', { watchId, mode, termId, filePath }),
  logWatchStop: (watchId: string) =>
    ipcRenderer.invoke('log:watch-stop', { watchId }),
  onLogWatchData: (cb: (p: { watchId: string; text: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('log:watch-data', handler);
    return () => ipcRenderer.removeListener('log:watch-data', handler);
  },
  onLogWatchError: (cb: (p: { watchId: string; error: string }) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('log:watch-error', handler);
    return () => ipcRenderer.removeListener('log:watch-error', handler);
  },
  compareDiffCount: (
    leftMode: string, leftPath: string, leftTermId: string | undefined,
    rightMode: string, rightPath: string, rightTermId: string | undefined,
    maxBytes?: number, wsMode?: string,
  ) => ipcRenderer.invoke('compare:diff-count', {
    leftMode, leftTermId, leftPath, rightMode, rightTermId, rightPath, maxBytes, wsMode,
  }),
  compareRead: (mode: string, filePath: string, termId?: string, maxBytes?: number) =>
    ipcRenderer.invoke('compare:read', { mode, termId, filePath, maxBytes }),
  compareWrite: (mode: string, filePath: string, content: string, termId?: string) =>
    ipcRenderer.invoke('compare:write', { mode, termId, filePath, content }),

  // Terminal recording (REC)
  recStart: (panelId: string, sessionName?: string) => ipcRenderer.invoke('rec:start', { panelId, sessionName }),
  recStop: (panelId: string) => ipcRenderer.invoke('rec:stop', { panelId }),
  recAppend: (panelId: string, data: string, kind?: 'out' | 'in' | 'mark') => ipcRenderer.send('rec:append', { panelId, data, kind }),
  recStatus: (panelId?: string) => ipcRenderer.invoke('rec:status', { panelId }),
  recListActive: () => ipcRenderer.invoke('rec:list-active'),
  onRecError: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('rec:error', handler);
    return () => ipcRenderer.removeListener('rec:error', handler);
  },
  onClaudeStream: (cb: (p: any) => void) => {
    const handler = (_: any, p: any) => cb(p);
    ipcRenderer.on('claude:stream', handler);
    return () => ipcRenderer.removeListener('claude:stream', handler);
  },
});
