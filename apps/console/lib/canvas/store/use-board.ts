"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's read side (#6764): one hook per fact a component draws.
//
// Each hook subscribes to the narrowest thing it can. A hook that reads the DESIGN subscribes to
// `designNodes`, which a drag does not replace — so a card being moved re-renders the cards that
// read positions and none of the ones that read config, validation or the pending changes.
//
// Nothing here holds server data. The cards the design does not own come from their queries in
// `use-board-sources.ts`, and reach these hooks either as an `others` argument or from the
// `BoardSourcesProvider` the canvas mounts (`useOthers`).

import { useMemo } from "react";
import { useStore } from "zustand";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type {
	CanvasEdge,
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CollectionPositions } from "@/lib/canvas/collections";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { boardActions, type BoardActions } from "./board-actions";
import { useBoard, useIdentities, useOthers } from "./canvas-store-provider";
import {
	coreIdentity,
	deployGate,
	deriveEdges,
	diffFields,
	diffNodes,
	effectiveIdentity,
	effectiveProvider,
	planReviewState,
	type DeployGate,
	type PlanReviewState,
} from "./derive";
import {
	PROJECT_NODE_ID,
	type BoardSeed,
	type FieldChange,
	type FieldFocus,
	type InspectorTab,
	type PendingChange,
	type Positions,
	type ReviewedPlan,
	type StagedOperation,
	type Subject,
	type WorkspaceCard,
} from "./types";

const indexCache = new WeakMap<CanvasNode[], Map<string, CanvasNode>>();

/** The nodes of `list` by id. Built once per list, so a lookup by id is not a scan per card. */
export function nodeIndex(list: CanvasNode[]): Map<string, CanvasNode> {
	const cached = indexCache.get(list);
	if (cached) return cached;
	const index = new Map(list.map((n) => [n.id, n]));
	indexCache.set(list, index);
	return index;
}

/** The design's nodes, without positions. The same array until the design itself changes. */
export function useDesignNodes(): CanvasNode[] {
	return useStore(useBoard().document, (s) => s.designNodes);
}

/** Where every card sits. Replaced on every frame of a drag. */
export function usePositions(): Positions {
	return useStore(useBoard().document, (s) => s.positions);
}

/** One design node by id (without its position), or undefined when it is not in the design. */
export function useNode(id: string): CanvasNode | undefined {
	return useStore(useBoard().document, (s) => nodeIndex(s.designNodes).get(id));
}

/**
 * The board's nodes: the design joined with `others` — the cards the design does not own — each at
 * its position, carrying React Flow's own flags. Pass a stable `others` (a `useMemo` over the
 * queries) or the join runs on every render.
 */
export function useBoardNodes(others: CanvasNode[]): CanvasNode[] {
	const board = useBoard();
	const designNodes = useDesignNodes();
	const positions = usePositions();
	const nodeView = useStore(board.view, (s) => s.nodeView);
	return useMemo(
		() => board.join(designNodes, others, positions, nodeView),
		[board, designNodes, others, positions, nodeView],
	);
}

/** The board's edges, derived from the design and `others`. Unchanged by a drag. */
export function useBoardEdges(others: CanvasNode[]): CanvasEdge[] {
	const designNodes = useDesignNodes();
	return useMemo(() => deriveEdges([...designNodes, ...others]), [designNodes, others]);
}

/** Every node on the board: the design joined with the out-of-band cards in scope. */
export function useAllNodes(): CanvasNode[] {
	return useBoardNodes(useOthers());
}

/** Every edge on the board, the out-of-band cards' included. */
export function useAllEdges(): CanvasEdge[] {
	return useBoardEdges(useOthers());
}

/**
 * One node by id, whoever owns it: a design node from the document, else an out-of-band card from
 * its query. Without its position, so a card being dragged does not re-render what reads this.
 */
export function useAnyNode(id: string): CanvasNode | undefined {
	const design = useNode(id);
	const others = useOthers();
	return design ?? nodeIndex(others).get(id);
}

/**
 * The cloud a node deploys to: its own placement, else the project root's. An out-of-band card
 * has no placement of its own, so it reads as the project's cloud.
 */
export function useEffectiveProvider(id: string): CloudProviderSlug | null {
	const outOfBand = nodeIndex(useOthers()).has(id);
	return useStore(useBoard().document, (s) =>
		effectiveProvider(s.designNodes, outOfBand ? PROJECT_NODE_ID : id),
	);
}

/** The project root's chosen identity, the stack's CORE; null until one is picked. */
export function useCoreIdentity(): string | null {
	return useStore(useBoard().document, (s) => coreIdentity(s.designNodes));
}

/**
 * The identity a node resolves to (its own, else the core), from the page's identity list. An
 * out-of-band card has no identity of its own, so it resolves to the core.
 */
export function useEffectiveIdentity(id: string | null): CloudIdentityOption | null {
	const identities = useIdentities();
	const designNodes = useDesignNodes();
	const outOfBand = id !== null && nodeIndex(useOthers()).has(id);
	return useMemo(() => {
		if (id === null) return null;
		return effectiveIdentity(designNodes, outOfBand ? PROJECT_NODE_ID : id, identities);
	}, [designNodes, id, outOfBand, identities]);
}

/** The legacy rail card that shows the inspector's subject, or null when the rail is closed. */
export function useCard(): WorkspaceCard | null {
	return useStore(useBoard().view, (s) => s.card);
}

/** Whether the board draws its connections. */
export function useShowConnections(): boolean {
	return useStore(useBoard().view, (s) => s.showConnections);
}

/** The kinds the board is hiding. */
export function useHiddenKinds(): NodeKind[] {
	return useStore(useBoard().view, (s) => s.hiddenKinds);
}

/** Where each collapsed collection card sits. */
export function useCollectionPositions(): CollectionPositions {
	return useStore(useBoard().document, (s) => s.collectionPositions);
}

/** The board's commands, with the out-of-band cards and the identity list in scope bound in. */
export function useBoardActions(): BoardActions {
	const current = useBoard();
	const others = useOthers();
	const identities = useIdentities();
	return useMemo(() => boardActions(current, others, identities), [current, others, identities]);
}

/** The design changes pending against the saved design, one row per node. */
export function usePendingChanges(): PendingChange[] {
	const board = useBoard();
	const designNodes = useDesignNodes();
	const baseline = useStore(board.document, (s) => s.baseline);
	return useMemo(() => diffNodes(baseline, designNodes), [baseline, designNodes]);
}

/** The same pending changes, one row per changed field, with the saved and the drafted value. */
export function useFieldChanges(): FieldChange[] {
	const board = useBoard();
	const designNodes = useDesignNodes();
	const baseline = useStore(board.document, (s) => s.baseline);
	return useMemo(() => diffFields(baseline, designNodes), [baseline, designNodes]);
}

/** The out-of-band operations staged beside the design changes. */
export function useOperations(): StagedOperation[] {
	return useStore(useBoard().document, (s) => s.operations);
}

/** True when anything is pending: a design change or a staged operation. Derived, never stored. */
export function useIsDirty(): boolean {
	const changes = usePendingChanges();
	const operations = useOperations();
	return changes.length + operations.length > 0;
}

/** True when there is a step to undo. */
export function useCanUndo(): boolean {
	return useStore(useBoard().document, (s) => s.history.past.length > 0);
}

/** True when there is a step to redo. */
export function useCanRedo(): boolean {
	return useStore(useBoard().document, (s) => s.history.future.length > 0);
}

/** What the inspector shows, or null when the rail is closed. */
export function useSubject(): Subject | null {
	return useStore(useBoard().view, (s) => s.subject);
}

/** The inspector tab asked for, or null for the subject's default. */
export function useInspectorTab(): InspectorTab | null {
	return useStore(useBoard().view, (s) => s.tab);
}

/** The field the inspector should focus, or null. */
export function useFieldFocus(): FieldFocus | null {
	return useStore(useBoard().view, (s) => s.focus);
}

/** The ids selected on the board. */
export function useSelection(): string[] {
	return useStore(useBoard().view, (s) => s.selection);
}

/** The wizard hand-off waiting to be applied, or null. */
export function useSeedSlot(): BoardSeed | null {
	return useStore(useBoard().document, (s) => s.seedSlot?.seed ?? null);
}

/** What the board knows about the plan in front of a deploy. */
export interface PlanReview {
	reviewedPlan: ReviewedPlan | null;
	/** Whether the reviewed plan still describes the design on the board. */
	state: PlanReviewState;
	/** Whether Deploy may be offered, and for which plan. */
	gate: DeployGate;
}

/**
 * The reviewed plan against the design on the board. `serverCurrent` is the server's answer for
 * the same plan, when the caller has it; a false there makes the plan stale whatever the board
 * recorded.
 */
export function usePlanReview(serverCurrent?: boolean): PlanReview {
	const board = useBoard();
	const designNodes = useDesignNodes();
	const baseline = useStore(board.document, (s) => s.baseline);
	const operations = useOperations();
	const reviewedPlan = useStore(board.document, (s) => s.reviewedPlan);
	return useMemo(
		() => ({
			reviewedPlan,
			state: planReviewState(reviewedPlan, designNodes),
			gate: deployGate({ reviewedPlan, designNodes, baseline, operations, serverCurrent }),
		}),
		[reviewedPlan, designNodes, baseline, operations, serverCurrent],
	);
}
