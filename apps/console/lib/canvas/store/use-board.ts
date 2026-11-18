"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's read side (#6764): one hook per fact a component draws.
//
// Each hook subscribes to the narrowest thing it can. A hook that reads the DESIGN subscribes to
// `designNodes`, which a drag does not replace — so a card being moved re-renders the cards that
// read positions and none of the ones that read config, validation or the pending changes.
//
// Nothing here reads server data. The cards the design does not own come from their queries in
// `use-board-sources.ts` and are passed in as `others`.

import { useMemo } from "react";
import { useStore } from "zustand";
import type {
	CanvasEdge,
	CanvasNode,
} from "@/components/design-project/canvas/graph/types";
import { useBoard } from "./canvas-store-provider";
import {
	deployGate,
	deriveEdges,
	diffFields,
	diffNodes,
	planReviewState,
	type DeployGate,
	type PlanReviewState,
} from "./derive";
import type {
	BoardSeed,
	FieldChange,
	FieldFocus,
	InspectorTab,
	PendingChange,
	Positions,
	ReviewedPlan,
	StagedOperation,
	Subject,
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
