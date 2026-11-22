// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board's commands, bound to the server data they need (#7129).
//
// Several of the board's commands take `others`, the cards the design does not own, because they
// lay out around them, join them into the node set or reconcile the view against them; adding a
// node on a chosen cloud account takes the identity list, to stamp that account's cloud on it.
// Both are server data, read from their queries and handed down — never held in a store. This
// binds them once, so a component calls `removeNodes(ids)` and not
// `board.removeNodes(ids, others)` with an `others` it had to find for itself.

import type { NodeChange, XYPosition } from "@xyflow/react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import type { Board } from "./board";
import { effectiveProvider } from "./derive";
import { placeNodes } from "./document-store";

/** The board's commands with `others` and the identity list already bound. */
export interface BoardActions {
	/** The board's nodes as they stand right now: the design, then the out-of-band cards. */
	nodes: () => CanvasNode[];
	/** The cloud a node deploys to, as the board stands right now. */
	effectiveProvider: (id: string) => CloudProviderSlug | null;
	/** Apply React Flow's node changes. */
	onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
	/** Add a node of `kind`, select it and open the inspector on it. Returns its id. */
	addNode: (kind: NodeKind, position?: XYPosition) => string;
	/** Add a node with a config, on a cloud account when one is named. Returns its id. */
	addNodeWithConfig: (
		kind: NodeKind,
		config?: Record<string, unknown>,
		cloudIdentityId?: string | null,
		position?: XYPosition,
	) => string;
	/** Remove nodes; the project root and any `deletable: false` node are kept. One undo step. */
	removeNodes: (ids: string[]) => void;
	/** Duplicate the array-kind nodes among `ids`. One undo step. */
	duplicateNodes: (ids: string[]) => void;
	undo: () => void;
	redo: () => void;
	/** Revert the draft to the saved design. */
	discard: () => void;
	/** Push apart overlapping cards, the out-of-band ones included. One undo step. */
	repairOverlaps: () => void;
}

/** The commands of `board`, with the cards beside the design and the identity list bound in. */
export function boardActions(
	board: Board,
	others: CanvasNode[],
	identities: readonly CloudIdentityOption[],
): BoardActions {
	const nodes = () => board.nodes(others);
	return {
		nodes,
		effectiveProvider: (id) => effectiveProvider(nodes(), id),
		onNodesChange: (changes) => {
			board.onNodesChange(changes, others);
		},
		addNode: (kind, position) => board.addNode(kind, position),
		addNodeWithConfig: (kind, config, cloudIdentityId, position) => {
			const listed = identities.find((i) => i.id === cloudIdentityId)?.provider;
			const ownProvider = listed && isCloudProviderSlug(listed) ? listed : null;
			return board.addNodeWithConfig(kind, config, cloudIdentityId ?? null, position, ownProvider);
		},
		removeNodes: (ids) => board.removeNodes(ids, others),
		duplicateNodes: (ids) => {
			board.document.getState().duplicateNodes(ids);
		},
		undo: () => board.undo(others),
		redo: () => board.redo(others),
		discard: () => board.discard(others),
		repairOverlaps: () =>
			board.document
				.getState()
				.repairOverlaps(placeNodes(others, board.document.getState().positions)),
	};
}
