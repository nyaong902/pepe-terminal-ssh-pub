// electron/chatArchiveStore.ts
// 사내 메신저(NAVER WORKS) 대화 아카이브 — 로컬 전용, 청크 단위 암호화 저장 + 임베딩 기반 검색.
// 서버/클라우드 없음: safeStorage(Windows DPAPI 등 OS 자격 저장소)로 원문 텍스트만 암호화하고,
// 검색에 필요한 임베딩 벡터는 평문 숫자 배열로 둔다 — 벡터만으로는 원문을 복원할 수 없고,
// 이렇게 해야 "필요한 결과 몇 개만 복호화"가 실제로 성립한다(방 전체를 통째로 복호화하지 않음).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { app, safeStorage, utilityProcess } from 'electron';
import { ensureBundleExtracted } from './ensureBundleExtracted';

export type ChatChunk = { ts: number; sender: string; text: string };
export type ContextMessage = { ts: number; sender: string; text: string; isHit: boolean };
// matchCount — 질문(원문) 키워드 중 이 메시지 텍스트에 그대로 포함된 개수(search() 의 1차 정렬
// 기준). semantic 검색으로만 걸려 키워드 매칭이 없었던 항목은 0.
export type SearchResult = { roomId: string; ts: number; sender: string; text: string; score: number; matchCount: number; context: ContextMessage[] };
export type RoomStat = { roomId: string; count: number; lastTs: number };

type StoredChunkLine = { roomId: string; ts: number; sender: string; embedding: number[]; encText: string };
// text 는 복호화된 평문 — 앱이 켜져있는 동안 메모리에만 유지(키워드 검색이 전체를 훑어야 해서
// 매번 top-k 만 복호화하는 방식으론 안 됨). 디스크(JSONL)에는 여전히 encText(암호문)만 저장되고,
// 이 평문은 프로세스가 꺼지면 사라짐 — "디스크에 평문이 안 남는다"는 보장은 그대로 유지된다.
type IndexEntry = { roomId: string; ts: number; sender: string; embedding: Float32Array; encText: Buffer; text: string; dedupKey: string };

function archiveDir(): string {
  try { return path.join(app.getPath('userData'), 'chat-archive'); }
  catch { return path.join(process.cwd(), 'chat-archive'); }
}

// roomId 를 그대로 파일명으로 쓰면 특수문자/길이 문제가 생길 수 있어 폴더명은 안전화 처리하고,
// 원본 roomId 는 각 줄(JSONL 레코드)에 그대로 저장해 조회 시 그걸 신뢰한다(폴더명 역변환 불필요).
function roomDirName(roomId: string): string {
  const safe = roomId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = crypto.createHash('sha1').update(roomId).digest('hex').slice(0, 8);
  return `${safe}_${hash}`;
}

function shardPath(roomId: string, year: number): string {
  return path.join(archiveDir(), roomDirName(roomId), `${year}.jsonl`);
}

function dedupKey(roomId: string, ts: number, sender: string): string {
  return crypto.createHash('sha1').update(`${roomId}|${ts}|${sender}`).digest('hex');
}

// ---- 임베딩 파이프라인 — 순수 JS/WASM(@xenova/transformers), 네이티브 컴파일 불필요.
// ESM 전용 패키지라 CJS(electron/main.ts 빌드 결과)에서는 동적 import 로 불러온다.
//
// AI 런타임(@xenova/transformers 50MB + onnxruntime-node 92MB + web/common)은 설치본에서
// 가장 큰 선택 항목이라 선택 설치 번들(chat-archive-ai.zip)로 분리했다 — package.json 의
// build.files 에서 asar 대상에서 빼두었으므로, 패키지된 앱에서는 bare specifier 로 못 찾는다.
// 번들이 풀리는 위치가 resources/app.asar.unpacked/node_modules 인 이유:
// transformers 는 sharp / onnxruntime-node / onnxruntime-web 를 모두 **정적** ESM import 하고,
// 그 중 sharp 와 @img(합쳐 20MB)는 앱 본체가 이미 써서 항상 그 폴더에 있다. 같은 node_modules
// 안에 풀어두면 Node 의 상위 탐색으로 그대로 찾으므로 번들에 중복으로 넣지 않아도 된다.
// 임베딩은 별도 프로세스(utilityProcess)에서 돌린다 — electron/chatArchiveEmbedWorker.cjs.
//
// 예전에는 메인 프로세스에서 직접 모델을 로드했다. 그러면 검색 한 번에 메인이 144MB -> 667MB 로
// 뛰고 392MB 까지만 내려왔다: 모델 가중치(113MB + 토크나이저 16MB)가 상주하고, onnxruntime 의
// 아레나 할당자는 한 번 늘어난 메모리를 OS 에 반납하지 않는다. 메인은 앱 수명 내내 살아 있으니
// 여기 얹힌 것은 구조적으로 회수가 불가능했다.
// 별도 프로세스로 옮기고 유휴 시 종료하면 통째로 회수된다. 대가는 유휴 종료 후 첫 검색의 모델
// 로드 지연이라, 타임아웃을 넉넉히 두어 연속 검색에는 영향이 없게 한다.
const EMBED_IDLE_MS = 10 * 60 * 1000;
let embedProc: Electron.UtilityProcess | null = null;
let embedReady: Promise<void> | null = null;
let embedIdleTimer: NodeJS.Timeout | null = null;
let embedSeq = 0;
const embedPending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

function rejectAllPending(message: string) {
  for (const [id, waiter] of embedPending) {
    embedPending.delete(id);
    waiter.reject(new Error(message));
  }
}

function killEmbedProc(reason: string) {
  if (embedIdleTimer) { clearTimeout(embedIdleTimer); embedIdleTimer = null; }
  const proc = embedProc;
  embedProc = null;
  embedReady = null;
  rejectAllPending('임베딩 프로세스가 종료되었습니다.');
  if (!proc) return;
  try { proc.kill(); } catch {}
  console.log(`[chat-archive] 임베딩 프로세스 종료 (${reason})`);
}

// 요청이 올 때마다 유휴 타이머를 미룬다 — 마지막 요청 이후 EMBED_IDLE_MS 동안 조용하면 내린다.
function touchEmbedIdle() {
  if (embedIdleTimer) clearTimeout(embedIdleTimer);
  embedIdleTimer = setTimeout(() => killEmbedProc('유휴'), EMBED_IDLE_MS);
}

// 개발 모드에선 프로젝트 node_modules 를 그대로 쓰고(bare specifier), 패키지된 앱에서는
// 풀린 번들의 엔트리 파일을 file:// URL 로 직접 가리킨다. 워커에는 electron 의 app 모듈이 없어서
// 이 판단은 여기(메인)서 하고 결과만 넘긴다.
function resolveTransformersSpecifier(): string {
  if (!app.isPackaged) return '@xenova/transformers';
  // 포터블 빌드는 NSIS customInstall 을 거치지 않아 zip 이 그대로 남아 있다 — 첫 사용 시 여기서 푼다.
  ensureBundleExtracted(
    'chat-archive-ai',
    path.join('app.asar.unpacked', 'node_modules'),
    path.join('@xenova', 'transformers', 'package.json'),
    (m) => console.log(m),
  );
  const entry = path.join(
    process.resourcesPath, 'app.asar.unpacked', 'node_modules',
    '@xenova', 'transformers', 'src', 'transformers.js',
  );
  if (!fs.existsSync(entry)) {
    throw new Error('대화 아카이브 검색의 AI 런타임이 설치되지 않았습니다 — 설치 프로그램에서 "대화 아카이브 검색"을 선택해 다시 설치하세요.');
  }
  return pathToFileURL(entry).href;
}

function ensureEmbedProc(): Promise<void> {
  if (embedReady) return embedReady;
  embedReady = new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } };
    try {
      // 번들이 없으면 여기서 던진다 — 워커를 띄우기 전에 알 수 있다.
      const specifier = resolveTransformersSpecifier();
      let cacheDir = '';
      try { cacheDir = path.join(app.getPath('userData'), 'models'); } catch {}
      // serviceName 은 app.getAppMetrics() 에 그대로 보여서, 메모리 진단 로그에서 이 프로세스를
      // 바로 알아볼 수 있다(Utility(PePe Embedder)).
      const proc = utilityProcess.fork(path.join(__dirname, 'chatArchiveEmbedWorker.cjs'), [], {
        serviceName: 'PePe Embedder',
        stdio: 'inherit',
      });
      embedProc = proc;
      proc.on('message', (msg: any) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'ready') { if (!settled) { settled = true; resolve(); } return; }
        if (msg.type === 'result') {
          const waiter = embedPending.get(msg.id);
          if (!waiter) return;
          embedPending.delete(msg.id);
          waiter.resolve(Array.isArray(msg.embeddings) ? msg.embeddings : []);
          return;
        }
        if (msg.type === 'error') {
          const waiter = typeof msg.id === 'number' ? embedPending.get(msg.id) : undefined;
          if (waiter) {
            embedPending.delete(msg.id);
            waiter.reject(new Error(String(msg.message || '임베딩 실패')));
          } else {
            console.warn('[chat-archive] 임베딩 오류:', msg.message);
          }
        }
      });
      proc.on('exit', (code) => {
        if (embedProc === proc) { embedProc = null; embedReady = null; }
        rejectAllPending(`임베딩 프로세스가 종료되었습니다 (code ${code}).`);
        fail(new Error(`임베딩 프로세스를 시작하지 못했습니다 (code ${code}).`));
      });
      proc.postMessage({ type: 'init', specifier, cacheDir });
    } catch (e: any) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
  // 실패한 promise 를 캐시해두면 이후 모든 호출이 같은 에러로 죽는다 — 다음 시도에 재평가되도록.
  embedReady.catch(() => { embedReady = null; });
  return embedReady;
}

// 대화 아카이브 검색 워크스페이스를 닫을 때 호출된다 — 유휴 타임아웃을 기다리지 않고 바로 내린다.
// 처리 중인 요청이 있으면(메신저 스크래퍼의 백필이 백그라운드로 임베딩할 수 있다) 죽이지 않고
// 짧은 간격으로 다시 확인한다 — 여기서 죽이면 그 작업이 오류로 끝난다.
export function releaseEmbedder(reason: string) {
  if (!embedProc) return;
  if (embedPending.size > 0) {
    if (embedIdleTimer) clearTimeout(embedIdleTimer);
    embedIdleTimer = setTimeout(() => releaseEmbedder(reason), 5000);
    return;
  }
  killEmbedProc(reason);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  await ensureEmbedProc();
  const proc = embedProc;
  if (!proc) throw new Error('임베딩 프로세스를 사용할 수 없습니다.');
  touchEmbedIdle();
  const id = ++embedSeq;
  const done = new Promise<number[][]>((resolve, reject) => embedPending.set(id, { resolve, reject }));
  proc.postMessage({ type: 'embed', id, texts });
  const out = await done;
  // 응답을 받은 시점부터 다시 센다 — 모델 로드가 오래 걸려도 그 시간이 유휴로 잡히지 않게.
  touchEmbedIdle();
  return out;
}

// ---- 인메모리 인덱스 — 앱 실행 중 1회 디스크에서 적재, 이후 appendChunks 가 갱신.
// encText 는 여기서 Buffer(암호문) 그대로 보관 — search() 가 top-k 로 추린 것만 복호화한다.
let indexCache: IndexEntry[] | null = null;
let knownKeys: Set<string> | null = null;

function ensureIndexLoaded() {
  if (indexCache) return;
  indexCache = [];
  knownKeys = new Set();
  // key -> indexCache 상의 인덱스. 같은 dedupKey 레코드가 파일에 여러 줄 있으면(재백필로 텍스트가
  // 갱신된 경우, appendChunks 참고) 파일 안에서 나중에 나오는 줄이 최신이므로 그걸로 덮어쓴다 —
  // JSONL 은 append-only 라 기존 줄을 고쳐 쓰지 않고, 대신 갱신본을 뒤에 또 추가하는 방식을 쓴다.
  const posByKey = new Map<string, number>();
  const base = archiveDir();
  if (!fs.existsSync(base)) return;
  for (const roomFolder of fs.readdirSync(base)) {
    const roomPath = path.join(base, roomFolder);
    if (!fs.statSync(roomPath).isDirectory()) continue;
    for (const file of fs.readdirSync(roomPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const raw = fs.readFileSync(path.join(roomPath, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec: StoredChunkLine = JSON.parse(line);
          const key = dedupKey(rec.roomId, rec.ts, rec.sender);
          const encText = Buffer.from(rec.encText, 'base64');
          const entry: IndexEntry = {
            roomId: rec.roomId, ts: rec.ts, sender: rec.sender,
            embedding: Float32Array.from(rec.embedding),
            encText, text: safeStorage.decryptString(encText),
            dedupKey: key,
          };
          const existingPos = posByKey.get(key);
          if (existingPos !== undefined) {
            indexCache![existingPos] = entry; // 갱신본으로 교체
          } else {
            posByKey.set(key, indexCache!.length);
            knownKeys!.add(key);
            indexCache!.push(entry);
          }
        } catch { /* 손상된 라인 skip */ }
      }
    }
  }
}

// 재백필 시 이미 저장된 지점까지 스크롤했는지 판단하기 위한 조회 — 임베딩/암호화 없이 dedup
// 키만 확인(가벼움). 스크래퍼가 "이 라운드는 전부 이미 저장된 것"이면 조기 종료할 수 있게 함.
export function filterUnknown(roomId: string, items: Array<{ ts: number; sender: string }>): Array<{ ts: number; sender: string }> {
  ensureIndexLoaded();
  return items.filter(it => !knownKeys!.has(dedupKey(roomId, it.ts, it.sender)));
}

// 스크래핑한 청크들을 임베딩 + 암호화해서 저장. 완전히 새로운 것(roomId+ts+sender 도 처음 봄)은
// 그대로 추가하고, 이미 저장된 것이라도 텍스트 내용이 달라졌으면(실측 사례: 스크래퍼 로직 개선
// 전에 저장돼 <br> 개행이 유실된 메시지가, 개선된 로직으로 재백필하면 개행이 살아난 텍스트로
// 나옴) 갱신본으로 다시 저장한다 — 그래야 스크래퍼 버그를 고친 뒤 재백필만으로 과거 오염된
// 데이터도 자동으로 복구된다. 텍스트까지 완전히 같으면(진짜 중복) 조용히 스킵.
export async function appendChunks(roomId: string, chunks: ChatChunk[]): Promise<{ added: number; skipped: number }> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS 안전 저장소(safeStorage) 사용 불가 — 암호화 저장이 불가능해 중단합니다');
  }
  ensureIndexLoaded();
  const byKey = new Map<string, IndexEntry>();
  for (const e of indexCache!) byKey.set(e.dedupKey, e);
  const fresh = chunks.filter(c => {
    if (!c.text || !c.text.trim()) return false;
    const existing = byKey.get(dedupKey(roomId, c.ts, c.sender));
    return !existing || existing.text !== c.text;
  });
  if (fresh.length === 0) return { added: 0, skipped: chunks.length };

  const embeddings = await embedTexts(fresh.map(c => c.text));
  const dir = path.join(archiveDir(), roomDirName(roomId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const byYear = new Map<number, StoredChunkLine[]>();
  fresh.forEach((c, i) => {
    const encBuf = safeStorage.encryptString(c.text);
    const year = new Date(c.ts).getFullYear();
    const line: StoredChunkLine = { roomId, ts: c.ts, sender: c.sender, embedding: embeddings[i], encText: encBuf.toString('base64') };
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(line);
    const key = dedupKey(roomId, c.ts, c.sender);
    const newEntry: IndexEntry = { roomId, ts: c.ts, sender: c.sender, embedding: Float32Array.from(embeddings[i]), encText: encBuf, text: c.text, dedupKey: key };
    const existing = byKey.get(key);
    if (existing) {
      const idx = indexCache!.indexOf(existing);
      if (idx !== -1) indexCache![idx] = newEntry;
    } else {
      knownKeys!.add(key);
      indexCache!.push(newEntry);
    }
    byKey.set(key, newEntry);
  });

  for (const [year, lines] of byYear) {
    const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    fs.appendFileSync(shardPath(roomId, year), text, 'utf8');
  }
  return { added: fresh.length, skipped: chunks.length - fresh.length };
}

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// 질문 문장을 통째로 토큰화하기 어려운(한국어는 띄어쓰기로 형태소가 안 나뉨) 상황이라, 공백/기본
// 구두점 기준으로 "의미 있을 법한" 조각만 대충 뽑는다 — 완벽한 형태소 분석이 아니라, "PLD", "vob"
// 처럼 임베딩으론 놓치기 쉬운 특정 용어/코드를 문자 그대로 찾기 위한 보조 수단이라 이 정도면 충분.
function extractKeywords(query: string): string[] {
  const tokens = query.split(/[\s,./?!"'()[\]{}:;]+/).map(t => t.trim()).filter(t => t.length >= 2);
  return Array.from(new Set([query.trim(), ...tokens])).filter(Boolean);
}

// 임베딩(의미 유사도) 검색과 키워드(문자 그대로 포함, 대소문자 무관) 검색을 합쳐서 후보를 넓게
// 모은다. 임베딩만으로는 특정 용어/코드가 질문과 의미적으로 안 가깝다고 판단돼 놓치는 경우가
// 있어서 — 후보를 넓게 모으고 AI 에게 실제 관련성 판단을 맡기는 쪽이 더 낫다고 판단.
// 매칭된 메시지 하나만 주면 "원인 파악 중"류 발언만 걸리고 몇 마디 뒤에 나온 실제 결론(다른
// 문장이라 임베딩 유사도가 낮음)은 놓치는 문제가 있어, 같은 방에서 시간순으로 전후 contextWindow
// 개씩 묶어서 함께 반환한다 — AI 가 대화 흐름 전체를 보고 답할 수 있게.
// 예전엔 키워드 매칭 건수에 상한(KEYWORD_MAX_MATCHES=40 넘으면 그 키워드 자체를 "구별력 없음"
// 으로 보고 완전 제외 + 살아남아도 최종 후보는 KEYWORD_LIMIT=topK/2 개까지만)을 뒀는데, 이게
// "AMEN"처럼 사내에서 실제로 자주 쓰이는 핵심 용어까지 걸러버려 그 용어가 핵심인 질문에서도
// 못 찾는 문제를 냈다(실측 사례: AMEN 관련 VNF 패키지 지시문 검색 실패). 흔함=구별력 없음이
// 아니었던 것 — 완전히 제거했다. 그 다음엔 최종 반환 개수에 안전 상한(SEARCH_RESULT_HARD_CAP)을
// 두었었는데, 이번엔 키워드/semantic 을 합친 뒤 스코어로 전체 정렬해서 자르는 방식이라 "키워드는
// 정확히 일치하지만 semantic 점수가 낮은" 항목이 하드캡 밖으로 밀려나는 문제를 냈다(같은 실측
// 사례로 재발 확인). 그래서 하드캡 자체를 없애고, semanticTop(topK 로 이미 제한됨)과 keywordHits
// (제한 없음) 를 그대로 유지한 채 합친다 — 아래 참고.
//
// 키워드 매칭에 더 이상 건수 상한이 없어(위 주석 참고) 인덱스가 아주 커지면(수십만 건) 이론상
// search() 한 번이 오래 걸릴 수 있다. 실제로 멈춰야 할 만큼 느려지는지 확인할 수 있도록 소요
// 시간을 재서, 비정상적으로 느리면(사용자 체감상 버벅임 수준) 경고 로그만 남긴다 — 동기 함수라
// 계산을 중간에 끊는 진짜 타임아웃은 불가능하지만, 느려진 게 확인되면 다음 최적화(예: 키워드
// 검색 자체를 워커로 분리)의 근거 데이터가 된다.
const SEARCH_SLOW_WARN_MS = 2000;

export function search(queryText: string, queryEmbedding: number[], topK = 8, contextWindow = 8): SearchResult[] {
  const searchStart = Date.now();
  ensureIndexLoaded();
  const q = Float32Array.from(queryEmbedding);
  // 대소문자 구분 없이 매칭 — 키워드/본문 모두 소문자로 비교(entry.text 자체를 바꾸지 않고 비교
  // 시점에만 소문자화해 원문은 그대로 유지).
  const keywords = extractKeywords(queryText).map(k => k.toLowerCase()).filter(k => k.length >= 2);

  // 전체에 대해 코사인 유사도를 한 번만 계산해 semantic/keyword 양쪽에서 재사용.
  const withScore = indexCache!.map(entry => ({ entry, score: cosineSim(q, entry.embedding) }));

  const semanticTop = [...withScore].sort((a, b) => b.score - a.score).slice(0, Math.max(0, topK));

  // 매칭된 키워드 "개수"를 점수보다 먼저 보는 1차 정렬 기준으로 쓴다. 이전엔 매칭 개수를 semantic
  // 점수에 소폭 가산(+0.05 씩)하는 방식을 썼는데, 이 방에 "amen"만 겹치는 로그성 메시지가 워낙
  // 많아서(실측: 1000건 이상) 다들 비슷한 가산치를 받다 보니 순위가 거의 안 바뀌었다(실측 사례:
  // 1223위 -> 1032위, 여전히 컷 밖). "vnf"+"amen"+"패키지"처럼 질문의 키워드 여러 개가 동시에
  // 겹치는 메시지는, "amen" 단어 하나만 우연히 들어간 메시지보다 "이 질문이 말하는 그 대화 영역"
  // 일 가능성이 훨씬 높다는 게 핵심 신호이므로, 점수에 얹어 섞는 대신 매칭 개수 자체로 먼저
  // 정렬하고(개수가 같을 때만 semantic 점수로 동점자 처리) 확실하게 우선순위를 준다.
  const keywordHits = keywords.length === 0 ? [] : withScore
    .map(({ entry, score }) => {
      const lower = entry.text.toLowerCase();
      const matchCount = keywords.reduce((n, k) => n + (lower.includes(k) ? 1 : 0), 0);
      return { entry, score, matchCount };
    })
    .filter(({ matchCount }) => matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount || b.score - a.score);

  // entry 참조 동일성 기준으로 합치기 — semantic 상위(topK 로 이미 제한됨)는 항상 포함되고,
  // 키워드로 걸린 추가 후보가 그 위에 더 얹어진다(총 개수가 topK 보다 훨씬 늘어날 수 있음, 의도된
  // 동작 — 키워드 후보는 자르지 않는다). rankKey 는 (matchCount, score) 튜플로 최종 정렬에 쓰고,
  // 화면/AI 프롬프트에 표시할 score 는 원래 semantic 유사도를 그대로 유지한다(사용자가 보는
  // "유사도" 값이 키워드 가산으로 왜곡되지 않게). 화면에는 전부 다 보여주고, AI 프롬프트에 넣을
  // 개수만 렌더러(ChatArchiveSearch.tsx 의 AI_CONTEXT_LIMIT) 쪽에서 상위 순위로 제한한다.
  const merged = new Map<IndexEntry, { score: number; matchCount: number }>();
  for (const { entry, score } of semanticTop) merged.set(entry, { score, matchCount: 0 });
  for (const { entry, score, matchCount } of keywordHits) {
    const existing = merged.get(entry);
    merged.set(entry, { score: existing?.score ?? score, matchCount });
  }
  const top = Array.from(merged.entries())
    .map(([entry, { score, matchCount }]) => ({ entry, score, matchCount }))
    .sort((a, b) => b.matchCount - a.matchCount || b.score - a.score);

  const byRoom = new Map<string, IndexEntry[]>();
  for (const e of indexCache!) {
    if (!byRoom.has(e.roomId)) byRoom.set(e.roomId, []);
    byRoom.get(e.roomId)!.push(e);
  }
  for (const list of byRoom.values()) list.sort((a, b) => a.ts - b.ts);

  const results = top.map(({ entry, score, matchCount }) => {
    const roomList = byRoom.get(entry.roomId) || [entry];
    const idx = roomList.indexOf(entry);
    const from = Math.max(0, idx - contextWindow);
    const to = Math.min(roomList.length, idx + contextWindow + 1);
    const context: ContextMessage[] = roomList.slice(from, to).map(e => ({
      ts: e.ts, sender: e.sender, text: e.text, isHit: e === entry,
    }));
    return { roomId: entry.roomId, ts: entry.ts, sender: entry.sender, text: entry.text, score, matchCount, context };
  });

  const elapsedMs = Date.now() - searchStart;
  if (elapsedMs > SEARCH_SLOW_WARN_MS) {
    console.warn(`[chatArchiveStore] search() 가 ${elapsedMs}ms 걸림 (인덱스 ${indexCache!.length}건, 키워드 매칭 ${keywordHits.length}건) — 인덱스가 커지면 최적화 필요할 수 있음`);
  }
  return results;
}

// 진단용 — 임베딩/스코어링 전혀 없이, 특정 방(선택)에서 substring 이 실제로 아카이브에
// 존재하는지만 순수 문자열 포함 여부로 확인한다. search() 가 그 메시지를 후보로 못 뽑는 건지,
// 애초에 아카이브에 없는(백필 안 됐거나 스크래핑을 놓친) 건지를 구분할 때 쓴다.
export function rawContains(substring: string, roomId?: string): { roomId: string; ts: number; sender: string; text: string }[] {
  ensureIndexLoaded();
  const needle = substring.toLowerCase();
  return indexCache!
    .filter(e => (!roomId || e.roomId === roomId) && e.text.toLowerCase().includes(needle))
    .map(e => ({ roomId: e.roomId, ts: e.ts, sender: e.sender, text: e.text }));
}

// 방별 건수/최근시각만 필요한 화면(대화 아카이브 검색의 "현황" 버튼)을 위해, ensureIndexLoaded()
// 의 전체 복호화(safeStorage.decryptString, 동기 함수)를 거치지 않고 JSONL 라인에서 roomId/ts만
// 파싱해 집계한다. 실측: 10만 건 넘는 인덱스에서 ensureIndexLoaded() 최초 호출이 메인 프로세스를
// 통째로 블로킹해 앱이 멎은 것처럼 보이는 문제가 있었음(현황 버튼 클릭 시 재현) — 이 함수는 그
// 무거운 경로를 아예 타지 않는다. 단, 이미 다른 기능(검색 등)으로 인덱스가 메모리에 로드돼
// 있다면 그걸 재사용하는 편이 디스크를 또 훑는 것보다 빠르므로 그 경우엔 그대로 쓴다.
export function getStats(): RoomStat[] {
  const map = new Map<string, RoomStat>();
  if (indexCache) {
    for (const e of indexCache) {
      const cur = map.get(e.roomId) || { roomId: e.roomId, count: 0, lastTs: 0 };
      cur.count++;
      if (e.ts > cur.lastTs) cur.lastTs = e.ts;
      map.set(e.roomId, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.lastTs - a.lastTs);
  }

  const base = archiveDir();
  if (!fs.existsSync(base)) return [];
  // 재백필로 텍스트가 갱신된 메시지는 같은 (roomId,ts,sender) 조합이 파일에 여러 줄로 남아있을
  // 수 있다(appendChunks 참고) — 복호화 없이도 dedupKey(해시)만으로 중복 카운트를 막는다. 이 함수가
  // 집계하는 count/lastTs 는 roomId+ts 로만 결정되고 텍스트 내용과 무관해(갱신 전후로 두 줄의 값이
  // 같음), 어느 줄을 "대표"로 채택하든(먼저/나중) 결과가 달라지지 않는다 — ensureIndexLoaded() 는
  // text 필드를 다루므로 나중 레코드(최신 갱신본)를 우선하지만, 여기선 그럴 필요가 없다.
  const seenKeys = new Set<string>();
  for (const roomFolder of fs.readdirSync(base)) {
    const roomPath = path.join(base, roomFolder);
    if (!fs.statSync(roomPath).isDirectory()) continue;
    for (const file of fs.readdirSync(roomPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const raw = fs.readFileSync(path.join(roomPath, file), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          // encText/embedding 은 파싱만 하고 복호화/Float32Array 변환은 하지 않는다 — 여기서
          // 필요한 건 roomId/ts/sender 뿐이라, JSON.parse 한 줄 외의 무거운 작업을 전부 생략한다.
          const rec: { roomId: string; ts: number; sender: string } = JSON.parse(line);
          const key = dedupKey(rec.roomId, rec.ts, rec.sender);
          if (seenKeys.has(key)) continue; // 같은 메시지의 갱신본이라도 count/lastTs 기여는 1회만
          seenKeys.add(key);
          const cur = map.get(rec.roomId) || { roomId: rec.roomId, count: 0, lastTs: 0 };
          cur.count++;
          if (rec.ts > cur.lastTs) cur.lastTs = rec.ts;
          map.set(rec.roomId, cur);
        } catch { /* 손상된 라인 skip */ }
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.lastTs - a.lastTs);
}

// 테스트/진단용 — 인메모리 인덱스를 버리고 디스크에서 다시 적재하게 강제.
export function invalidateIndexCache() {
  indexCache = null;
  knownKeys = null;
}
