// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One board = one document store + one view store, and the few commands that touch both (#6764).
//
// The stores do not know about each other. A command that changes the node set — remove, undo,
// redo, discard, a moved server design — changes the document and then RECONCILES the view, so an
// inspector whose node is gone closes and the selection drops the ids that are gone. Those commands
// live here, once, rather than in every component that calls them.
//
// The draft slot is written here too. The document is written when its persisted part changes,
// EXCEPT while a card is being dragged: a drag changes `positions` on every frame, and the slot is
// written once, when the drag ends.

import { applyNodeChanges, type NodeChange, type XYPosition } from "@xyflow/react";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { isDesignNode } from "./derive";
import {
	createDocumentStore,
	designPart,
	draftOf,
	placeNodes,
	type DocumentState,
	type DocumentStore,
	type IncomingGraph,
	type LoadOptions,
	type ReseedOutcome,
} from "./document-store";
import {
	DRAFT_STORAGE_PREFIX,
	draftStorageKey,
	readDraft,
	writeDraft,
	type DraftState,
} from "./draft-persist";
import type { DraftSeed, NodeViewFlags, Positions } from "./types";
import { createViewStore, type ViewStore } from "./view-store";

/** No cards beside the design. One array, so a default argument is the same object every call. */
const NO_NODES: CanvasNode[] = [];

/** A board's stores. */
export interface CanvasStores {
	document: DocumentStore;
	view: ViewStore;
}

/** The persisted fields of a document, in the order they are compared. */
const DRAFT_FIELDS = [
	"designNodes",
	"positions",
	"collectionPositions",
	"baseline",
	"seed",
	"operations",
	"arranged",
	"appliedSeedKeys",
] as const satisfies readonly (keyof DraftState)[];

/** True when any persisted field of the document differs (by reference) between two states. */
function draftChanged(a: DocumentState, b: DocumentState): boolean {
	return DRAFT_FIELDS.some((field) => a[field] !== b[field]);
}

/** The view flags of a board node: everything on it that is not the design or its position. */
export function flagsOf(node: CanvasNode): NodeViewFlags {
	const { id: _id, type: _type, data: _data, position: _position, deletable: _deletable, ...flags } =
		node;
	return flags;
}

/** True when two flag sets hold the same values under the same keys. */
function sameFlags(a: NodeViewFlags | undefined, b: NodeViewFlags): boolean {
	const left = Object.entries(a ?? {});
	const right = Object.entries(b);
	if (left.length !== right.length) return false;
	return left.every(([key, value]) => right.some(([k, v]) => k === key && v === value));
}

/** True when two id lists are the same ids in the same order. */
function sameIds(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Joins the design, the cards beside it, their positions and their view flags into board nodes. */
export interface NodeJoiner {
	/**
	 * The board's nodes: design nodes first, then `others`. The SAME array comes back while all four
	 * inputs are the same objects, and a node whose own inputs did not change is the same object as
	 * last time — so a drag re-creates the dragged card and no other.
	 */
	join: (
		designNodes: CanvasNode[],
		others: CanvasNode[],
		positions: Positions,
		nodeView: Record<string, NodeViewFlags>,
	) => CanvasNode[];
}

/** Create a joiner with its own cache. */
export function createNodeJoiner(): NodeJoiner {
	let last: {
		designNodes: CanvasNode[];
		others: CanvasNode[];
		positions: Positions;
		nodeView: Record<string, NodeViewFlags>;
		joined: CanvasNode[];
	} | null = null;
	const perNode = new WeakMap<
		CanvasNode,
		{ position: XYPosition; flags: NodeViewFlags | undefined; joined: CanvasNode }
	>();

	/** One source node as a board node, reusing the last result when nothing about it moved. */
	const joinOne = (
		source: CanvasNode,
		positions: Positions,
		nodeView: Record<string, NodeViewFlags>,
	): CanvasNode => {
		const position = positions[source.id] ?? source.position;
		const flags = nodeView[source.id];
		const cached = perNode.get(source);
		if (cached && cached.position === position && cached.flags === flags) return cached.joined;
		const joined: CanvasNode = { ...flags, ...source, position };
		perNode.set(source, { position, flags, joined });
		return joined;
	};

	return {
		join: (designNodes, others, positions, nodeView) => {
			if (
				last &&
				last.designNodes === designNodes &&
				last.others === others &&
				last.positions === positions &&
				last.nodeView === nodeView
			) {
				return last.joined;
			}
			const joined = [...designNodes, ...others].map((n) => joinOne(n, positions, nodeView));
			last = { designNodes, others, positions, nodeView, joined };
			return joined;
		},
	};
}

/** The commands of one board: everything that touches the document and the view together. */
export interface Board extends CanvasStores {
	/** The board's nodes for `others` — the cards the design does not own, from their queries. */
	nodes: (others: CanvasNode[]) => CanvasNode[];
	/** The same join over values a caller already holds (a hook's subscriptions). */
	join: NodeJoiner["join"];

	/**
	 * Apply React Flow's node changes. A move writes positions only, as one undo step per drag;
	 * selection and measurement are view state; a structural change replaces the design nodes.
	 * Returns the cards the design does not own as they stand after the changes, for a caller that
	 * keeps them.
	 */
	onNodesChange: (changes: NodeChange<CanvasNode>[], others: CanvasNode[]) => CanvasNode[];

	/** Add a node, select it and open the inspector on it. Returns its id. */
	addNode: (kind: NodeKind, position?: XYPosition) => string;
	/** Add a node with a config and a placement, select it and open the inspector on it. */
	addNodeWithConfig: (
		kind: NodeKind,
		config: Record<string, unknown> | undefined,
		cloudIdentityId: string | null,
		position: XYPosition | undefined,
		ownProvider: CloudProviderSlug | null,
	) => string;
	/** Remove nodes; an inspector on one of them closes. `others` are the cards left beside them. */
	removeNodes: (ids: string[], others: CanvasNode[]) => void;
	undo: (others: CanvasNode[]) => void;
	redo: (others: CanvasNode[]) => void;
	discard: (others: CanvasNode[]) => void;
	/** Load a design as the saved state and close the rail. The zoned layout makes room for
	 * `others`. */
	load: (graph: IncomingGraph, others?: CanvasNode[]) => void;
	/** Take a server design (see `DocumentActions.reseed`) and reconcile the view with the result. */
	reseed: (graph: IncomingGraph, seed: DraftSeed, others?: CanvasNode[]) => ReseedOutcome;
	/** Back to an empty, unseeded board with nothing open. */
	reset: () => void;

	/**
	 * Point the draft at `scope`'s own sessionStorage slot and load it. True when a draft seeded for
	 * exactly that scope was restored; false when the slot was empty, unreadable or held another
	 * scope's draft — a stale slot is discarded rather than shown as this environment's design — in
	 * which case the board is reset and the caller seeds it from the server.
	 */
	openDraftScope: (scope: string) => boolean;
	/** Write the draft under another key from now on. */
	setDraftKey: (key: string) => void;
	/** Write the draft now, whatever is in progress. For `pagehide`. */
	flushDraft: () => void;
}

/** Create a board: its two stores, wired to one draft slot. */
export function createBoard(): Board {
	const document = createDocumentStore();
	const view = createViewStore();
	const joiner = createNodeJoiner();
	// The un-scoped slot, until `openDraftScope` points the draft at a project:environment.
	let draftKey = DRAFT_STORAGE_PREFIX;

	document.subscribe((state, previous) => {
		if (state.moving) return;
		// The end of a drag is a write even though the last frame changed nothing persisted: the
		// frames before it were skipped.
		if (draftChanged(state, previous) || previous.moving) writeDraft(draftKey, draftOf(state));
	});

	/** The board's nodes as they stand right now. */
	const nodes = (others: CanvasNode[]) => {
		const d = document.getState();
		return joiner.join(d.designNodes, others, d.positions, view.getState().nodeView);
	};

	/** The layout options that make room for `others` where they sit now. */
	const layoutAround = (others: CanvasNode[]): LoadOptions => ({
		layoutWith: placeNodes(others, document.getState().positions),
	});

	/** The node set changed: close what points at a node that is gone. */
	const reconcile = (others: CanvasNode[], clearSelection: boolean) =>
		view.getState().reconcile(nodes(others), { clearSelection });

	/** Select a node and open the inspector on it. */
	const inspect = (id: string) => {
		view.getState().openCard({ kind: "inspector", nodeId: id });
		view.getState().setSelection([id]);
	};

	return {
		document,
		view,
		nodes,
		join: joiner.join,

		onNodesChange: (changes, others) => {
			const before = nodes(others);
			const after = applyNodeChanges(changes, before);
			const structural = changes.some(
				(c) => c.type === "remove" || c.type === "add" || c.type === "replace",
			);
			let nextOthers = others;
			if (structural) {
				// React Flow itself added, removed or replaced a node. The board routes its own adds
				// and deletes through the document's actions, so this is not an undo step.
				document.getState().replaceNodes(after);
				nextOthers = after
					.filter((n) => !isDesignNode(n))
					.map((n) => designPart(n, n.position));
			} else {
				const moves: Positions = {};
				let moved = false;
				let dragging = false;
				for (const change of changes) {
					if (change.type !== "position") continue;
					moved = true;
					if (change.dragging === true) dragging = true;
					if (change.position) moves[change.id] = change.position;
				}
				if (moved) {
					document.getState().beginMove();
					document.getState().moveNodes(moves, { moving: dragging });
				}
			}
			// Selection, measurement and the rest of React Flow's per-node state.
			const current = view.getState().nodeView;
			let nodeView = current;
			for (const [i, node] of after.entries()) {
				if (node === before[i]) continue;
				const flags = flagsOf(node);
				if (sameFlags(current[node.id], flags)) continue;
				if (nodeView === current) nodeView = { ...current };
				nodeView[node.id] = flags;
			}
			if (nodeView !== current) view.getState().setNodeView(nodeView);
			const selection = after.filter((n) => n.selected).map((n) => n.id);
			if (!sameIds(selection, view.getState().selection)) {
				view.getState().setSelection(selection);
			}
			return nextOthers;
		},

		addNode: (kind, position) => {
			const { id } = document.getState().addNode(kind, position);
			inspect(id);
			return id;
		},

		addNodeWithConfig: (kind, config, cloudIdentityId, position, ownProvider) => {
			const { id } = document
				.getState()
				.addNodeWithConfig(kind, config, cloudIdentityId, position, ownProvider);
			inspect(id);
			return id;
		},

		removeNodes: (ids, others) => {
			if (document.getState().removeNodes(ids).length === 0) return;
			reconcile(others, true);
		},

		undo: (others) => {
			if (document.getState().undo()) reconcile(others, true);
		},

		redo: (others) => {
			if (document.getState().redo()) reconcile(others, true);
		},

		discard: (others) => {
			document.getState().discard();
			reconcile(others, true);
		},

		load: (graph, others = NO_NODES) => {
			document.getState().load(graph, layoutAround(others));
			view.getState().openCard(null);
			view.getState().setSelection([]);
		},

		reseed: (graph, seed, others = NO_NODES) => {
			const outcome = document.getState().reseed(graph, seed, layoutAround(others));
			if (outcome === "loaded") {
				view.getState().openCard(null);
				view.getState().setSelection([]);
			}
			// Form-derived ids are deterministic (`${kind}-${name}`), so the card the user had open
			// almost always still names a node in the new design — keep it, and the selection.
			if (outcome === "replaced") reconcile(others, false);
			return outcome;
		},

		reset: () => {
			document.getState().reset();
			view.getState().reset();
		},

		openDraftScope: (scope) => {
			draftKey = draftStorageKey(scope);
			const draft = readDraft(draftKey);
			// The history, the open card and the selection belong to the editing session of one scope;
			// none of them travels to another, restored or not.
			view.getState().reset();
			if (!draft || draft.seed?.scope !== scope) {
				document.getState().reset();
				return false;
			}
			document.getState().hydrate(draft);
			return true;
		},

		setDraftKey: (key) => {
			draftKey = key;
		},

		flushDraft: () => writeDraft(draftKey, draftOf(document.getState())),
	};
}

/**
 * The board outside any workbench: what `useBoard()` returns with no `CanvasStoreProvider` above
 * it (a component test, the assistant panel on a page without a board). A workbench never edits
 * this one; it edits the board of its own scope, from {@link boardFor}.
 */
export const board: Board = createBoard();

/** The boards this tab has opened, one per project:environment. */
const boards = new Map<string, Board>();

/**
 * The board of one project:environment: created the first time the scope is opened, and the same
 * board every time after, for the life of the tab. Two environments never share stores, so a write
 * that lands after the person switched environments lands on the board it was meant for, and
 * switching back finds that board as it was left.
 */
export function boardFor(scope: string): Board {
	const found = boards.get(scope);
	if (found) return found;
	const created = createBoard();
	boards.set(scope, created);
	return created;
}
