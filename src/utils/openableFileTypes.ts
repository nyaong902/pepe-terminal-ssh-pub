// src/utils/openableFileTypes.ts
// 파일전송/파일트리/Pepe-Thing 등 여러 곳에서 "이 파일을 미디어/오피스 워크스페이스로 열 수
// 있는가"를 판단할 때 쓰는 확장자 목록 — electron/main.ts 의 MEDIA_OPEN_FILTER / OFFICE_OPEN_FILTERS
// 와 동일한 세트를 렌더러 쪽에 둔 것(메인/렌더러 프로세스 간 직접 import 가 안 되어 값만 맞춰 둔다).
import type { OfficeFormat } from '../components/OfficeLauncher';

export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  'wav', 'alaw', 'pcma', 'al', 'ulaw', 'pcmu', 'mulaw', 'ul',
  'amr', 'amrnb', 'awb', 'amrwb', 'evs', 'opus', 'raw',
]);

// 레거시 바이너리 포맷(.doc/.xls/.ppt)은 ZiziyiOfficeWorkspace(OOXML 전용)가 지원하지 않아 제외.
export const OFFICE_EXTENSION_MAP: Readonly<Record<string, OfficeFormat>> = {
  hwp: 'hwp', hwpx: 'hwp',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  pdf: 'pdf',
};

export function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

export function isMediaExtension(fileName: string): boolean {
  return MEDIA_EXTENSIONS.has(getExtension(fileName));
}

export function getOfficeFormatForFile(fileName: string): OfficeFormat | null {
  return OFFICE_EXTENSION_MAP[getExtension(fileName)] || null;
}
