// src/utils/debugLog.ts
// 브라우저/커스텀 워크스페이스 디버그 로그([cw-debug], [auto-submit]) — webview 크기 동기화 등
// 특정 버그를 잡을 때 켜서 쓰던 진단용 로그라 평소엔 콘솔/로그파일을 채울 필요가 없다. 기본 꺼짐,
// 필요할 때만 devtools 콘솔에서 window.__pepeSetDebugLogEnabled(true) 로 켠다.
let debugLogEnabled = false;

export function setDebugLogEnabled(enabled: boolean) {
  debugLogEnabled = enabled;
}

export function isDebugLogEnabled(): boolean {
  return debugLogEnabled;
}

export function emitDebugLog(...parts: any[]) {
  if (!debugLogEnabled) return;
  const line = parts.map(p => {
    if (typeof p === 'string') return p;
    try { return JSON.stringify(p); } catch { return String(p); }
  }).join(' ');
  try { (window as any).api?.debugLog?.(line); } catch {}
  try { console.log(line); } catch {}
}
