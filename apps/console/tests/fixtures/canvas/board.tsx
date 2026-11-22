// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Arranging a board for a test, and reading it back (#7129).
//
// Each helper is one or two calls on the board's own stores, named for what a test means by it.
// They replace the legacy `useCanvasStore.setState(...)` arrangements, and write only to the stores
// that own each value: the design and its positions to the document, React Flow's per-node flags
// to the view. A card the design does not own is never written anywhere — a test that needs one on
// the board hands it to `BoardSourcesProvider` (`withBoardSources` below), exactly as the canvas
// hands it its query data.

import type { ReactNode } from "react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { board as outside, flagsOf, type Board } from "@/lib/canvas/store/board";
import { BoardSourcesProvider, CanvasStoreProvider } from "@/lib/canvas/store/canvas-store-provider";
import { isDesignNode } from "@/lib/canvas/store/derive";
import { pendingCount } from "@/lib/canvas/store/document-store";
import type { NodeViewFlags, WorkspaceCard } from "@/lib/canvas/store/types";

/** Write React Flow's flags of `nodes` (selected, measured …) into the view. */
function writeFlags(target: Board, nodes: CanvasNode[]): void {
	const nodeView: Record<string, NodeViewFlags> = {};
	for (const node of nodes) {
		const flags = flagsOf(node);
		if (Object.keys(flags).length > 0) nodeView[node.id] = flags;
	}
	target.view.getState().setNodeView(nodeView);
}

/**
 * Put `nodes` on the board as its design, at their positions, with no undo step; the saved design
 * is left as it is. Out-of-band nodes among them are ignored: the document never holds one.
 */
export function setBoardNodes(nodes: CanvasNode[], target: Board = outside): void {
	target.document.getState().replaceNodes(nodes);
	writeFlags(target, nodes);
}

/** A clean board holding exactly `nodes`: the design AND the saved design, no history, nothing open. */
export function seedBoard(nodes: CanvasNode[], target: Board = outside): void {
	target.reset();
	setBoardNodes(nodes, target);
	target.document.getState().replaceBaseline(structuredClone(nodes.filter(isDesignNode)));
}

/** The board's nodes as they stand: the design at its positions, then `others`. */
export function boardNodes(target: Board = outside, others: CanvasNode[] = []): CanvasNode[] {
	return target.nodes(others);
}

/** One of the board's nodes by id, at its position. */
export function boardNode(
	id: string,
	target: Board = outside,
	others: CanvasNode[] = [],
): CanvasNode | undefined {
	return target.nodes(others).find((n) => n.id === id);
}

/** True when anything is pending against the saved design. */
export function isBoardDirty(target: Board = outside): boolean {
	return pendingCount(target.document.getState()) > 0;
}

/** The legacy rail card the view shows, or null. */
export function boardCard(target: Board = outside): WorkspaceCard | null {
	return target.view.getState().card;
}

/** The node the inspector card is on, or null when the rail shows anything else. */
export function inspectorNodeId(target: Board = outside): string | null {
	const card = target.view.getState().card;
	return card?.kind === "inspector" ? card.nodeId : null;
}

/**
 * `children` with `others` on the board beside the design, as the canvas hands them from their
 * queries. With `scope`, the board is that scope's (`boardFor`) and the identity list is published
 * with it; without, it is the board outside any workbench and `identities` is ignored.
 */
export function withBoardSources(
	children: ReactNode,
	options: {
		others?: CanvasNode[];
		iacOutputs?: string[];
		scope?: string;
		identities?: readonly CloudIdentityOption[];
	} = {},
): ReactNode {
	const sources = (
		<BoardSourcesProvider others={options.others ?? []} iacOutputs={options.iacOutputs ?? []}>
			{children}
		</BoardSourcesProvider>
	);
	if (options.scope === undefined) return sources;
	return (
		<CanvasStoreProvider scope={options.scope} identities={options.identities ?? []}>
			{sources}
		</CanvasStoreProvider>
	);
}
