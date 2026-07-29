// src/utils/feLayoutUtils.ts
// 파일 전송 워크스페이스의 상하좌우 분할 레이아웃 트리 유틸리티.
// src/utils/layoutUtils.ts(터미널 세션용)와 동일한 트리 구조(row/column 분할, sizes)를 쓰되,
// leaf 의 payload 가 PanelSession[] 대신 파일 브라우저 탭(FeTab[])이라는 점만 다르다.
import { makeId } from './layoutUtils';
import type { PanelSource, FileInfo } from '../components/FilePanel';

// entries — 마지막으로 로드된 디렉토리 목록 캐시. 창 분리/재합침으로 FilePanel 이 새
// 렌더러에서 다시 마운트될 때, 빈 목록에서 시작해 SFTP readdir 을 기다리는 대신 이 캐시로
// 즉시 그려주고 백그라운드에서 새로고침한다(깜빡임 방지 용도일 뿐 — 항상 최신은 loadDir 가 보장).
export type FeTab = { id: string; source: PanelSource; path: string; selected: Set<string>; entries?: FileInfo[] };
export type FePanel = { id: string; tabs: FeTab[]; activeIdx: number };

export type FeLeafNode = { id: string; type: 'leaf'; panel: FePanel };
export type FeContainerNode = {
  id: string;
  type: 'row' | 'column';
  children: FeLayoutNode[];
  sizes?: number[];
};
export type FeLayoutNode = FeLeafNode | FeContainerNode;

export function makeFeTab(source: PanelSource, path = ''): FeTab {
  return { id: makeId('fetab'), source, path, selected: new Set() };
}

export function createInitialFeLayout(localLabel: string): FeLayoutNode {
  return {
    id: makeId('fenode-root'),
    type: 'leaf',
    panel: { id: makeId('fepanel'), tabs: [makeFeTab({ mode: 'local', label: localLabel })], activeIdx: 0 },
  };
}

/**
 * 타겟 leaf 를 row/column 컨테이너로 교체. 새 leaf 는 localLabel 탭 하나로 시작.
 * newLeafId 를 지정하면 새로 생긴 leaf 의 id 를 호출부에서 미리 알 수 있어(예: 분할 직후 자동 포커스/탭 채우기).
 */
export function splitFeNode(
  root: FeLayoutNode,
  targetId: string,
  direction: 'row' | 'column',
  localLabel: string,
  insertBefore: boolean,
  newLeafId: string = makeId('fenode'),
): FeLayoutNode {
  if (root.id === targetId && root.type === 'leaf') {
    const existing: FeLeafNode = { id: root.id, type: 'leaf', panel: { ...root.panel } };
    const newLeaf: FeLeafNode = {
      id: newLeafId, type: 'leaf',
      panel: { id: makeId('fepanel'), tabs: [makeFeTab({ mode: 'local', label: localLabel })], activeIdx: 0 },
    };
    const children = insertBefore ? [newLeaf, existing] : [existing, newLeaf];
    return { id: makeId('fecontainer'), type: direction, children };
  }
  if (root.type === 'leaf') return root;
  return { ...root, children: root.children.map(child => splitFeNode(child, targetId, direction, localLabel, insertBefore, newLeafId)) };
}

/** leaf 제거 — 컨테이너가 자식 1개만 남으면 그 자식으로 대체(트리 자동 축약). */
export function removeFeLeafNode(root: FeLayoutNode, targetId: string): FeLayoutNode {
  if (root.type === 'leaf') return root;
  const children = root.children
    .map(child => removeFeLeafNode(child, targetId))
    .filter(child => !(child.type === 'leaf' && child.id === targetId));
  if (children.length === 0) return root;
  if (children.length === 1) return children[0];
  return { ...root, children };
}

/** 지정한 leaf 의 panel 을 updater 로 갱신 */
export function updateFeLeafPanel(root: FeLayoutNode, targetId: string, updater: (p: FePanel) => FePanel): FeLayoutNode {
  if (root.type === 'leaf') {
    if (root.id !== targetId) return root;
    return { ...root, panel: updater(root.panel) };
  }
  return { ...root, children: root.children.map(child => updateFeLeafPanel(child, targetId, updater)) };
}

export function resetFeLayoutSizes(node: FeLayoutNode): FeLayoutNode {
  if (node.type === 'leaf') return node;
  const { sizes: _drop, ...rest } = node;
  return { ...rest, children: node.children.map(resetFeLayoutSizes) };
}

export function countFeLeaves(node: FeLayoutNode): number {
  if (node.type === 'leaf') return 1;
  return node.children.reduce((sum, child) => sum + countFeLeaves(child), 0);
}

export function findFirstFeLeafId(node: FeLayoutNode): string | null {
  if (node.type === 'leaf') return node.id;
  for (const child of node.children) {
    const found = findFirstFeLeafId(child);
    if (found) return found;
  }
  return null;
}

/** 트리 안의 모든 leaf 를 DFS 순서로 수집 (id + panel) */
export function collectFeLeaves(node: FeLayoutNode): { id: string; panel: FePanel }[] {
  if (node.type === 'leaf') return [{ id: node.id, panel: node.panel }];
  return node.children.flatMap(collectFeLeaves);
}

/** 전체 트리에서 특정 termId 를 가진 탭을 찾아 {leafId, idx} 반환 */
export function findFeTabByTermId(node: FeLayoutNode, termId: string): { leafId: string; idx: number } | null {
  for (const leaf of collectFeLeaves(node)) {
    const idx = leaf.panel.tabs.findIndex(t => t.source.termId === termId);
    if (idx >= 0) return { leafId: leaf.id, idx };
  }
  return null;
}

/** 트리 전체의 모든 탭을 fn 으로 매핑 (예: 특정 termId 연결 해제 시 로컬로 되돌리기) */
export function mapAllFeTabs(root: FeLayoutNode, fn: (tab: FeTab) => FeTab): FeLayoutNode {
  if (root.type === 'leaf') return { ...root, panel: { ...root.panel, tabs: root.panel.tabs.map(fn) } };
  return { ...root, children: root.children.map(child => mapAllFeTabs(child, fn)) };
}

/** 특정 컨테이너 노드의 분할 비율(sizes) 갱신 — 드래그로 divider 조절 시 사용 */
export function setFeContainerSizes(root: FeLayoutNode, containerId: string, sizes: number[]): FeLayoutNode {
  if (root.type === 'leaf') return root;
  if (root.id === containerId) return { ...root, sizes };
  return { ...root, children: root.children.map(child => setFeContainerSizes(child, containerId, sizes)) };
}

/** 상태 저장(창 분리/재도킹)을 위한 직렬화 — Set → Array */
export function serializeFeLayout(node: FeLayoutNode): any {
  if (node.type === 'leaf') {
    return {
      id: node.id, type: 'leaf',
      panel: {
        id: node.panel.id, activeIdx: node.panel.activeIdx,
        tabs: node.panel.tabs.map(t => ({ id: t.id, source: t.source, path: t.path, selected: Array.from(t.selected), entries: t.entries })),
      },
    };
  }
  return { id: node.id, type: node.type, sizes: node.sizes, children: node.children.map(serializeFeLayout) };
}

/** 백엔드(main)에 아직 살아있는 연결 id 집합 — 창 분리/재부착 직전에 App.tsx 의 seedReattach 가
 * `fe:connected-sessions`(SSHBridge.clients 키 목록) 로 채운다.
 *
 * 왜 필요한가: reviveFeLayout 은 termId 가 "지금도 살아있는지"를 isLiveTermId 로 판단하는데,
 * FileExplorer 는 그 자리에 TerminalPanel 의 isTermConnected 를 넘긴다. 그런데 파일전송이 직접 맺는
 * SFTP 전용 연결(`fe-lazy-…`, `sftp-…`)은 인터랙티브 터미널이 아니라서 isTermConnected 가 항상
 * false 다 — 그래서 창을 분리/복원할 때마다 살아있는 연결까지 lazy-remote 로 강등돼 전부 재연결 +
 * 파일목록 재로딩이 발생했다(사용자 재현). 이 집합을 같이 참고해서 살아있는 연결은 그대로 둔다.
 *
 * 앱을 재시작한 경우엔 seedReattach 가 안 돌아 이 집합이 비어 있으므로, 기존처럼 정상적으로
 * 강등 → 재연결된다(백엔드 연결도 실제로 죽어있으니 그게 맞다). */
const liveBackendConnIds = new Set<string>();
/** 백엔드에서 조회한 살아있는 연결 목록으로 교체 — main 이 authoritative 이므로 누적이 아니라 대체. */
export function setLiveBackendConnIds(ids: string[]) {
  liveBackendConnIds.clear();
  for (const id of ids) if (id) liveBackendConnIds.add(id);
}
export function isLiveBackendConnId(termId: string): boolean {
  return liveBackendConnIds.has(termId);
}

/** serializeFeLayout 의 역변환. 형식이 어긋나거나 빈 트리면 null.
 * remote(실제 연결) 소스는 termId(연결 세션의 임시 id)가 새 실행/재마운트에서는 보통 이미 무효하므로
 * 그대로 되살리지 않고 lazy-remote(세션 참조만 유지, 선택 시 자동 재연결)로 강등해서 복원한다 —
 * 그래야 FileExplorer 가 마운트 후 자동으로 다시 SFTP 연결을 맺고 저장된 path 로 이동할 수 있다.
 * 단, isLiveTermId 로 termId 가 "지금도 살아있는 연결"이라고 확인되면(창 분리/재합침처럼 백엔드
 * 세션이 끊기지 않은 경우) 강등하지 않고 remote 그대로 유지 — 안 그러면 살아있는 연결인데도
 * 매번 재연결 + 파일목록 재로딩이 발생한다.
 */
export function reviveFeLayout(saved: any, localLabel: string, isLiveTermId?: (termId: string) => boolean): FeLayoutNode | null {
  if (!saved || typeof saved !== 'object') return null;
  if (saved.type === 'leaf') {
    const rawTabs = Array.isArray(saved.panel?.tabs) ? saved.panel.tabs : [];
    const tabs: FeTab[] = rawTabs.map((t: any) => {
      let source: PanelSource = t?.source || { mode: 'local', label: localLabel };
      if (source.mode === 'remote' && !(source.termId && isLiveTermId?.(source.termId))) {
        if (source.sessionId) {
          source = { mode: 'lazy-remote', sessionId: source.sessionId, label: source.label, viewRoot: source.viewRoot };
        } else if (source.manualConn) {
          // 세션 저장이 안 된 즉석 SFTP 연결 — manualConn 자격증명으로 lazy 재연결 대상이 된다.
          source = { mode: 'lazy-remote', manualConn: source.manualConn, label: source.label, viewRoot: source.viewRoot };
        }
      }
      return {
        id: String(t?.id || makeId('fetab')),
        source,
        path: String(t?.path || ''),
        selected: new Set<string>(Array.isArray(t?.selected) ? t.selected : []),
        entries: Array.isArray(t?.entries) ? t.entries : undefined,
      };
    });
    if (tabs.length === 0) return null;
    const activeIdx = Math.min(Math.max(0, Number(saved.panel?.activeIdx) || 0), tabs.length - 1);
    return { id: String(saved.id || makeId('fenode')), type: 'leaf', panel: { id: String(saved.panel?.id || makeId('fepanel')), tabs, activeIdx } };
  }
  if (saved.type === 'row' || saved.type === 'column') {
    const children = (Array.isArray(saved.children) ? saved.children : [])
      .map((c: any) => reviveFeLayout(c, localLabel, isLiveTermId))
      .filter((c: FeLayoutNode | null): c is FeLayoutNode => !!c);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    const sizes = Array.isArray(saved.sizes) && saved.sizes.length === children.length ? saved.sizes : undefined;
    return { id: String(saved.id || makeId('fecontainer')), type: saved.type, children, sizes };
  }
  return null;
}
