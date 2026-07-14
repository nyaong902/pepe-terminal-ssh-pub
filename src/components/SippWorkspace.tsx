// src/components/SippWorkspace.tsx
// SIPp 워크스페이스 — 네이티브 SIPp(부하 발생기) 제어 UI.
// 실제 SIP 콜은 electron/sippSidecar.ts 가 sipp.exe 를 spawn 해서 발생시키며,
// 여기서는 window.api.sipp* IPC 로 시작/중지/통계 스트림만 다룬다.
import React, { useEffect, useRef, useState } from 'react';
import { notifyConfirm } from './Notify';

const api = () => (window as any).api || {};
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const inp: React.CSSProperties = { padding: '6px 8px', background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, fontSize: 12, width: '100%', boxSizing: 'border-box' };
const label: React.CSSProperties = { fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 4, display: 'block' };
const card: React.CSSProperties = { background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', borderRadius: 8, padding: 12 };
const btn = (enabled: boolean, kind: 'primary' | 'danger' = 'primary'): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 6, border: 'none', fontWeight: 700, fontSize: 13,
  background: !enabled ? 'var(--win-surface-2, #21262d)' : kind === 'danger' ? '#da3633' : 'var(--win-accent, #2b6b9b)',
  color: enabled ? '#fff' : 'var(--win-text-dim, #9aa7b3)', cursor: enabled ? 'pointer' : 'not-allowed',
});

type SippStats = {
  callsCreated?: number;
  successfulCalls?: number;
  failedCalls?: number;
  currentCalls?: number;
  cps?: number;
  elapsed?: string;
};

type ScenarioMode = 'blocks' | 'xml';
type SendMethod = 'INVITE' | 'ACK' | 'BYE' | 'CANCEL' | 'REGISTER' | 'OPTIONS' | 'INFO' | 'REFER' | 'UPDATE' | 'PRACK' | 'SUBSCRIBE' | 'NOTIFY' | 'MESSAGE' | 'PUBLISH' | 'CUSTOM';
// 빠른 추가 버튼/드롭다운에서 쓰는 목록 — CUSTOM 은 별도 버튼("+ 커스텀 메시지")으로 취급.
const SEND_METHODS: Exclude<SendMethod, 'CUSTOM'>[] = ['INVITE', 'ACK', 'BYE', 'CANCEL', 'REGISTER', 'OPTIONS', 'INFO', 'REFER', 'UPDATE', 'PRACK', 'SUBSCRIBE', 'NOTIFY', 'MESSAGE', 'PUBLISH'];
// ACK/CANCEL 은 INVITE 트랜잭션에 응답하는 요청이라 원래도 to-tag 가 필요했다 — INFO/REFER/
// UPDATE/PRACK/NOTIFY 도 흔히 이미 성립된 다이얼로그 안에서 보내는 요청이라 마찬가지로
// [peer_tag_param] 이 필요하다. REGISTER/OPTIONS/SUBSCRIBE(최초)/MESSAGE/PUBLISH 는 보통
// 다이얼로그 밖에서(또는 최초 요청으로) 보내므로 제외.
const IN_DIALOG_METHODS = new Set<SendMethod>(['ACK', 'BYE', 'CANCEL', 'INFO', 'REFER', 'UPDATE', 'PRACK', 'NOTIFY']);

type SendBlock = {
  id: string;
  kind: 'send';
  method: SendMethod;
  fromUser: string;
  toUser: string;
  extraHeaders: string;
  includeBody: boolean;
  body: string;
  customRaw: string; // method === 'CUSTOM' 일 때만 사용 — 원시 SIP 메시지 텍스트
};
type RecvBlock = {
  id: string; kind: 'recv'; code: string; optional: boolean;
  rtd: boolean;  // rtd="true" — 이 응답을 Response Time 통계(ResponseTimeRepartition) 측정 지점으로 표시
  crlf: boolean; // crlf="true" — 통계 화면 표에 구분용 빈 줄 삽입 (동작에는 영향 없음, 보기용)
};
type PauseBlock = { id: string; kind: 'pause'; ms: number };
type ScenarioBlock = SendBlock | RecvBlock | PauseBlock;

const uid = () => Math.random().toString(36).slice(2, 10);

const DEFAULT_SDP = 'v=0\no=user1 53655765 2353687637 IN IP[local_ip_type] [local_ip]\ns=-\nc=IN IP[media_ip_type] [media_ip]\nt=0 0\nm=audio [media_port] RTP/AVP 0\na=rtpmap:0 PCMU/8000';

function newSendBlock(method: SendMethod, fromUser = 'sipp', toUser = 'service'): SendBlock {
  return { id: uid(), kind: 'send', method, fromUser, toUser, extraHeaders: '', includeBody: method === 'INVITE', body: '', customRaw: '' };
}
function newRecvBlock(code = '200'): RecvBlock {
  return { id: uid(), kind: 'recv', code, optional: false, rtd: false, crlf: false };
}
function newPauseBlock(ms = 1000): PauseBlock {
  return { id: uid(), kind: 'pause', ms };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 블록 목록으로부터 실제 SIPp 시나리오 XML 을 생성한다. From/To 는 사용자가 블록마다
// 지정한 번호를 쓰고, CSeq 는 SIP 규칙대로 자동 계산한다 — ACK/CANCEL 은 자신이
// 응답하는 INVITE 와 같은 CSeq 번호를 재사용해야 하고(RFC 3261), BYE 는 새 번호를 쓴다.
//
// fromDomain/toDomain 이 비어있으면 해당 자리에 SIPp 키워드 [remote_ip]:[remote_port]
// 를 쓴다 — 이건 "설정 안 된 값"이 아니라 SIPp 가 실행 시점에 "대상 호스트/포트"
// 필드 값으로 실제 채워주는 진짜 키워드다(전송 계층 대상). 통신사망에서는 발신자와
// 수신자가 서로 다른 SIP 도메인에 등록돼 있는 경우가 흔해서(예: 07088008001 은
// skbroadband.com, 07088881234 는 tbssw001.catvphone.com) From 쪽과 To 쪽 도메인을
// 따로 지정할 수 있게 한다. Contact 헤더만은 항상 [local_ip]:[local_port] 를 쓴다
// (그건 진짜 내 소켓 주소여야 하므로).
function buildXmlFromBlocks(blocks: ScenarioBlock[], fromDomain: string, toDomain: string, responseTimeRepartition: string, callLengthRepartition: string): string {
  let cseqCounter = 0;
  let lastInviteCseq = 1;
  const parts: string[] = [];
  const fromHost = fromDomain.trim() || '[remote_ip]:[remote_port]';
  const toHost = toDomain.trim() || '[remote_ip]:[remote_port]';

  for (const b of blocks) {
    if (b.kind === 'recv') {
      const attrs = `${b.optional ? ' optional="true"' : ''}${b.rtd ? ' rtd="true"' : ''}${b.crlf ? ' crlf="true"' : ''}`;
      parts.push(`  <recv response="${xmlEscape(b.code)}"${attrs}></recv>`);
      continue;
    }
    if (b.kind === 'pause') {
      parts.push(`  <pause milliseconds="${Math.max(0, b.ms | 0)}"/>`);
      continue;
    }
    // send
    if (b.method === 'CUSTOM') {
      parts.push(`  <send retrans="500">\n    <![CDATA[\n\n      ${b.customRaw.split('\n').join('\n      ')}\n\n    ]]>\n  </send>`);
      continue;
    }

    let cseq: number;
    if (b.method === 'INVITE') { cseq = ++cseqCounter; lastInviteCseq = cseq; }
    else if (b.method === 'ACK' || b.method === 'CANCEL') { cseq = lastInviteCseq; }
    else { cseq = ++cseqCounter; } // BYE 및 그 외 모든 메서드는 새 CSeq

    const from = b.fromUser.trim() || 'sipp';
    const to = b.toUser.trim() || 'service';
    const extra = b.extraHeaders.trim() ? b.extraHeaders.trim().split('\n').map(l => l.trim()).join('\n      ') + '\n      ' : '';
    const withBody = b.includeBody;
    const body = (b.body.trim() || DEFAULT_SDP);

    const lines = [
      `${b.method} sip:${to}@${toHost} SIP/2.0`,
      `Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]`,
      `From: "${from}" <sip:${from}@${fromHost}>;tag=[pid]SIPpTag00[call_number]`,
      `To: <sip:${to}@${toHost}>${IN_DIALOG_METHODS.has(b.method) ? '[peer_tag_param]' : ''}`,
      `Call-ID: [call_id]`,
      `CSeq: ${cseq} ${b.method}`,
      `Contact: <sip:${from}@[local_ip]:[local_port]>`,
      `Max-Forwards: 70`,
      extra ? extra.trimEnd() : '',
    ].filter(Boolean);

    if (withBody) {
      lines.push('Content-Type: application/sdp', 'Content-Length: [len]');
    } else {
      lines.push('Content-Length: 0');
    }

    const retrans = (b.method === 'INVITE' || b.method === 'BYE') ? ' retrans="500"' : '';
    const bodyBlock = withBody ? `\n      ${body.split('\n').join('\n      ')}\n` : '\n';
    parts.push(`  <send${retrans}>\n    <![CDATA[\n\n      ${lines.join('\n      ')}\n${bodyBlock}    ]]>\n  </send>`);
  }

  if (responseTimeRepartition.trim()) parts.push(`  <ResponseTimeRepartition value="${xmlEscape(responseTimeRepartition.trim())}"/>`);
  if (callLengthRepartition.trim()) parts.push(`  <CallLengthRepartition value="${xmlEscape(callLengthRepartition.trim())}"/>`);

  return `<?xml version="1.0" encoding="ISO-8859-1" ?>\n<!DOCTYPE scenario SYSTEM "sipp.dtd">\n<scenario name="PePe SIPp 블록 조립">\n${parts.join('\n\n')}\n</scenario>\n`;
}

// buildXmlFromBlocks() 의 역방향 — XML 미리보기를 직접 편집했을 때 블록 목록으로
// 되돌린다. INVITE/ACK/BYE/CANCEL 요청줄 + From/To 헤더를 알아볼 수 있는 <send> 는
// 구조화된 블록으로, 그 외(정규식 액션이 들어있거나 형식이 다른 메시지)는 통째로
// "커스텀" 블록으로 떨어뜨려서 내용을 잃지 않는다 — best-effort 파싱.
const KNOWN_SEND_HEADER_NAMES = ['via', 'from', 'to', 'call-id', 'cseq', 'contact', 'max-forwards', 'content-type', 'content-length'];
function normDomain(d: string): string {
  return (d === '[remote_ip]:[remote_port]' || !d) ? '' : d;
}
function parseSendCdata(raw: string): { block: SendBlock; fromDomain: string; toDomain: string } | null {
  const rawLines = raw.split('\n').map(l => l.trim());
  let i = 0;
  while (i < rawLines.length && rawLines[i] === '') i++;
  if (i >= rawLines.length) return null;
  const reqMatch = rawLines[i].match(/^(\S+)\s+sip:([^@\s]+)@([^\s;>]+)\s+SIP\/2\.0/i);
  if (!reqMatch) return null;
  const method = reqMatch[1].toUpperCase();
  if (!SEND_METHODS.includes(method as any)) return null;
  const toUser = reqMatch[2];
  const toDomainRaw = reqMatch[3];
  i++;

  const headerLines: string[] = [];
  while (i < rawLines.length && rawLines[i] !== '') { headerLines.push(rawLines[i]); i++; }
  while (i < rawLines.length && rawLines[i] === '') i++;
  const bodyLines = rawLines.slice(i);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
  const body = bodyLines.join('\n');

  let fromUser = 'sipp';
  let fromDomainRaw = '';
  const extra: string[] = [];
  for (const h of headerLines) {
    const colonIdx = h.indexOf(':');
    if (colonIdx < 0) { extra.push(h); continue; }
    const name = h.slice(0, colonIdx).trim().toLowerCase();
    const value = h.slice(colonIdx + 1).trim();
    if (name === 'from') {
      const m = value.match(/sip:([^@\s]+)@([^\s;>]+)/);
      if (m) { fromUser = m[1]; fromDomainRaw = m[2]; }
    } else if (!KNOWN_SEND_HEADER_NAMES.includes(name)) {
      extra.push(h);
    }
  }

  const includeBody = body.length > 0;
  return {
    block: { id: uid(), kind: 'send', method: method as SendMethod, fromUser, toUser, extraHeaders: extra.join('\n'), includeBody, body: includeBody ? body : '', customRaw: '' },
    fromDomain: normDomain(fromDomainRaw),
    toDomain: normDomain(toDomainRaw),
  };
}

function parseXmlToBlocks(xml: string): {
  blocks: ScenarioBlock[]; fromDomain: string; toDomain: string;
  responseTimeRepartition: string; callLengthRepartition: string;
} | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return null;
  }
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const scenario = doc.querySelector('scenario');
  if (!scenario) return null;

  const blocks: ScenarioBlock[] = [];
  let fromDomain = '';
  let toDomain = '';
  let responseTimeRepartition = '';
  let callLengthRepartition = '';

  for (const el of Array.from(scenario.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'send') {
      const cdata = el.textContent || '';
      const parsed = parseSendCdata(cdata);
      if (parsed) {
        blocks.push(parsed.block);
        if (parsed.fromDomain) fromDomain = parsed.fromDomain;
        if (parsed.toDomain) toDomain = parsed.toDomain;
      } else {
        blocks.push({ id: uid(), kind: 'send', method: 'CUSTOM', fromUser: 'sipp', toUser: 'service', extraHeaders: '', includeBody: false, body: '', customRaw: cdata.trim() });
      }
    } else if (tag === 'recv') {
      blocks.push({
        id: uid(), kind: 'recv',
        code: el.getAttribute('response') || '200',
        optional: el.getAttribute('optional') === 'true',
        rtd: el.getAttribute('rtd') === 'true',
        crlf: el.getAttribute('crlf') === 'true',
      });
    } else if (tag === 'pause') {
      blocks.push({ id: uid(), kind: 'pause', ms: Number(el.getAttribute('milliseconds') || '0') || 0 });
    } else if (tag === 'responsetimerepartition') {
      responseTimeRepartition = el.getAttribute('value') || '';
    } else if (tag === 'calllengthrepartition') {
      callLengthRepartition = el.getAttribute('value') || '';
    }
    // 그 외 태그(예: 주석, 알 수 없는 확장)는 조용히 건너뛴다 — best-effort.
  }

  return { blocks, fromDomain, toDomain, responseTimeRepartition, callLengthRepartition };
}

// 창 분리 시 보존하는 "설정/시나리오 작업 내용" — 실행 중 통계·로그·진행상태는 살아있는
// sipp 프로세스에 묶여 있어 새 창으로 못 옮기므로 제외한다(입력해둔 옵션과 블록 구성만 보존).
export type SippWorkspaceState = {
  targetHost: string; targetPort: number; localIp: string; localPort: string; cps: number;
  maxCalls: string; callDurationMs: number; maxOpenCalls: string; callIdString: string;
  transport: 'u1' | 'un' | 'ui' | 't1' | 'tn' | 'l1' | 'ln'; timeoutSec: string; recvTimeoutMs: string;
  sendTimeoutMs: string; maxRetrans: string; noRetrans: boolean; traceMsg: boolean; traceErr: boolean;
  requestUriUser: string; extraArgs: string; advOptsOpen: boolean; injectionCsv: string; injectionCsvOpen: boolean;
  scenarioMode: ScenarioMode; rawScenarioXml: string; fromDomain: string; toDomain: string;
  responseTimeRepartition: string; callLengthRepartition: string; blocks: ScenarioBlock[];
};

export const SippWorkspace: React.FC<{ instanceId: string; initialState?: SippWorkspaceState; onStateChange?: (state: SippWorkspaceState) => void }> = ({ instanceId, initialState, onStateChange }) => {
  const [targetHost, setTargetHost] = useState(initialState?.targetHost ?? '127.0.0.1');
  const [targetPort, setTargetPort] = useState(initialState?.targetPort ?? 5060);
  const [localIp, setLocalIp] = useState(initialState?.localIp ?? '');
  const [localPort, setLocalPort] = useState<string>(initialState?.localPort ?? '');
  const [cps, setCps] = useState(initialState?.cps ?? 5);
  const [maxCalls, setMaxCalls] = useState<string>(initialState?.maxCalls ?? '100');
  const [callDurationMs, setCallDurationMs] = useState(initialState?.callDurationMs ?? 0);
  // Linux 에서 흔히 쓰는 sipp CLI 옵션들 — 옵션마다 이름표 붙여서 "고급 옵션" 접이식에 노출
  const [maxOpenCalls, setMaxOpenCalls] = useState(initialState?.maxOpenCalls ?? '');
  const [callIdString, setCallIdString] = useState(initialState?.callIdString ?? '');
  const [transport, setTransport] = useState<'u1' | 'un' | 'ui' | 't1' | 'tn' | 'l1' | 'ln'>(initialState?.transport ?? 'u1');
  const [timeoutSec, setTimeoutSec] = useState(initialState?.timeoutSec ?? '');
  const [recvTimeoutMs, setRecvTimeoutMs] = useState(initialState?.recvTimeoutMs ?? '');
  const [sendTimeoutMs, setSendTimeoutMs] = useState(initialState?.sendTimeoutMs ?? '');
  const [maxRetrans, setMaxRetrans] = useState(initialState?.maxRetrans ?? '');
  const [noRetrans, setNoRetrans] = useState(initialState?.noRetrans ?? false);
  const [traceMsg, setTraceMsg] = useState(initialState?.traceMsg ?? false);
  const [traceErr, setTraceErr] = useState(initialState?.traceErr ?? false);
  const [requestUriUser, setRequestUriUser] = useState(initialState?.requestUriUser ?? '');
  const [extraArgs, setExtraArgs] = useState(initialState?.extraArgs ?? '');
  const [advOptsOpen, setAdvOptsOpen] = useState(initialState?.advOptsOpen ?? false);
  // -inf 로 넘길 CSV 데이터 파일 — 첫 줄 SEQUENTIAL/RANDOM/USER, 이후 콜마다
  // ';' 구분 값 한 줄. 시나리오(블록의 From/To 또는 고급 XML)에서 [field0],
  // [field1]... 로 참조한다. 예: 발신/착신 번호 쌍을 콜마다 다르게 주입.
  const [injectionCsv, setInjectionCsv] = useState(initialState?.injectionCsv ?? '');
  const [injectionCsvOpen, setInjectionCsvOpen] = useState(initialState?.injectionCsvOpen ?? false);
  const [scenarioMode, setScenarioMode] = useState<ScenarioMode>(initialState?.scenarioMode ?? 'blocks');
  const [rawScenarioXml, setRawScenarioXml] = useState(initialState?.rawScenarioXml ?? '');
  // 블록 조립 모드 전용: SIP 계층 도메인. 통신사망처럼 발신자/수신자가 서로 다른
  // 도메인에 등록돼 있을 수 있어 From/To 를 따로 지정한다 — 비우면 각각
  // [remote_ip]:[remote_port] (대상 호스트/포트 필드 값)를 그대로 쓴다.
  const [fromDomain, setFromDomain] = useState(initialState?.fromDomain ?? '');
  const [toDomain, setToDomain] = useState(initialState?.toDomain ?? '');
  // 통계 화면(6/7번 화면)의 구간 경계 — 비워도 되지만 비우면 sipp 기본 구간을 씀.
  const [responseTimeRepartition, setResponseTimeRepartition] = useState(initialState?.responseTimeRepartition ?? '10, 20, 30, 40, 50, 100, 150, 200');
  const [callLengthRepartition, setCallLengthRepartition] = useState(initialState?.callLengthRepartition ?? '10, 50, 100, 500, 1000, 5000, 10000');
  const [blocks, setBlocks] = useState<ScenarioBlock[]>(initialState?.blocks ?? (() => [
    newSendBlock('INVITE'),
    { ...newRecvBlock('180'), optional: true },
    { ...newRecvBlock('200'), rtd: true },
    newSendBlock('ACK'),
    newPauseBlock(2000),
    newSendBlock('BYE'),
    { ...newRecvBlock('200'), crlf: true },
  ])());
  const [blockXmlPreviewOpen, setBlockXmlPreviewOpen] = useState(false);

  useEffect(() => {
    if (!onStateChange) return;
    onStateChange({
      targetHost, targetPort, localIp, localPort, cps, maxCalls, callDurationMs, maxOpenCalls, callIdString,
      transport, timeoutSec, recvTimeoutMs, sendTimeoutMs, maxRetrans, noRetrans, traceMsg, traceErr,
      requestUriUser, extraArgs, advOptsOpen, injectionCsv, injectionCsvOpen, scenarioMode, rawScenarioXml,
      fromDomain, toDomain, responseTimeRepartition, callLengthRepartition, blocks,
    });
  }, [
    targetHost, targetPort, localIp, localPort, cps, maxCalls, callDurationMs, maxOpenCalls, callIdString,
    transport, timeoutSec, recvTimeoutMs, sendTimeoutMs, maxRetrans, noRetrans, traceMsg, traceErr,
    requestUriUser, extraArgs, advOptsOpen, injectionCsv, injectionCsvOpen, scenarioMode, rawScenarioXml,
    fromDomain, toDomain, responseTimeRepartition, callLengthRepartition, blocks,
  ]);

  // 데이터 파일(-inf)이 설정돼 있으면 새로 추가하는 전송 블록의 From/To 기본값을
  // sipp/service 대신 [field0]/[field1] 로 시작하게 한다 — 콜마다 다른 번호를 주입하는
  // 게 목적인 기능인데 매번 블록 추가 후 수동으로 고쳐 써야 했다.
  const sendDefaults = (): [string, string] => injectionCsv.trim() ? ['[field0]', '[field1]'] : ['sipp', 'service'];
  const addBlock = (b: ScenarioBlock) => setBlocks(prev => [...prev, b]);
  const insertBlockAt = (index: number, b: ScenarioBlock) => setBlocks(prev => {
    const next = [...prev];
    next.splice(index, 0, b);
    return next;
  });
  const [insertMenuAt, setInsertMenuAt] = useState<number | null>(null);
  const removeBlock = (id: string) => setBlocks(prev => prev.filter(b => b.id !== id));
  const moveBlock = (id: string, dir: -1 | 1) => setBlocks(prev => {
    const idx = prev.findIndex(b => b.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= prev.length) return prev;
    const next = [...prev];
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });
  const updateBlock = (id: string, patch: Partial<ScenarioBlock>) => setBlocks(prev => prev.map(b => b.id === id ? ({ ...b, ...patch } as ScenarioBlock) : b));
  // 드래그앤드롭으로 블록 순서 변경 — sourceId 블록을 targetId 블록의 자리로 옮긴다
  // (targetId 가 있던 자리에 끼워 넣고 나머지는 밀림). 네이티브 HTML5 draggable/dataTransfer 는
  // Chromium 이 드래그 중인 엘리먼트를 자동으로 반투명 "고스트" 이미지로 렌더링하는데 이게 CSS로
  // 안 꺼져서(OS 레벨 드래그 렌더링), mousedown/mousemove/mouseup 으로 직접 구현해 완전히
  // 불투명하게(테두리 강조만) 보이도록 했다.
  const [dragBlockId, setDragBlockId] = useState<string | null>(null);
  const [dragOverBlockId, setDragOverBlockId] = useState<string | null>(null);
  const dragOverIdRef = useRef<string | null>(null);
  // 드래그 중 커서를 따라다니는 불투명 미니 배지 — "지금 뭘 옮기고 있는지" 눈으로 바로 확인
  // 가능하게. 원본 카드를 통째로 복제해 따라다니게 하면 무겁고, 네이티브 고스트 이미지를 다시
  // 쓰면 반투명 문제가 재발하니, 종류 라벨만 담은 작은 배지를 직접 그린다.
  const [dragPreview, setDragPreview] = useState<{ x: number; y: number; label: string; color: string } | null>(null);
  const reorderBlocks = (sourceId: string, targetId: string) => setBlocks(prev => {
    if (sourceId === targetId) return prev;
    const from = prev.findIndex(b => b.id === sourceId);
    const to = prev.findIndex(b => b.id === targetId);
    if (from < 0 || to < 0) return prev;
    const next = [...prev];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  });
  const handleBlockMouseDown = (block: ScenarioBlock) => (e: React.MouseEvent) => {
    if (running) return;
    const id = block.id;
    // 입력/버튼 등 실제 조작을 위한 요소를 누른 거면 드래그를 시작하지 않고 평소대로 동작.
    if ((e.target as HTMLElement).closest('input, textarea, select, button')) return;
    const label = block.kind === 'send' ? `${KIND_LABEL.send} ${block.method}`
      : block.kind === 'recv' ? `${KIND_LABEL.recv} ${block.code}`
      : `${KIND_LABEL.pause} ${block.ms}ms`;
    const color = KIND_COLOR[block.kind];
    const start = { x: e.clientX, y: e.clientY, dragging: false };
    const onMove = (ev: MouseEvent) => {
      if (!start.dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 4) return;
        start.dragging = true;
        setDragBlockId(id);
      }
      setDragPreview({ x: ev.clientX, y: ev.clientY, label, color });
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const cardEl = el?.closest('[data-sipp-block-id]') as HTMLElement | null;
      const overId = cardEl?.getAttribute('data-sipp-block-id') || null;
      dragOverIdRef.current = overId && overId !== id ? overId : null;
      setDragOverBlockId(dragOverIdRef.current);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (start.dragging && dragOverIdRef.current) reorderBlocks(id, dragOverIdRef.current);
      dragOverIdRef.current = null;
      setDragBlockId(null);
      setDragOverBlockId(null);
      setDragPreview(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  // 블록을 클릭(카드 자체에 포커스)해서 선택해두면 Ctrl+↑/↓ 로도 순서를 바꿀 수 있다.
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // "생성된 XML 미리보기" 상호연동: 블록을 고치면 이 텍스트가 자동 갱신되고(xmlDirty
  // 가 false 일 때만), 텍스트를 직접 고치면 xmlDirty=true 로 자동 갱신을 멈춘 뒤
  // blur 시(또는 "블록에 반영" 버튼) 다시 파싱해서 블록 쪽으로 되돌린다.
  const [blockXmlText, setBlockXmlText] = useState('');
  const [xmlDirty, setXmlDirty] = useState(false);
  const [xmlParseError, setXmlParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!xmlDirty) {
      setBlockXmlText(buildXmlFromBlocks(blocks, fromDomain, toDomain, responseTimeRepartition, callLengthRepartition));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, fromDomain, toDomain, responseTimeRepartition, callLengthRepartition, xmlDirty]);

  const applyXmlEdits = () => {
    const parsed = parseXmlToBlocks(blockXmlText);
    if (!parsed) {
      setXmlParseError('XML 파싱 실패 — 블록에 반영되지 않았습니다. <scenario> 구조를 확인하세요.');
      return;
    }
    setBlocks(parsed.blocks);
    setFromDomain(parsed.fromDomain);
    setToDomain(parsed.toDomain);
    if (parsed.responseTimeRepartition) setResponseTimeRepartition(parsed.responseTimeRepartition);
    if (parsed.callLengthRepartition) setCallLengthRepartition(parsed.callLengthRepartition);
    setXmlDirty(false);
    setXmlParseError(null);
  };

  // 저장된 시나리오(블록 조립/고급 XML) 목록 — electron/sippScenarioStore.ts 에 파일로 보관.
  const [savedScenarios, setSavedScenarios] = useState<any[]>([]);
  const [savedScenariosOpen, setSavedScenariosOpen] = useState(false);
  const [scenarioCardCollapsed, setScenarioCardCollapsed] = useState(false);
  const [saveNameInput, setSaveNameInput] = useState('');
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);
  const [savedScenarioMsg, setSavedScenarioMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api().sippScenarioList?.();
        if (Array.isArray(list)) setSavedScenarios(list);
      } catch {}
    })();
  }, []);

  const saveScenario = async (asNew: boolean) => {
    const name = saveNameInput.trim();
    if (!name) { setSavedScenarioMsg('이름을 입력하세요.'); return; }
    const payload: any = { name, mode: scenarioMode };
    if (!asNew && selectedSavedId) payload.id = selectedSavedId;
    if (scenarioMode === 'blocks') {
      payload.blocksData = { blocks, fromDomain, toDomain, responseTimeRepartition, callLengthRepartition };
    } else {
      payload.rawXml = rawScenarioXml;
    }
    // 데이터 파일(-inf) 내용 — 모드(블록/XML) 어느 쪽이든 공통으로 쓰이므로 최상위에 저장.
    payload.injectionCsv = injectionCsv;
    // "대상 / 속도" 카드에 설정한 값도 같이 저장 — 불러올 때 그대로 복원된다.
    payload.targetSettings = {
      targetHost, targetPort, localIp, localPort, cps, maxCalls, callDurationMs,
      maxOpenCalls, callIdString, transport, timeoutSec, recvTimeoutMs, sendTimeoutMs,
      maxRetrans, noRetrans, traceMsg, traceErr, requestUriUser, extraArgs,
    };
    try {
      const saved = await api().sippScenarioSave?.(payload);
      if (saved?.id) {
        setSelectedSavedId(saved.id);
        setSavedScenarios(prev => {
          const idx = prev.findIndex(s => s.id === saved.id);
          if (idx === -1) return [...prev, saved];
          const next = [...prev];
          next[idx] = saved;
          return next;
        });
        setSavedScenarioMsg(`저장됨: ${name}`);
      }
    } catch (e: any) {
      setSavedScenarioMsg(String(e?.message || e));
    }
  };

  const loadScenario = (s: any) => {
    setInjectionCsv(typeof s.injectionCsv === 'string' ? s.injectionCsv : '');
    if (s.mode === 'xml') {
      setScenarioMode('xml');
      setRawScenarioXml(s.rawXml || '');
    } else {
      setScenarioMode('blocks');
      const d = s.blocksData || {};
      setBlocks(Array.isArray(d.blocks) ? d.blocks : []);
      setFromDomain(d.fromDomain || '');
      setToDomain(d.toDomain || '');
      setResponseTimeRepartition(d.responseTimeRepartition || '10, 20, 30, 40, 50, 100, 150, 200');
      setCallLengthRepartition(d.callLengthRepartition || '10, 50, 100, 500, 1000, 5000, 10000');
      setXmlDirty(false);
    }
    const t = s.targetSettings;
    if (t) {
      if (t.targetHost !== undefined) setTargetHost(t.targetHost);
      if (t.targetPort !== undefined) setTargetPort(t.targetPort);
      if (t.localIp !== undefined) setLocalIp(t.localIp);
      if (t.localPort !== undefined) setLocalPort(t.localPort);
      if (t.cps !== undefined) setCps(t.cps);
      if (t.maxCalls !== undefined) setMaxCalls(t.maxCalls);
      if (t.callDurationMs !== undefined) setCallDurationMs(t.callDurationMs);
      if (t.maxOpenCalls !== undefined) setMaxOpenCalls(t.maxOpenCalls);
      if (t.callIdString !== undefined) setCallIdString(t.callIdString);
      if (t.transport !== undefined) setTransport(t.transport);
      if (t.timeoutSec !== undefined) setTimeoutSec(t.timeoutSec);
      if (t.recvTimeoutMs !== undefined) setRecvTimeoutMs(t.recvTimeoutMs);
      if (t.sendTimeoutMs !== undefined) setSendTimeoutMs(t.sendTimeoutMs);
      if (t.maxRetrans !== undefined) setMaxRetrans(t.maxRetrans);
      if (t.noRetrans !== undefined) setNoRetrans(t.noRetrans);
      if (t.traceMsg !== undefined) setTraceMsg(t.traceMsg);
      if (t.traceErr !== undefined) setTraceErr(t.traceErr);
      if (t.requestUriUser !== undefined) setRequestUriUser(t.requestUriUser);
      if (t.extraArgs !== undefined) setExtraArgs(t.extraArgs);
    }
    setSelectedSavedId(s.id);
    setSaveNameInput(s.name);
    setSavedScenarioMsg(`불러옴: ${s.name}`);
  };

  const deleteScenario = async (s: any) => {
    if (!(await notifyConfirm('시나리오 삭제', `"${s.name}" 시나리오를 삭제할까요?`))) return;
    try {
      await api().sippScenarioDelete?.({ id: s.id });
      setSavedScenarios(prev => prev.filter(x => x.id !== s.id));
      if (selectedSavedId === s.id) { setSelectedSavedId(null); setSaveNameInput(''); }
    } catch {}
  };

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SippStats>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logCollapsed, setLogCollapsed] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);
  // 진행 중엔 SIPp 의 "Scenario Screen"(스텝별 메시지 흐름), 테스트가 끝나면
  // "Statistics Screen"(누적 통계)을 그대로 화면에 보여준다 — 실제 sipp 콘솔과 동일한 뷰.
  const [scenarioScreen, setScenarioScreen] = useState('');
  const [statisticsScreen, setStatisticsScreen] = useState('');
  const [screenPhase, setScreenPhase] = useState<'idle' | 'running' | 'done'>('idle');

  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      try {
        const st = await api().sippStatus?.({ id: instanceId });
        if (st) setRunning(!!st.running);
      } catch {}
      unsub = api().onSippEvent?.((p: any) => {
        // 브로드캐스트는 모든 SippWorkspace 인스턴스에 도달하므로, 내 탭(id) 이벤트만 처리한다.
        if (!p || p.sippId !== instanceId) return;
        if (p.ev === 'started') {
          setRunning(true); setError(null); setStats({}); setLogLines([]);
          setScenarioScreen(''); setStatisticsScreen(''); setScreenPhase('running');
          setPaused(false);
        }
        else if (p.ev === 'exit') { setRunning(false); }
        else if (p.ev === 'error') { setError(p.error || '알 수 없는 오류'); setRunning(false); }
        else if (p.ev === 'stats') { setStats(prev => ({ ...prev, ...p.stats })); }
        else if (p.ev === 'screen') {
          if (p.kind === 'scenario') { setScenarioScreen(String(p.text || '')); setScreenPhase(prev => prev === 'done' ? prev : 'running'); }
          else if (p.kind === 'statistics') { setStatisticsScreen(String(p.text || '')); setScreenPhase('done'); }
        }
        else if (p.ev === 'log') {
          setLogLines(prev => {
            const next = [...prev, String(p.text || '')].slice(-500);
            return next;
          });
        }
      });
    })();
    return () => { try { unsub?.(); } catch {} };
  }, [instanceId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  const start = async () => {
    setError(null);
    const host = targetHost.trim();
    const maxCallsNum = maxCalls.trim() ? Number(maxCalls) : undefined;
    // 127.0.0.1/localhost 가 아닌 실제 장비를 대상으로 콜을 여러 개(또는 무제한) 쏘려는
    // 경우, 실수로 대량의 실제 콜이 나가는 것(운영 스위치로 나가는 경우 특히 위험)을
    // 막기 위해 시작 전 한 번 더 확인한다.
    const isLoopback = LOOPBACK_HOSTS.has(host);
    const isBulk = maxCallsNum === undefined || maxCallsNum > 1;
    if (!isLoopback && isBulk) {
      const countLabel = maxCallsNum === undefined ? '무제한' : `${maxCallsNum}개`;
      const confirmed = await notifyConfirm(
        '실제 장비로 콜 발생',
        `대상 ${host}:${targetPort} 로 CPS ${cps}, 최대 콜 수 ${countLabel} 설정으로 실제 SIP 콜을 보냅니다. 실제 통신 장비/서비스에 영향을 줄 수 있습니다. 계속할까요?`
      );
      if (!confirmed) return;
    }
    const opts: any = {
      targetHost: host,
      targetPort: Number(targetPort) || 5060,
      cps: Number(cps) || 1,
      callDurationMs: Number(callDurationMs) || 0,
    };
    if (localIp.trim()) opts.localIp = localIp.trim();
    if (localPort.trim()) opts.localPort = Number(localPort);
    if (maxCallsNum !== undefined) opts.maxCalls = maxCallsNum;
    if (injectionCsv.trim()) opts.injectionCsv = injectionCsv;
    if (maxOpenCalls.trim()) opts.maxOpenCalls = Number(maxOpenCalls);
    if (callIdString.trim()) opts.callIdString = callIdString.trim();
    if (transport !== 'u1') opts.transport = transport;
    if (timeoutSec.trim()) opts.timeoutSec = Number(timeoutSec);
    if (recvTimeoutMs.trim()) opts.recvTimeoutMs = Number(recvTimeoutMs);
    if (sendTimeoutMs.trim()) opts.sendTimeoutMs = Number(sendTimeoutMs);
    if (maxRetrans.trim()) opts.maxRetrans = Number(maxRetrans);
    if (noRetrans) opts.noRetrans = true;
    if (traceMsg) opts.traceMsg = true;
    if (traceErr) opts.traceErr = true;
    if (requestUriUser.trim()) opts.requestUriUser = requestUriUser.trim();
    if (extraArgs.trim()) opts.extraArgs = extraArgs.trim();
    if (scenarioMode === 'xml') {
      if (!rawScenarioXml.trim()) { setError('시나리오 XML을 입력하세요.'); return; }
      opts.rawScenarioXml = rawScenarioXml;
    } else {
      if (blocks.length === 0 && !blockXmlText.trim()) { setError('시나리오 블록을 하나 이상 추가하세요.'); return; }
      // 미리보기 박스에 직접 편집한 내용이 있으면(블록에 아직 반영 전이라도) 화면에
      // 보이는 그대로를 실제 실행에 쓴다 — "미리보기"가 곧 진짜 시나리오가 되도록.
      opts.rawScenarioXml = blockXmlText;
    }
    try {
      const res = await api().sippStart?.({ id: instanceId, opts });
      if (!res?.ok) setError(res?.error || '시작 실패');
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  };

  const stop = async () => {
    try { await api().sippStop?.({ id: instanceId }); } catch {}
  };

  const [rateApplyMsg, setRateApplyMsg] = useState<string | null>(null);
  const applyRate = async (value?: number) => {
    const target = value ?? Number(cps);
    setRateApplyMsg(null);
    try {
      const res = await api().sippSetRate?.({ id: instanceId, cps: target });
      setRateApplyMsg(res?.ok ? `CPS ${target} 적용됨 (최대 0.3초 내 반영)` : (res?.error || '적용 실패'));
    } catch (e: any) {
      setRateApplyMsg(String(e?.message || e));
    }
  };
  // SIPp 인터랙티브 키('+'/'-' 는 1cps, '*'/'/' 는 10cps 단위 조절, 'p' 는 일시정지) 와
  // 동일한 동작을 버튼으로 노출 — 내부적으로 -ctrl_file 에 씀.
  const adjustRate = async (delta: number) => {
    const next = Math.max(1, Number(cps) + delta);
    setCps(next);
    await applyRate(next);
  };
  const [paused, setPaused] = useState(false);
  const [pauseMsg, setPauseMsg] = useState<string | null>(null);
  const togglePause = async () => {
    setPauseMsg(null);
    const next = !paused;
    try {
      const res = await api().sippSetPaused?.({ id: instanceId, paused: next });
      if (res?.ok) { setPaused(next); }
      else { setPauseMsg(res?.error || '적용 실패'); }
    } catch (e: any) {
      setPauseMsg(String(e?.message || e));
    }
  };

  const canStart = !running && targetHost.trim().length > 0 && Number(targetPort) > 0 && Number(cps) > 0;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--win-bg, #0d1117)', color: 'var(--win-text, #e6edf3)', overflow: 'auto', padding: 12, gap: 12 }}>
      {dragPreview && (
        <div
          style={{
            position: 'fixed', left: dragPreview.x + 14, top: dragPreview.y + 14, zIndex: 10000,
            pointerEvents: 'none', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 999,
            background: dragPreview.color, color: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            whiteSpace: 'nowrap',
          }}
        >
          ⠿ {dragPreview.label}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>📶 SIPp 워크스페이스</span>
        <span style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)' }}>네이티브 SIPp 부하 발생기 — 헤더/바디 편집, CPS(초당 콜 수) 제어</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 999, background: running ? '#238636' : 'var(--win-surface-2, #21262d)', color: running ? '#fff' : 'var(--win-text-dim, #9aa7b3)' }}>
          {running ? '실행 중' : '대기'}
        </span>
      </div>

      {error && (
        <div style={{ padding: 8, borderRadius: 6, background: '#3d1518', border: '1px solid #f85149', color: '#e6edf3', fontSize: 12 }}>{error}</div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ ...card, flex: '2 1 480px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>대상 / 속도</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 2 }}>
              <label style={label}>대상 호스트</label>
              <input style={inp} value={targetHost} onChange={e => setTargetHost(e.target.value)} disabled={running} placeholder="127.0.0.1" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>포트</label>
              <input style={inp} type="number" value={targetPort} onChange={e => setTargetPort(Number(e.target.value))} disabled={running} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>로컬 IP (선택)</label>
              <input style={inp} value={localIp} onChange={e => setLocalIp(e.target.value)} disabled={running} placeholder="자동" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>로컬 포트 (선택)</label>
              <input style={inp} value={localPort} onChange={e => setLocalPort(e.target.value)} disabled={running} placeholder="자동" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>CPS (초당 콜){running ? ' — 실행 중 조절 가능' : ''}</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input style={inp} type="number" min={1} value={cps} onChange={e => { setCps(Number(e.target.value)); setRateApplyMsg(null); }} />
                {running && (
                  <button onClick={() => applyRate()} style={{ ...btn(Number(cps) > 0), padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap' }} disabled={!(Number(cps) > 0)}>적용</button>
                )}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>최대 콜 수 (비우면 무제한)</label>
              <input style={inp} value={maxCalls} onChange={e => setMaxCalls(e.target.value)} disabled={running} placeholder="예: 100" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>콜 유지 시간(ms)</label>
              <input style={inp} type="number" min={0} value={callDurationMs} onChange={e => setCallDurationMs(Number(e.target.value))} disabled={running} />
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <div
              style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', cursor: running ? 'default' : 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => !running && setAdvOptsOpen(v => !v)}
            >
              <span style={{ fontSize: 9, transform: advOptsOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▼</span>
              고급 옵션 (Linux sipp CLI 옵션 매핑)
            </div>
            {advOptsOpen && (
              <div style={{ marginTop: 6 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <label style={label}>최대 동시 콜 (-l)</label>
                    <input style={inp} value={maxOpenCalls} onChange={e => setMaxOpenCalls(e.target.value)} disabled={running} placeholder="비우면 sipp 기본값" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={label}>Call-ID 형식 (-cid_str)</label>
                    <input style={inp} value={callIdString} onChange={e => setCallIdString(e.target.value)} disabled={running} placeholder="비우면 %u-%p@%s" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={label}>전송 방식 (-t)</label>
                    <select style={inp} value={transport} disabled={running} onChange={e => setTransport(e.target.value as any)}>
                      <option value="u1">u1 — UDP 소켓 1개 (기본)</option>
                      <option value="un">un — UDP, 콜마다 소켓</option>
                      <option value="ui">ui — UDP, IP당 소켓</option>
                      <option value="t1">t1 — TCP 소켓 1개</option>
                      <option value="tn">tn — TCP, 콜마다 소켓</option>
                      <option value="l1">l1 — TLS 소켓 1개</option>
                      <option value="ln">ln — TLS, 콜마다 소켓</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <label style={label}>타임아웃 (-timeout, 초)</label>
                    <input style={inp} type="number" min={0} value={timeoutSec} onChange={e => setTimeoutSec(e.target.value)} disabled={running} placeholder="비우면 무제한" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={label}>응답 수신 타임아웃 (-recv_timeout, ms)</label>
                    <input style={inp} type="number" min={0} value={recvTimeoutMs} onChange={e => setRecvTimeoutMs(e.target.value)} disabled={running} placeholder="비우면 sipp 기본값" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={label}>전송 타임아웃 (-send_timeout, ms)</label>
                    <input style={inp} type="number" min={0} value={sendTimeoutMs} onChange={e => setSendTimeoutMs(e.target.value)} disabled={running} placeholder="비우면 sipp 기본값" />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
                  <div style={{ flex: 1 }}>
                    <label style={label}>최대 재전송 횟수 (-max_retrans)</label>
                    <input style={inp} type="number" min={0} value={maxRetrans} onChange={e => setMaxRetrans(e.target.value)} disabled={running} placeholder="비우면 sipp 기본값(INVITE 5회)" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={label}>Request-URI 사용자명 (-s)</label>
                    <input style={inp} value={requestUriUser} onChange={e => setRequestUriUser(e.target.value)} disabled={running} placeholder="비우면 'service'" />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 14, marginBottom: 6, flexWrap: 'wrap' }}>
                  <label style={{ ...label, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4, cursor: running ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={noRetrans} disabled={running} onChange={e => setNoRetrans(e.target.checked)} />
                    UDP 재전송 비활성화 (-nr)
                  </label>
                  <label style={{ ...label, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4, cursor: running ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={traceMsg} disabled={running} onChange={e => setTraceMsg(e.target.checked)} />
                    메시지 로그 저장 (-trace_msg)
                  </label>
                  <label style={{ ...label, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4, cursor: running ? 'default' : 'pointer' }}>
                    <input type="checkbox" checked={traceErr} disabled={running} onChange={e => setTraceErr(e.target.checked)} />
                    에러 로그 저장 (-trace_err)
                  </label>
                </div>
                <label style={label}>기타 옵션 (위에 없는 나머지 sipp CLI 옵션을 그대로, 공백으로 구분)</label>
                <input style={inp} value={extraArgs} onChange={e => setExtraArgs(e.target.value)} disabled={running} placeholder='예: -rp 500 -users 50' />
              </div>
            )}
          </div>

          {rateApplyMsg && <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', marginTop: 4 }}>{rateApplyMsg}</div>}
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8 }}>
              <button onClick={() => adjustRate(-10)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="10cps 감소 ('/' 키와 동일)">-10</button>
              <button onClick={() => adjustRate(-1)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="1cps 감소 ('-' 키와 동일)">-1</button>
              <button onClick={() => adjustRate(1)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="1cps 증가 ('+' 키와 동일)">+1</button>
              <button onClick={() => adjustRate(10)} style={{ ...btn(true), padding: '4px 8px', fontSize: 11, flex: 1 }} title="10cps 증가 ('*' 키와 동일)">+10</button>
            </div>
          )}
          {pauseMsg && <div style={{ fontSize: 10, color: '#f85149', marginTop: 4 }}>{pauseMsg}</div>}
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            {!running ? (
              <button style={{ ...btn(canStart), flex: 1 }} disabled={!canStart} onClick={start}>▶ 테스트 시작</button>
            ) : (
              <>
                <button style={{ ...btn(true, 'danger'), flex: 1 }} onClick={stop}>■ 중지</button>
                <button style={{ ...btn(true, paused ? 'primary' : 'danger'), flex: 1 }} onClick={togglePause} title="트래픽 일시정지/재개 ('p' 키와 동일)">
                  {paused ? '▶ 재개' : '⏸ 일시정지'}
                </button>
              </>
            )}
          </div>
        </div>

        <div style={{ ...card, flex: '1 1 280px' }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>요약</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            <StatBox label="생성된 콜" value={stats.callsCreated} />
            <StatBox label="현재 콜" value={stats.currentCalls} />
            <StatBox label="성공" value={stats.successfulCalls} color="#3fb950" />
            <StatBox label="실패" value={stats.failedCalls} color={stats.failedCalls ? '#f85149' : undefined} />
            <StatBox label="실측 CPS" value={stats.cps} />
            <StatBox label="경과 시간" value={stats.elapsed as any} />
          </div>
        </div>
      </div>

      {screenPhase !== 'idle' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, flexShrink: 0 }}>
          <ScreenPanel
            title="📟 Scenario Screen (진행 중 메시지별 건수)"
            badge={screenPhase === 'running' ? '실행 중' : '완료'}
            badgeColor={screenPhase === 'running' ? '#9e6a03' : '#238636'}
            text={scenarioScreen}
          />
          <ScreenPanel
            title="📊 Statistics Screen (종료 후 누적 통계)"
            badge={statisticsScreen ? '완료' : '대기'}
            badgeColor={statisticsScreen ? '#238636' : 'var(--win-surface-2, #21262d)'}
            text={statisticsScreen}
          />
        </div>
      )}

      <div style={card}>
        <div
          style={{ fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setInjectionCsvOpen(v => !v)}
        >
          <span style={{ fontSize: 10, transform: injectionCsvOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▼</span>
          데이터 파일 (-inf, 콜마다 다른 번호 주입)
          {injectionCsv.trim() && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: '#238636', color: '#fff' }}>사용 중</span>}
        </div>
        {injectionCsvOpen && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 6 }}>
              첫 줄은 <b>SEQUENTIAL</b>/<b>RANDOM</b>/<b>USER</b>, 이후 콜마다 한 줄씩 <code>;</code> 로 구분된 값. 아래에 값이 있으면 새로 추가하는 전송 블록의 From/To 가 자동으로 <code>[field0]</code>, <code>[field1]</code>... 을 참조하도록 채워집니다.
            </div>
            <textarea
              style={{ ...inp, minHeight: 100, fontFamily: 'monospace', resize: 'vertical' }}
              value={injectionCsv}
              onChange={e => setInjectionCsv(e.target.value)}
              disabled={running}
              placeholder={'SEQUENTIAL\n03280001000;03290001000\n03280001001;03290001001\n03280001002;03290001002'}
            />
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: scenarioCardCollapsed ? 0 : 12 }}>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setScenarioCardCollapsed(v => !v)}
          >
            <span style={{ fontSize: 10, transform: scenarioCardCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▼</span>
            <span style={{ fontSize: 12, fontWeight: 700 }}>시나리오</span>
          </div>
          {!scenarioCardCollapsed && (
            <>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 2, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, padding: 2 }}>
                {(['blocks', 'xml'] as ScenarioMode[]).map(m => (
                  <button
                    key={m}
                    onClick={() => setScenarioMode(m)}
                    disabled={running}
                    style={{
                      padding: '5px 12px', fontSize: 11, fontWeight: 700, borderRadius: 5, border: 'none',
                      background: scenarioMode === m ? 'var(--win-accent, #2b6b9b)' : 'transparent',
                      color: scenarioMode === m ? '#fff' : 'var(--win-text-dim, #9aa7b3)',
                      cursor: running ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {m === 'blocks' ? '🧩 블록 조립' : '고급 XML'}
                  </button>
                ))}
              </div>
              {!running && (
                scenarioMode === 'blocks' ? (
                  <button
                    onClick={() => { setRawScenarioXml(blockXmlText); setScenarioMode('xml'); }}
                    title="블록 조립에서 생성된 XML을 고급 XML 모드로 복사"
                    style={{ ...btn(true), padding: '5px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                  >
                    → 고급 XML로 보내기
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      const parsed = parseXmlToBlocks(rawScenarioXml);
                      if (!parsed) { setError('XML 파싱 실패 — 블록 조립으로 보낼 수 없습니다. <scenario> 구조를 확인하세요.'); return; }
                      setBlocks(parsed.blocks);
                      setFromDomain(parsed.fromDomain);
                      setToDomain(parsed.toDomain);
                      if (parsed.responseTimeRepartition) setResponseTimeRepartition(parsed.responseTimeRepartition);
                      if (parsed.callLengthRepartition) setCallLengthRepartition(parsed.callLengthRepartition);
                      setXmlDirty(false);
                      setScenarioMode('blocks');
                      setError(null);
                    }}
                    title="고급 XML을 블록 조립으로 변환"
                    style={{ ...btn(true), padding: '5px 10px', fontSize: 11, whiteSpace: 'nowrap' }}
                  >
                    → 블록 조립으로 보내기
                  </button>
                )
              )}
            </>
          )}
        </div>

        {!scenarioCardCollapsed && (
          <div style={{ marginBottom: 12 }}>
            <div
              style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => setSavedScenariosOpen(v => !v)}
            >
              <span style={{ fontSize: 9, transform: savedScenariosOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▼</span>
              💾 저장된 시나리오 {savedScenarios.length > 0 && `(${savedScenarios.length})`}
            </div>
            {savedScenariosOpen && (
              <div style={{ marginTop: 6, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, padding: 8 }}>
                <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                  <input
                    style={{ ...inp, flex: 1 }}
                    value={saveNameInput}
                    disabled={running}
                    onChange={e => { setSaveNameInput(e.target.value); setSavedScenarioMsg(null); }}
                    placeholder="시나리오 이름"
                  />
                  <button onClick={() => saveScenario(false)} disabled={running || !saveNameInput.trim()} style={{ ...btn(!running && !!saveNameInput.trim()), padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {selectedSavedId ? '덮어쓰기' : '저장'}
                  </button>
                  {selectedSavedId && (
                    <button onClick={() => saveScenario(true)} disabled={running || !saveNameInput.trim()} style={{ ...btn(!running && !!saveNameInput.trim()), padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap' }}>
                      새로 저장
                    </button>
                  )}
                </div>
                {savedScenarioMsg && <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 8 }}>{savedScenarioMsg}</div>}

                {savedScenarios.length === 0 ? (
                  <div style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', textAlign: 'center', padding: 8 }}>저장된 시나리오가 없습니다.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {savedScenarios.map(s => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 4, background: selectedSavedId === s.id ? 'var(--win-surface-2, #21262d)' : 'transparent' }}>
                        <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: s.mode === 'xml' ? '#8250df' : '#2b6b9b', color: '#fff' }}>{s.mode === 'xml' ? 'XML' : '블록'}</span>
                        <span style={{ fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                        <button onClick={() => loadScenario(s)} disabled={running} style={{ ...btn(!running), padding: '3px 8px', fontSize: 10 }}>불러오기</button>
                        <button onClick={() => deleteScenario(s)} disabled={running} style={{ ...btn(!running, 'danger'), padding: '3px 8px', fontSize: 10 }}>삭제</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!scenarioCardCollapsed && scenarioMode === 'xml' && (
          <div>
            <label style={label}>전체 SIPp 시나리오 XML (INVITE/ACK/BYE 흐름을 직접 정의)</label>
            <textarea style={{ ...inp, minHeight: 220, fontFamily: 'monospace', resize: 'vertical' }} value={rawScenarioXml} onChange={e => setRawScenarioXml(e.target.value)} disabled={running} placeholder={'<?xml version="1.0" encoding="ISO-8859-1" ?>\n<!DOCTYPE scenario SYSTEM "sipp.dtd">\n<scenario name="Custom">\n  ...\n</scenario>'} />
          </div>
        )}

        {!scenarioCardCollapsed && scenarioMode === 'blocks' && (
          <div>
            <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 8 }}>
              메시지 전송/응답 대기/일시정지 블록을 순서대로 쌓아서 통화 흐름을 조립합니다. 위/아래 화살표로, 블록 아무 곳이나 드래그해서, 또는 블록을 클릭해 선택한 뒤 Ctrl+↑/↓ 로 순서를 바꿀 수 있어요.
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <div style={{ flex: 1, maxWidth: 260 }}>
                <label style={label}>From 도메인 (선택)</label>
                <input style={inp} value={fromDomain} disabled={running} onChange={e => setFromDomain(e.target.value)} placeholder="skbroadband.com" />
              </div>
              <div style={{ flex: 1, maxWidth: 260 }}>
                <label style={label}>To 도메인 (선택)</label>
                <input style={inp} value={toDomain} disabled={running} onChange={e => setToDomain(e.target.value)} placeholder="tbssw001.catvphone.com" />
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', marginBottom: 10 }}>
              비워두면 [remote_ip]:[remote_port] (대상 호스트/포트) 사용 — From/To 는 서로 다른 도메인으로 지정 가능
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {!running && (
                <InsertGap
                  open={insertMenuAt === 0}
                  onToggle={() => setInsertMenuAt(v => v === 0 ? null : 0)}
                  onInsert={b => { insertBlockAt(0, b); setInsertMenuAt(null); }}
                  fieldDefaults={sendDefaults()}
                />
              )}
              {blocks.map((b, i) => (
                <React.Fragment key={b.id}>
                  <BlockEditor
                    block={b}
                    index={i}
                    total={blocks.length}
                    disabled={running}
                    onChange={patch => updateBlock(b.id, patch)}
                    onRemove={() => removeBlock(b.id)}
                    onMove={dir => moveBlock(b.id, dir)}
                    isSelected={selectedBlockId === b.id}
                    onSelect={() => setSelectedBlockId(b.id)}
                    isDragging={dragBlockId === b.id}
                    isDragOver={dragOverBlockId === b.id && dragBlockId !== b.id}
                    onBlockMouseDown={handleBlockMouseDown(b)}
                  />
                  {!running && (
                    <InsertGap
                      open={insertMenuAt === i + 1}
                      onToggle={() => setInsertMenuAt(v => v === i + 1 ? null : i + 1)}
                      onInsert={b2 => { insertBlockAt(i + 1, b2); setInsertMenuAt(null); }}
                      fieldDefaults={sendDefaults()}
                    />
                  )}
                </React.Fragment>
              ))}
              {blocks.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', textAlign: 'center', padding: 16 }}>블록이 없습니다. 위 + 를 눌러 추가하세요.</div>
              )}
            </div>

            {!running && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {SEND_METHODS.map(m => (
                  <button key={m} onClick={() => addBlock(newSendBlock(m, ...sendDefaults()))} style={{ ...btn(true), padding: '5px 10px', fontSize: 11 }}>+ {m}</button>
                ))}
                <button onClick={() => addBlock(newSendBlock('CUSTOM'))} style={{ ...btn(true), padding: '5px 10px', fontSize: 11 }}>+ 커스텀 메시지</button>
                <button onClick={() => addBlock(newRecvBlock('200'))} style={{ ...btn(true), padding: '5px 10px', fontSize: 11 }}>+ 응답 대기</button>
                <button onClick={() => addBlock(newPauseBlock(1000))} style={{ ...btn(true), padding: '5px 10px', fontSize: 11 }}>+ 일시정지</button>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={label}>응답시간 통계 구간 (ResponseTimeRepartition, ms)</label>
                <input style={inp} value={responseTimeRepartition} disabled={running} onChange={e => setResponseTimeRepartition(e.target.value)} placeholder="10, 20, 30, 40, 50, 100, 150, 200" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={label}>통화시간 통계 구간 (CallLengthRepartition, ms)</label>
                <input style={inp} value={callLengthRepartition} disabled={running} onChange={e => setCallLengthRepartition(e.target.value)} placeholder="10, 50, 100, 500, 1000, 5000, 10000" />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  style={{ fontSize: 11, color: 'var(--win-text-dim, #9aa7b3)', cursor: 'pointer', userSelect: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setBlockXmlPreviewOpen(v => !v)}
                >
                  <span style={{ fontSize: 9, transform: blockXmlPreviewOpen ? 'none' : 'rotate(-90deg)', display: 'inline-block' }}>▼</span>
                  생성된 XML (직접 편집 가능 — 편집하면 블록에도 반영됩니다)
                </div>
                {blockXmlPreviewOpen && xmlDirty && !running && (
                  <button onClick={applyXmlEdits} style={{ ...btn(true), padding: '2px 10px', fontSize: 10 }}>블록에 반영</button>
                )}
                {blockXmlPreviewOpen && xmlDirty && (
                  <span style={{ fontSize: 10, color: '#9e6a03' }}>편집됨 (blur 시 자동 반영)</span>
                )}
              </div>
              {blockXmlPreviewOpen && (
                <>
                  <textarea
                    value={blockXmlText}
                    disabled={running}
                    onChange={e => { setBlockXmlText(e.target.value); setXmlDirty(true); setXmlParseError(null); }}
                    onBlur={() => { if (xmlDirty) applyXmlEdits(); }}
                    style={{ width: '100%', boxSizing: 'border-box', margin: '6px 0 0', padding: 10, background: '#010409', color: '#8b949e', fontFamily: 'Consolas, monospace', fontSize: 10, lineHeight: 1.4, minHeight: 260, resize: 'vertical', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, whiteSpace: 'pre' }}
                  />
                  {xmlParseError && <div style={{ fontSize: 10, color: '#f85149', marginTop: 4 }}>{xmlParseError}</div>}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ ...card, flex: logCollapsed ? '0 0 auto' : 1, display: 'flex', flexDirection: 'column', minHeight: logCollapsed ? 0 : 400 }}>
        <div
          style={{ fontSize: 12, fontWeight: 700, marginBottom: logCollapsed ? 0 : 8, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}
          onClick={() => setLogCollapsed(v => !v)}
        >
          <span style={{ fontSize: 10, transform: logCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▼</span>
          실행 로그
          <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)', fontWeight: 400 }}>({logLines.length}줄)</span>
        </div>
        {!logCollapsed && (
          <div ref={logRef} style={{ flex: 1, overflow: 'auto', minHeight: 340, background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, padding: 8, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--win-text-dim, #9aa7b3)' }}>
            {logLines.length === 0 ? '테스트를 시작하면 SIPp 출력이 여기 표시됩니다.' : logLines.join('')}
          </div>
        )}
      </div>
    </div>
  );
};

const StatBox: React.FC<{ label: string; value?: number | string; color?: string }> = ({ label: l, value, color }) => (
  <div style={{ background: 'var(--win-bg, #0d1117)', border: '1px solid var(--win-border, #30363d)', borderRadius: 6, padding: '6px 10px' }}>
    <div style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{l}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: color || 'var(--win-text, #e6edf3)' }}>{value ?? '—'}</div>
  </div>
);

const ScreenPanel: React.FC<{ title: string; badge: string; badgeColor: string; text: string }> = ({ title, badge, badgeColor, text }) => (
  <div style={{ background: 'var(--win-surface, #161b22)', border: '1px solid var(--win-border, #30363d)', borderRadius: 8, padding: 0, overflow: 'hidden', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--win-border, #30363d)' }}>
      <span style={{ fontSize: 12, fontWeight: 700 }}>{title}</span>
      <span style={{ marginLeft: 'auto', fontSize: 10, padding: '2px 8px', borderRadius: 999, background: badgeColor, color: badgeColor === 'var(--win-surface-2, #21262d)' ? 'var(--win-text-dim, #9aa7b3)' : '#fff' }}>{badge}</span>
    </div>
    <pre style={{ margin: 0, padding: 12, background: '#010409', color: '#c9d1d9', fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12, lineHeight: 1.5, overflow: 'auto', minHeight: 420, maxHeight: 640, whiteSpace: 'pre', flex: 1 }}>
      {text || '테스트를 시작하면 화면이 여기 표시됩니다.'}
    </pre>
  </div>
);

const KIND_COLOR: Record<ScenarioBlock['kind'], string> = { send: '#2b6b9b', recv: '#238636', pause: '#6e7681' };
const KIND_LABEL: Record<ScenarioBlock['kind'], string> = { send: '전송', recv: '응답 대기', pause: '일시정지' };
const miniInp: React.CSSProperties = { ...inp, padding: '4px 6px', fontSize: 11 };
const miniLabel: React.CSSProperties = { ...label, fontSize: 10, marginBottom: 2 };

// 블록 사이 삽입 지점 — 여기를 누르면 바로 이 위치에 원하는 종류의 블록을 끼워 넣는다.
// 기존에는 항상 맨 끝에 추가한 뒤 화살표로 하나씩 옮겨야 했던 불편함을 없애기 위함.
const InsertGap: React.FC<{ open: boolean; onToggle: () => void; onInsert: (b: ScenarioBlock) => void; fieldDefaults: [string, string] }> = ({ open, onToggle, onInsert, fieldDefaults }) => (
  <div style={{ display: 'flex', justifyContent: 'center', margin: open ? '4px 0' : '1px 0' }}>
    {!open ? (
      <div
        onClick={onToggle}
        title="여기에 블록 추가"
        style={{
          width: '100%', height: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', position: 'relative',
        }}
        onMouseEnter={e => { (e.currentTarget.firstChild as HTMLElement).style.opacity = '1'; }}
        onMouseLeave={e => { (e.currentTarget.firstChild as HTMLElement).style.opacity = '0'; }}
      >
        <span style={{
          opacity: 0, transition: 'opacity 0.1s', fontSize: 11, fontWeight: 700, color: '#fff',
          background: 'var(--win-accent, #2b6b9b)', width: 18, height: 18, borderRadius: 999,
          display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
        }}>+</span>
      </div>
    ) : (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center', background: 'var(--win-bg, #0d1117)', border: '1px dashed var(--win-border, #30363d)', borderRadius: 6, padding: 6, width: '100%' }}>
        {SEND_METHODS.map(m => (
          <button key={m} onClick={() => onInsert(newSendBlock(m, ...fieldDefaults))} style={{ ...btn(true), padding: '3px 8px', fontSize: 10 }}>+ {m}</button>
        ))}
        <button onClick={() => onInsert(newSendBlock('CUSTOM'))} style={{ ...btn(true), padding: '3px 8px', fontSize: 10 }}>+ 커스텀</button>
        <button onClick={() => onInsert(newRecvBlock('200'))} style={{ ...btn(true), padding: '3px 8px', fontSize: 10 }}>+ 응답 대기</button>
        <button onClick={() => onInsert(newPauseBlock(1000))} style={{ ...btn(true), padding: '3px 8px', fontSize: 10 }}>+ 일시정지</button>
        <button onClick={onToggle} style={{ ...btn(true, 'danger'), padding: '3px 8px', fontSize: 10 }}>✕</button>
      </div>
    )}
  </div>
);

const BlockEditor: React.FC<{
  block: ScenarioBlock;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (patch: Partial<ScenarioBlock>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  isSelected?: boolean;
  onSelect?: () => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  onBlockMouseDown?: (e: React.MouseEvent) => void;
}> = ({ block, index, total, disabled, onChange, onRemove, onMove, isSelected, onSelect, isDragging, isDragOver, onBlockMouseDown }) => {
  const send = block.kind === 'send' ? block : null;
  const cardRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={cardRef}
      data-sipp-block-id={block.id}
      tabIndex={0}
      onMouseDown={onBlockMouseDown}
      onClick={() => onSelect?.()}
      onFocus={() => onSelect?.()}
      onKeyDown={e => {
        // 텍스트 필드(입력/textarea/select) 안에서 Ctrl+↑/↓ 를 누른 거면 그쪽 자체 동작(커서
        // 이동 등)을 건드리지 않고 그냥 통과시킨다 — 카드 자체가 포커스일 때만 순서 변경.
        if (e.target !== e.currentTarget || disabled) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === 'ArrowUp' && index > 0) { e.preventDefault(); onMove(-1); }
        else if (e.key === 'ArrowDown' && index < total - 1) { e.preventDefault(); onMove(1); }
      }}
      style={{
        display: 'flex', gap: 8, background: 'var(--win-bg, #0d1117)',
        border: isDragOver
          ? '1px dashed var(--win-accent, #58a6ff)'
          : isDragging
            ? `1px solid ${KIND_COLOR[block.kind]}`
            : '1px solid var(--win-border, #30363d)',
        borderLeft: `3px solid ${KIND_COLOR[block.kind]}`, borderRadius: 6, padding: 8,
        cursor: disabled ? 'default' : 'grab',
        outline: isSelected ? '2px solid var(--win-accent, #58a6ff)' : 'none',
        outlineOffset: 2,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flex: '0 0 auto' }}>
        <span
          title="블록 아무 곳이나 드래그해서 순서 변경. 클릭해서 선택 후 Ctrl+↑/↓ 로도 이동 가능"
          style={{ fontSize: 12, color: 'var(--win-text-dim, #9aa7b3)', lineHeight: 1, padding: '2px 0', userSelect: 'none' }}
        >⠿</span>
        <button onClick={() => onMove(-1)} disabled={disabled || index === 0} style={{ ...btn(!disabled && index > 0), padding: '2px 6px', fontSize: 10 }}>▲</button>
        <span style={{ fontSize: 10, color: 'var(--win-text-dim, #9aa7b3)' }}>{index + 1}</span>
        <button onClick={() => onMove(1)} disabled={disabled || index === total - 1} style={{ ...btn(!disabled && index < total - 1), padding: '2px 6px', fontSize: 10 }}>▼</button>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: KIND_COLOR[block.kind], color: '#fff' }}>{KIND_LABEL[block.kind]}</span>
          {send && (
            <select
              value={send.method}
              disabled={disabled}
              onChange={e => onChange({ method: e.target.value as SendMethod } as Partial<SendBlock>)}
              style={{ ...miniInp, width: 'auto', fontWeight: 700 }}
            >
              {SEND_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              <option value="CUSTOM">커스텀</option>
            </select>
          )}
          <button onClick={onRemove} disabled={disabled} style={{ marginLeft: 'auto', ...btn(!disabled, 'danger'), padding: '2px 8px', fontSize: 10 }}>✕</button>
        </div>

        {send && send.method !== 'CUSTOM' && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <label style={miniLabel}>From (발신 번호)</label>
                <input style={miniInp} value={send.fromUser} disabled={disabled} onChange={e => onChange({ fromUser: e.target.value } as Partial<SendBlock>)} placeholder="sipp" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={miniLabel}>To (수신 번호)</label>
                <input style={miniInp} value={send.toUser} disabled={disabled} onChange={e => onChange({ toUser: e.target.value } as Partial<SendBlock>)} placeholder="service" />
              </div>
            </div>
            <label style={miniLabel}>추가 헤더 (선택, 한 줄에 하나)</label>
            <textarea style={{ ...miniInp, minHeight: 44, fontFamily: 'monospace', resize: 'vertical', marginBottom: 6 }} value={send.extraHeaders} disabled={disabled} onChange={e => onChange({ extraHeaders: e.target.value } as Partial<SendBlock>)} placeholder="X-Custom-Header: value" />
            <label style={{ ...miniLabel, display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer' }}>
              <input type="checkbox" checked={send.includeBody} disabled={disabled} onChange={e => onChange({ includeBody: e.target.checked } as Partial<SendBlock>)} />
              바디 포함 {send.method === 'INVITE' ? '(SDP)' : ''}
            </label>
            {send.includeBody && (
              <textarea style={{ ...miniInp, minHeight: 60, fontFamily: 'monospace', resize: 'vertical', marginTop: 4 }} value={send.body} disabled={disabled} onChange={e => onChange({ body: e.target.value } as Partial<SendBlock>)} placeholder={send.method === 'INVITE' ? DEFAULT_SDP : '메시지 바디 (예: MESSAGE 본문, PUBLISH 이벤트 상태 등)'} />
            )}
          </>
        )}

        {send && send.method === 'CUSTOM' && (
          <>
            <label style={miniLabel}>원시 SIP 메시지 (첫 줄부터 헤더까지 직접 작성)</label>
            <textarea style={{ ...miniInp, minHeight: 80, fontFamily: 'monospace', resize: 'vertical' }} value={send.customRaw} disabled={disabled} onChange={e => onChange({ customRaw: e.target.value } as Partial<SendBlock>)} placeholder={'MESSAGE sip:[service]@[remote_ip]:[remote_port] SIP/2.0\nVia: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]\n...'} />
          </>
        )}

        {block.kind === 'recv' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={miniLabel}>응답 코드</label>
              <input style={{ ...miniInp, width: 80 }} value={block.code} disabled={disabled} onChange={e => onChange({ code: e.target.value } as Partial<RecvBlock>)} placeholder="200" />
            </div>
            <label style={{ ...miniLabel, display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer', marginBottom: 5 }}>
              <input type="checkbox" checked={block.optional} disabled={disabled} onChange={e => onChange({ optional: e.target.checked } as Partial<RecvBlock>)} />
              선택(없어도 진행)
            </label>
            <label style={{ ...miniLabel, display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer', marginBottom: 5 }} title="이 응답을 Response Time 통계 측정 지점으로 표시 (rtd)">
              <input type="checkbox" checked={block.rtd} disabled={disabled} onChange={e => onChange({ rtd: e.target.checked } as Partial<RecvBlock>)} />
              rtd (응답시간 측정)
            </label>
            <label style={{ ...miniLabel, display: 'flex', alignItems: 'center', gap: 4, cursor: disabled ? 'default' : 'pointer', marginBottom: 5 }} title="통계 화면 표에 구분용 빈 줄 삽입 (동작에는 영향 없음)">
              <input type="checkbox" checked={block.crlf} disabled={disabled} onChange={e => onChange({ crlf: e.target.checked } as Partial<RecvBlock>)} />
              crlf (표에 빈 줄)
            </label>
          </div>
        )}

        {block.kind === 'pause' && (
          <div>
            <label style={miniLabel}>대기 시간 (ms)</label>
            <input style={{ ...miniInp, width: 100 }} type="number" min={0} value={block.ms} disabled={disabled} onChange={e => onChange({ ms: Number(e.target.value) } as Partial<PauseBlock>)} />
          </div>
        )}
      </div>
    </div>
  );
};
