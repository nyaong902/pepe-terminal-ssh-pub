// electron/chatArchiveEmbedWorker.cjs
// 대화 아카이브 검색용 임베딩 워커 — utilityProcess(별도 프로세스)로 실행된다.
//
// 왜 별도 프로세스인가: 임베딩 모델(model_quantized.onnx 113MB + tokenizer 16MB)과 onnxruntime 의
// 아레나 할당자를 메인 프로세스에서 쓰면 메모리가 돌아오지 않는다. 실제로 검색 한 번에 메인 프로세스가
// 144MB -> 667MB 로 뛰고 392MB 까지만 내려왔다(ORT 아레나는 한 번 늘어난 메모리를 OS 에 반납하지
// 않는다 — WASM Memory 가 줄지 않는 것과 같은 성질이다). 메인은 앱 수명 내내 살아 있으니 여기 얹힌
// 것은 구조적으로 회수가 불가능하다. 별도 프로세스로 두면 유휴 시 종료해서 통째로 회수한다.
//
// 프로토콜(부모 <-> 자식):
//   부모 -> { type:'init', specifier, cacheDir }
//   부모 -> { type:'embed', id, texts }
//   자식 -> { type:'ready' } | { type:'result', id, embeddings } | { type:'error', id?, message }
//
// specifier(=@xenova/transformers 를 어떻게 찾을지)와 cacheDir 는 부모가 정해서 넘긴다.
// app.isPackaged 판단, resourcesPath, 선택 설치 번들(chat-archive-ai.zip) 압축 해제는 메인
// 프로세스에서만 할 수 있다 — utilityProcess 에는 electron 의 app 모듈이 없다.

let embedderPromise = null;
let cfg = { specifier: '', cacheDir: '' };

function send(msg) {
  try { process.parentPort.postMessage(msg); } catch { /* 부모가 이미 종료 */ }
}

async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      if (!cfg.specifier) throw new Error('임베딩 워커가 초기화되지 않았습니다.');
      // ESM 전용 패키지 — CJS 에서 동적 import 로 불러온다.
      const mod = await import(cfg.specifier);
      try { if (cfg.cacheDir) mod.env.cacheDir = cfg.cacheDir; } catch {}
      // 다국어(한국어 포함) 모델 — 사내 대화가 한국어 위주다. 메인에서 쓰던 것과 같은 모델이라
      // 이미 내려받은 캐시를 그대로 재사용한다(cacheDir 를 부모가 같은 경로로 넘긴다).
      return mod.pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    })();
    // 실패한 promise 를 캐시해두면 이후 모든 호출이 같은 에러로 죽는다 — 다음 시도에 재평가되도록.
    embedderPromise.catch(() => { embedderPromise = null; });
  }
  return embedderPromise;
}

process.parentPort.on('message', (e) => {
  const msg = e && e.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'init') {
    cfg = { specifier: String(msg.specifier || ''), cacheDir: String(msg.cacheDir || '') };
    send({ type: 'ready' });
    return;
  }

  if (msg.type === 'embed') {
    (async () => {
      const embedder = await getEmbedder();
      const out = [];
      for (const t of msg.texts || []) {
        const r = await embedder(t, { pooling: 'mean', normalize: true });
        out.push(Array.from(r.data));
      }
      send({ type: 'result', id: msg.id, embeddings: out });
    })().catch((err) => {
      send({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    });
  }
});
