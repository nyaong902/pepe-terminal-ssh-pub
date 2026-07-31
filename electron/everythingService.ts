// electron/everythingService.ts
// "Pepe-Thing" 워크스페이스 — voidtools Everything 의 로컬 파일 검색 인덱스를 그대로 조회.
//
// Everything 자체를 재구현/재인덱싱하지 않는다: 이미 설치되어 상주 중인 Everything.exe 가
// 파일시스템 인덱스를 들고 있고, Everything64.dll 은 그 프로세스와 통신하는 IPC 클라이언트일
// 뿐이다. koffi(순수 JS FFI, node-gyp 컴파일 불필요)로 이 DLL 을 직접 로드해 exported 함수를
// 호출한다 — Everything.exe 가 실행 중이 아니면 Everything_GetLastError() 가
// EVERYTHING_ERROR_IPC(2) 를 반환하므로, 이 경우 "설치 안내"로 안내한다.
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

const EVERYTHING_ERROR_IPC = 2;

const EVERYTHING_REQUEST_FILE_NAME = 0x00000001;
const EVERYTHING_REQUEST_PATH = 0x00000002;
const EVERYTHING_REQUEST_SIZE = 0x00000010;
const EVERYTHING_REQUEST_DATE_MODIFIED = 0x00000040;

export const EVERYTHING_SORT = {
  NAME_ASCENDING: 1,
  NAME_DESCENDING: 2,
  PATH_ASCENDING: 3,
  PATH_DESCENDING: 4,
  SIZE_ASCENDING: 5,
  SIZE_DESCENDING: 6,
  DATE_MODIFIED_ASCENDING: 13,
  DATE_MODIFIED_DESCENDING: 14,
} as const;

export type EverythingResult = {
  name: string;
  path: string;
  fullPath: string;
  size: number | null;
  dateModified: number | null; // epoch ms
  isFolder: boolean;
};

export type EverythingSearchOptions = {
  matchPath?: boolean;
  matchCase?: boolean;
  matchWholeWord?: boolean;
  regex?: boolean;
  sort?: number;
  offset?: number;
  max?: number;
};

let koffiLib: any = null;
let fns: {
  SetSearchW: any;
  SetMatchPath: any;
  SetMatchCase: any;
  SetMatchWholeWord: any;
  SetRegex: any;
  SetSort: any;
  SetOffset: any;
  SetMax: any;
  SetRequestFlags: any;
  QueryW: any;
  GetLastError: any;
  GetNumResults: any;
  GetTotResults: any;
  GetResultFileNameW: any;
  GetResultPathW: any;
  IsFolderResult: any;
  GetResultSize: any;
  GetResultDateModified: any;
  Reset: any;
} | null = null;
let loadFailedReason: string | null = null;

function platformArch(): 'x64' | 'x86' {
  // Everything(및 이 DLL)은 Windows 전용. Node 프로세스 아키텍처에 맞는 DLL 을 골라야
  // 32/64비트 불일치로 인한 로드 실패를 피할 수 있다.
  return process.arch === 'x64' ? 'x64' : 'x86';
}

function resolveDllPath(): string | null {
  const dllName = platformArch() === 'x64' ? 'Everything64.dll' : 'Everything32.dll';
  const candidates: string[] = [];
  if (process.env.PEPE_EVERYTHING_DLL) candidates.push(process.env.PEPE_EVERYTHING_DLL);
  try {
    if (app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'everything-sdk', dllName));
    } else {
      candidates.push(path.join(process.cwd(), 'resources', 'everything-sdk', dllName));
    }
  } catch {}
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

function ensureLoaded(): boolean {
  if (fns) return true;
  if (loadFailedReason) return false;
  if (process.platform !== 'win32') {
    loadFailedReason = 'unsupported-platform';
    return false;
  }
  const dllPath = resolveDllPath();
  if (!dllPath) {
    loadFailedReason = 'dll-not-found';
    return false;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    koffiLib = koffi.load(dllPath);
    fns = {
      SetSearchW: koffiLib.func('void Everything_SetSearchW(str16 lpString)'),
      SetMatchPath: koffiLib.func('void Everything_SetMatchPath(bool bEnable)'),
      SetMatchCase: koffiLib.func('void Everything_SetMatchCase(bool bEnable)'),
      SetMatchWholeWord: koffiLib.func('void Everything_SetMatchWholeWord(bool bEnable)'),
      SetRegex: koffiLib.func('void Everything_SetRegex(bool bEnable)'),
      SetSort: koffiLib.func('void Everything_SetSort(uint32 dwSort)'),
      SetOffset: koffiLib.func('void Everything_SetOffset(uint32 dwOffset)'),
      SetMax: koffiLib.func('void Everything_SetMax(uint32 dwMax)'),
      SetRequestFlags: koffiLib.func('void Everything_SetRequestFlags(uint32 dwRequestFlags)'),
      QueryW: koffiLib.func('bool Everything_QueryW(bool bWait)'),
      GetLastError: koffiLib.func('uint32 Everything_GetLastError()'),
      GetNumResults: koffiLib.func('uint32 Everything_GetNumResults()'),
      GetTotResults: koffiLib.func('uint32 Everything_GetTotResults()'),
      GetResultFileNameW: koffiLib.func('str16 Everything_GetResultFileNameW(uint32 dwIndex)'),
      GetResultPathW: koffiLib.func('str16 Everything_GetResultPathW(uint32 dwIndex)'),
      IsFolderResult: koffiLib.func('bool Everything_IsFolderResult(uint32 dwIndex)'),
      // LARGE_INTEGER* 출력 파라미터 — int64 하나짜리 구조체로 선언해 포인터로 받는다.
      GetResultSize: koffiLib.func('bool Everything_GetResultSize(uint32 dwIndex, _Out_ int64 *lpSize)'),
      GetResultDateModified: koffiLib.func('bool Everything_GetResultDateModified(uint32 dwIndex, _Out_ int64 *lpDateModified)'),
      Reset: koffiLib.func('void Everything_Reset()'),
    };
    return true;
  } catch (err: any) {
    loadFailedReason = `dll-load-failed: ${err?.message || err}`;
    fns = null;
    return false;
  }
}

// Everything 은 FILETIME(1601-01-01 기준 100ns 단위)을 돌려준다 — JS epoch(1970-01-01, ms)로 변환.
const FILETIME_EPOCH_DIFF_MS = 11644473600000;
function filetimeToEpochMs(ft: bigint | number): number | null {
  const n = typeof ft === 'bigint' ? ft : BigInt(Math.trunc(ft));
  if (n === 0n) return null;
  const ms = Number(n / 10000n) - FILETIME_EPOCH_DIFF_MS;
  return ms;
}

export type EverythingSearchResponse =
  | { ok: true; results: EverythingResult[]; total: number }
  | { ok: false; reason: 'not-running' | 'dll-not-found' | 'unsupported-platform' | string };

export function searchEverything(query: string, opts: EverythingSearchOptions = {}): EverythingSearchResponse {
  if (!ensureLoaded() || !fns) {
    if (loadFailedReason === 'dll-not-found') return { ok: false, reason: 'dll-not-found' };
    if (loadFailedReason === 'unsupported-platform') return { ok: false, reason: 'unsupported-platform' };
    return { ok: false, reason: loadFailedReason || 'unknown' };
  }
  try {
    fns.SetSearchW(query || '');
    fns.SetMatchPath(!!opts.matchPath);
    fns.SetMatchCase(!!opts.matchCase);
    fns.SetMatchWholeWord(!!opts.matchWholeWord);
    fns.SetRegex(!!opts.regex);
    fns.SetSort(opts.sort ?? EVERYTHING_SORT.NAME_ASCENDING);
    fns.SetOffset(opts.offset ?? 0);
    fns.SetMax(opts.max ?? 200);
    fns.SetRequestFlags(
      EVERYTHING_REQUEST_FILE_NAME | EVERYTHING_REQUEST_PATH | EVERYTHING_REQUEST_SIZE | EVERYTHING_REQUEST_DATE_MODIFIED
    );

    const queried = fns.QueryW(true);
    if (!queried) {
      const err = fns.GetLastError();
      if (err === EVERYTHING_ERROR_IPC) return { ok: false, reason: 'not-running' };
      return { ok: false, reason: `query-failed:${err}` };
    }

    const lastErr = fns.GetLastError();
    if (lastErr === EVERYTHING_ERROR_IPC) return { ok: false, reason: 'not-running' };

    const n = fns.GetNumResults();
    const total = fns.GetTotResults();
    const results: EverythingResult[] = [];
    const sizeOut = [0n];
    const dateOut = [0n];
    for (let i = 0; i < n; i++) {
      const name: string = fns.GetResultFileNameW(i) || '';
      const dirPath: string = fns.GetResultPathW(i) || '';
      const isFolder: boolean = !!fns.IsFolderResult(i);
      let size: number | null = null;
      if (fns.GetResultSize(i, sizeOut)) size = Number(sizeOut[0]);
      let dateModified: number | null = null;
      if (fns.GetResultDateModified(i, dateOut)) dateModified = filetimeToEpochMs(dateOut[0]);
      results.push({
        name,
        path: dirPath,
        fullPath: dirPath ? `${dirPath}\\${name}` : name,
        size,
        dateModified,
        isFolder,
      });
    }
    return { ok: true, results, total };
  } catch (err: any) {
    return { ok: false, reason: `call-failed: ${err?.message || err}` };
  }
}

export function isEverythingAvailable(): { available: boolean; reason?: string } {
  if (!ensureLoaded()) {
    return { available: false, reason: loadFailedReason || 'unknown' };
  }
  // 실제 IPC 연결 여부는 가벼운 빈 쿼리로 확인 — DLL 로드 성공만으로는 Everything.exe 실행 여부를 알 수 없다.
  const probe = searchEverything('', { max: 1 });
  if (!probe.ok) return { available: false, reason: probe.reason };
  return { available: true };
}
