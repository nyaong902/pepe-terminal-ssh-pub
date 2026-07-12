// src/components/MediaLauncher.tsx
// 미디어 워크스페이스 진입점 — 오피스 워크스페이스(OfficeLauncher)와 달리 문서 형식 선택이 필요 없으므로
// 바로 MediaWorkspace 로 위임한다. instanceId 만 전달해 탭별 상태를 분리.
import { MediaWorkspace } from './MediaWorkspace';

export function MediaLauncher({ instanceId }: { instanceId: string }) {
  return <MediaWorkspace instanceId={instanceId} />;
}
