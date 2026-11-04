export type TechState = 'owned' | 'locked' | 'available' | 'waiting';
export const TECH_STATES: readonly TechState[];

export interface TechNode {
    id: string;
    /** 분류. 탭 하나가 되고, 배치는 분류 안의 requires로만 계산합니다. */
    branch: string;
    /** 최대 단계(1 이상). */
    max: number;
    /** 선행 노드 id. 모두 1단계 이상이어야 열립니다. 없으면 빈 배열. */
    requires: string[];
    /** 비용·설명 같은 게임 필드는 그대로 콜백에 전달됩니다. */
    [field: string]: unknown;
}

export interface TechNavigation {
    snapshot(): { screen: string; item?: string; query?: unknown };
    replace(route: { screen: string; item?: string; query?: unknown }): void;
    subscribe(listener: (route: { screen: string; item?: string }) => void): () => void;
}

/** 모든 문구는 게임(i18n)이 소유합니다. */
export interface TechText {
    branch(branch: string): string;
    name(node: TechNode): string;
    /** 노드 배지·aria-label에 쓰는 상태 문구(예: "투자 가능 · 0/3"). */
    state(state: TechState, node: TechNode, level: number): string;
    /** 구매 버튼 문구. */
    buy(state: TechState, node: TechNode, check: { ok: boolean } | null): string;
    /** 상세 아래 이유 문구(왜 못 사는지·사도 되는지). */
    reason(state: TechState, node: TechNode, check: { ok: boolean } | null): string;
    /** 선행 조건 칩 문구(예: "✓ 습득: 굵은 바늘"). */
    prerequisite(required: TechNode, met: boolean): string;
    /** 상세 머리의 단계 문구(예: "1/3"). */
    level(node: TechNode, level: number): string;
    zoomIn(): string;
    zoomOut(): string;
    fit(): string;
    /** 트리 패널의 접근성 이름. */
    map(): string;
}

export interface TechTreeOptions {
    root: HTMLElement;
    navigation: TechNavigation;
    /** `#/<screen>/<id>`의 화면 이름. */
    screen: string;
    nodes: TechNode[];
    /** 노드의 현재 단계(0 이상). */
    level(id: string): number;
    /** 선행 조건을 갖춘 노드를 지금 살 수 있는지. 포인트·재화 규칙은 게임 소유. */
    canBuy(node: TechNode): { ok: boolean; [field: string]: unknown };
    /** 구매를 실행합니다. 모듈은 레벨을 바꾸지 않으므로 게임이 저장한 뒤 `refresh()`를 부릅니다. */
    onBuy(id: string): void;
    /** 노드 버튼 안의 그림·이름(한 번만 부릅니다). 상태 배지는 모듈이 뒤에 붙입니다. */
    renderNode(node: TechNode, element: HTMLElement): void;
    /** 선택한 노드의 상세 본문(선택이 바뀔 때만 부릅니다). */
    renderDetail(node: TechNode, element: HTMLElement): void;
    text: TechText;
}

export interface TechTree {
    refresh(): void;
    readonly selected: string;
    stateOf(id: string): TechState;
    select(id: string): void;
    dispose(): void;
}

export function createTechTree(options: TechTreeOptions): TechTree;
