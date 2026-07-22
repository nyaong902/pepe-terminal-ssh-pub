import http, { IncomingMessage, ServerResponse } from 'http';
import os from 'os';
import { randomUUID } from 'crypto';

type PlainAppConnectResponse = {
  requestId: string;
  deviceId?: string;
  deviceName?: string;
  httpUrls?: string[];
  httpsUrls?: string[];
  primaryUrl?: string;
  timestamp?: number;
};

type PlainAppConnectState = {
  running: boolean;
  host: string;
  port: number;
  requestId: string;
  callbackUrl: string;
  callbackUrls: string[];
  qrContent: string;
  connected: boolean;
  response?: PlainAppConnectResponse;
  error?: string;
};

type PlainAppConnectEvent =
  | { type: 'state'; state: PlainAppConnectState }
  | { type: 'connected'; state: PlainAppConnectState; response: PlainAppConnectResponse };

const DEFAULT_BIND_HOST = '0.0.0.0';

function isIpv4(value: string): boolean {
  const parts = String(value || '').split('.').map(n => Number(n));
  return parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
}

function isPrivateIpv4(value: string): boolean {
  if (!isIpv4(value)) return false;
  const [a, b] = String(value).split('.').map(n => Number(n));
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function scoreAddress(address: string, ifaceName: string): number {
  const lower = String(ifaceName || '').toLowerCase();
  let score = isPrivateIpv4(address) ? 100 : 10;
  if (lower.includes('wifi') || lower.includes('wi-fi') || lower.includes('wireless')) score += 20;
  if (lower.includes('ethernet') || lower.includes('lan')) score += 15;
  if (lower.includes('tailscale') || lower.includes('vpn') || lower.includes('tunnel')) score -= 30;
  return score;
}

function collectHostAddresses(): string[] {
  const candidates: Array<{ address: string; ifaceName: string }> = [];
  try {
    for (const [ifaceName, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
        const address = String(entry.address || '').trim();
        if (!isIpv4(address)) continue;
        if (address.startsWith('127.')) continue;
        candidates.push({ address, ifaceName });
      }
    }
  } catch {}
  candidates.sort((a, b) => scoreAddress(b.address, b.ifaceName) - scoreAddress(a.address, a.ifaceName) || a.address.localeCompare(b.address, undefined, { numeric: true }));
  return Array.from(new Set(candidates.map(c => c.address)));
}

function pickHostAddress(): string {
  return collectHostAddresses()[0] || '';
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function buildQrContent(requestId: string, callbackUrl: string): string {
  return `plainapp://pepe-connect?r=${encodeURIComponent(requestId)}&u=${encodeURIComponent(callbackUrl)}`;
}

function logConnect(prefix: string, data: unknown): void {
  try {
    console.log(`[plainapp-connect] ${prefix}`, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } catch {
    console.log(`[plainapp-connect] ${prefix}`, data);
  }
}

export class PlainAppConnectServer {
  private server: http.Server | null = null;
  private host = '';
  private port = 0;
  private requestId = '';
  private response: PlainAppConnectResponse | null = null;
  private lastError = '';

  constructor(private readonly notify: (event: PlainAppConnectEvent) => void) {}

  state(): PlainAppConnectState {
    const callbackUrl = this.server && this.host && this.port
      ? `http://${this.host}:${this.port}/plainapp/connect?requestId=${encodeURIComponent(this.requestId)}`
      : '';
    const callbackUrls = this.server && this.port
      ? collectHostAddresses().map(host => `http://${host}:${this.port}/plainapp/connect?requestId=${encodeURIComponent(this.requestId)}`)
      : [];
    return {
      running: !!this.server,
      host: this.host,
      port: this.port,
      requestId: this.requestId,
      callbackUrl,
      callbackUrls,
      qrContent: this.requestId && callbackUrls.length ? buildQrContent(this.requestId, callbackUrl || callbackUrls[0]) : '',
      connected: !!this.response,
      response: this.response || undefined,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async ensureStarted(): Promise<PlainAppConnectState> {
    if (this.server) return this.state();

    this.host = pickHostAddress();
    this.requestId = randomUUID();
    this.response = null;
    this.lastError = '';

    if (!this.host) {
      this.lastError = '사용 가능한 LAN IP 를 찾지 못했어요.';
      const state = this.state();
      this.notify({ type: 'state', state });
      return state;
    }

    const server = http.createServer((req, res) => void this.handleRequest(req, res));
    this.server = server;

    return await new Promise(resolve => {
      server.once('error', err => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.stop();
        resolve(this.state());
      });
      server.listen(0, DEFAULT_BIND_HOST, () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        const state = this.state();
        logConnect('server started', {
          host: this.host,
          port: this.port,
          requestId: this.requestId,
          callbackUrl: state.callbackUrl,
          callbackUrls: state.callbackUrls,
          qrContent: state.qrContent,
        });
        this.notify({ type: 'state', state });
        resolve(state);
      });
    });
  }

  /**
   * 서버(포트/host)는 그대로 둔 채 requestId 만 새로 발급하고 이전 연결의 response 를 지운다.
   * "연결 끊기"/"취소"/"인터페이스 재선택"에서 쓴다 — 이전엔 stop()+ensureStarted() 로 서버
   * 자체를 내렸다 올렸는데, 그러면 네트워크 인터페이스(callbackUrls) 재수집 + 포트 재바인딩까지
   * 다시 일어나서 QR 화면이 잠깐 빈 상태로 깜빡였다(사용자가 원래 기대한 동작은 "IP 목록은 그대로
   * 유지되고 QR 만 바뀌는 것"). requestId 재발급만으로 이전 response 를 무효화하기 충분하다 —
   * 오래된 requestId 로 오는 폰의 재전송은 handleRequest() 의 requestId mismatch(409)로 걸러진다.
   */
  resetRequest(): PlainAppConnectState {
    this.requestId = randomUUID();
    this.response = null;
    this.lastError = '';
    const state = this.state();
    logConnect('request reset', { requestId: this.requestId });
    this.notify({ type: 'state', state });
    return state;
  }

  stop(): PlainAppConnectState {
    try { this.server?.close(); } catch {}
    this.server = null;
    this.port = 0;
    this.requestId = '';
    this.response = null;
    logConnect('server stopped', { host: this.host, port: this.port });
    const state = this.state();
    this.notify({ type: 'state', state });
    return state;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url || '/', `http://${this.host || '127.0.0.1'}`);
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
    res.setHeader('x-content-type-options', 'nosniff');

    if (req.method === 'GET' && requestUrl.pathname === '/plainapp/connect') {
      logConnect('probe received', {
        method: req.method,
        url: req.url,
        requestId: this.requestId,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, requestId: this.requestId }));
      return;
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/plainapp/connect') {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    try {
      const body = await readJson(req) as PlainAppConnectResponse;
      logConnect('POST raw body', body);
      const queryRequestId = String(requestUrl.searchParams.get('requestId') || '').trim();
      const bodyRequestId = String(body?.requestId || '').trim();
      const matchedRequestId = queryRequestId || bodyRequestId;
      if (matchedRequestId && matchedRequestId !== this.requestId) {
        logConnect('request mismatch', {
          expectedRequestId: this.requestId,
          queryRequestId,
          bodyRequestId,
          url: req.url,
        });
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'request mismatch' })); 
        return;
      }
      logConnect('POST parsed payload', {
        requestId: body.requestId,
        deviceId: body.deviceId,
        deviceName: body.deviceName,
        httpUrls: body.httpUrls,
        httpsUrls: body.httpsUrls,
        primaryUrl: body.primaryUrl,
        timestamp: body.timestamp,
        requestUrl: req.url,
      });
      this.response = body;
      const state = this.state();
      this.notify({ type: 'connected', state, response: body });
      logConnect('connected', {
        requestId: body.requestId,
        deviceName: body.deviceName,
        primaryUrl: body.primaryUrl,
        httpUrls: body.httpUrls,
        httpsUrls: body.httpsUrls,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: any) {
      logConnect('POST parse error', {
        url: req.url,
        error: String(err?.message || err || 'invalid json'),
      });
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err || 'invalid json') }));
    }
  }
}
