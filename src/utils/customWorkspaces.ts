import type React from 'react';

export type CustomWorkspaceKind =
  | 'terminal'
  | 'browser'
  | 'compare'
  | 'logAnalyzer'
  | 'fileTransfer'
  | 'microSip'
  | 'vpn';

export type CustomWorkspaceLayoutPreset =
  | 'row2'
  | 'row3'
  | 'column2'
  | 'column3'
  | 'grid4'
  | 'grid6';

export type CustomWorkspaceLastSession = {
  id: string;
  sessionId: string;
  name: string;
  host?: string;
  username?: string;
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
};

export type CustomWorkspaceSlot = {
  id: string;
  kind: CustomWorkspaceKind | null;
  // 터미널 슬롯 — 마지막으로 연결했던 세션. 워크스페이스 탭을 새로 열 때 자동 접속에 사용.
  lastSession?: CustomWorkspaceLastSession;
};

export type CustomWorkspaceTemplate = {
  id: string;
  name: string;
  layout: CustomWorkspaceLayoutPreset;
  slots: CustomWorkspaceSlot[];
  createdAt: number;
  updatedAt: number;
};

export type CustomWorkspaceTemplateDraft = {
  id?: string;
  name: string;
  layout: CustomWorkspaceLayoutPreset;
  slots: CustomWorkspaceSlot[];
};

type LayoutSpec = {
  labelKey: string;
  cols: number;
  rows: number;
};

export const CUSTOM_WORKSPACE_LAYOUTS: Record<CustomWorkspaceLayoutPreset, LayoutSpec> = {
  row2: { labelKey: 'layouts.row2', cols: 2, rows: 1 },
  row3: { labelKey: 'layouts.row3', cols: 3, rows: 1 },
  column2: { labelKey: 'layouts.column2', cols: 1, rows: 2 },
  column3: { labelKey: 'layouts.column3', cols: 1, rows: 3 },
  grid4: { labelKey: 'layouts.grid4', cols: 2, rows: 2 },
  grid6: { labelKey: 'layouts.grid6', cols: 3, rows: 2 },
};

export const CUSTOM_WORKSPACE_KIND_ORDER: CustomWorkspaceKind[] = [
  'terminal',
  'browser',
  'compare',
  'fileTransfer',
  'logAnalyzer',
  'microSip',
  'vpn',
];

export function customWorkspaceSlotCount(layout: CustomWorkspaceLayoutPreset): number {
  const spec = CUSTOM_WORKSPACE_LAYOUTS[layout];
  return spec.cols * spec.rows;
}

export function createCustomWorkspaceTemplateDraft(name: string, layout: CustomWorkspaceLayoutPreset): CustomWorkspaceTemplateDraft {
  const count = customWorkspaceSlotCount(layout);
  return {
    name,
    layout,
    slots: Array.from({ length: count }, (_, i) => ({ id: `slot-${i + 1}`, kind: null })),
  };
}

export function createCustomWorkspaceTemplate(name: string, layout: CustomWorkspaceLayoutPreset): CustomWorkspaceTemplate {
  const draft = createCustomWorkspaceTemplateDraft(name, layout);
  const now = Date.now();
  return {
    id: `cw-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name: draft.name,
    layout: draft.layout,
    slots: draft.slots,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeCustomWorkspaceTemplate(template: CustomWorkspaceTemplate): CustomWorkspaceTemplate {
  const count = customWorkspaceSlotCount(template.layout);
  const slots = Array.from({ length: count }, (_, i) => template.slots[i] || { id: `slot-${i + 1}`, kind: null });
  return {
    ...template,
    slots,
    updatedAt: Date.now(),
  };
}

export function gridStyleForLayout(layout: CustomWorkspaceLayoutPreset): React.CSSProperties {
  const spec = CUSTOM_WORKSPACE_LAYOUTS[layout];
  return {
    display: 'grid',
    gridTemplateColumns: `repeat(${spec.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${spec.rows}, minmax(0, 1fr))`,
  };
}
