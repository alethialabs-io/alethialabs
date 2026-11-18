// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE LEGACY CANVAS STORE API, OVER THE SPLIT STORES (#6764).
//
// The canvas store is now `lib/canvas/store/`: a document store, a view store, the undo history,
// the draft slot and the functions that derive everything else. This file holds no design state.
// It is the old single-store API — `useCanvasStore((s) => s.nodes)`, `getState()`, `setState()` —
// implemented as a PROJECTION of those stores, so the shell files that have not been rebuilt yet
// keep compiling and behaving as they did. Each shell lane moves its files onto
// `lib/canvas/store/use-board.ts`; the close-out deletes this file.
//
// Three things live here only because the unconverted shell still needs them, and go with it:
//
//   - the MIRROR of server data (the identity list, the out-of-band cards, the BYO-IaC outputs).
//     `design-project-canvas.tsx` still copies its queries in through `setChartNodes`,
//     `setAddonNodes`, `setIacNodes` and friends. The copy is kept OUT of the document, which is
//     what stops undo, discard and the draft from ever containing one of those cards; the
//     replacement that needs no copy is `use-board-sources.ts`;
//   - `setState`, which the tests of unconverted files use to arrange a board. It routes each key
//     to the store that owns it;
//   - a `dirty` flag. It is derived (anything pending against the saved design), with one legacy
//     allowance: `setState({ dirty: true })` holds it true until the next save, discard or load.

import type { NodeChange, XYPosition } from "@xyflow/react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { ByoChartState, ChartWorkloadState } from "@/app/server/actions/byo-charts";
import type {
	CanvasEdge,
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CollectionPositions } from "@/lib/canvas/collections";
import type { IacGroup } from "@/lib/canvas/iac-inventory";
import { board, flagsOf } from "@/lib/canvas/store/board";
import {
	coreIdentity,
	deriveEdges,
	diffNodes,
	effectiveIdentity,
	effectiveProvider,
	isDesignNode,
	OUT_OF_BAND,
} from "@/lib/canvas/store/derive";
import { designPart, pendingCount, placeNodes } from "@/lib/canvas/store/document-store";
import { draftStorageKey } from "@/lib/canvas/store/draft-persist";
import type { HistoryEntry } from "@/lib/canvas/store/history";
import { withConfig } from "@/lib/canvas/store/normalize";
import {
	addonNodes,
	chartNodes,
	chartWorkloadNodes,
	iacNodes,
	type AddonCard,
} from "@/lib/canvas/store/out-of-band";
import {
	PROJECT_NODE_ID,
	type DraftSeed,
	type NodeViewFlags,
	type PendingChange,
	type Positions,
	type WorkspaceCard,
} from "@/lib/canvas/store/types";
import { subjectOfCard, tabOfCard } from "@/lib/canvas/store/view-store";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { ConversionWarning } from "@/lib/cloud-providers/convert";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";

export { deriveEdges, diffNodes, draftStorageKey, OUT_OF_BAND, PROJECT_NODE_ID };
export type { DraftSeed, PendingChange, WorkspaceCard };

/** The inspector's node id, or null when the rail shows something else (or nothing). */
export function selectInspectorNodeId(s: { card: WorkspaceCard | null }): string | null {
	return s.card?.kind === "inspector" ? s.card.nodeId : null;
}

interface CanvasStore {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	selectedIds: string[];
	/** The card on the workspace rail, or null when the rail is closed. */
	card: WorkspaceCard | null;
	/** Which scope + server revision the persisted draft was seeded from (null = never seeded). */
	seed: DraftSeed | null;
	/** True when anything is pending against the saved design. */
	dirty: boolean;
	/** The undo and redo steps, as the node sets they restore. */
	past: CanvasNode[][];
	future: CanvasNode[][];
	/** Last-saved/loaded snapshot the Pending Changes bar diffs against. */
	baseline: CanvasNode[];
	/** Revert the canvas to the baseline (discard all staged changes). */
	discardChanges: () => void;
	/** Mark the current canvas as the new saved baseline (after a successful deploy). */
	commitBaseline: () => void;
	/** Verified cloud identities (server data) — for label/provider lookup. */
	identities: CloudIdentityOption[];
	setIdentities: (identities: CloudIdentityOption[]) => void;
	getEffectiveIdentity: (id: string) => CloudIdentityOption | null;

	onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
	setGraph: (graph: { nodes: CanvasNode[] }) => void;
	/** Seed the draft from the server design without discarding what the user is doing. */
	reseed: (graph: { nodes: CanvasNode[] }, seed: DraftSeed) => void;
	/** Record the revision the draft now matches (after a save/deploy wrote the design). */
	setSeedRevision: (revision: string) => void;
	/** Replace all BYO chart nodes (out-of-band; not a staged change). */
	setChartNodes: (charts: ByoChartState[]) => void;
	/** Replace all described chart-workload nodes (out-of-band; not a staged change). */
	setChartWorkloadNodes: (workloads: ChartWorkloadState[]) => void;
	/** Replace the external cards of a BYO IaC module (out-of-band; read-only). */
	setIacNodes: (groups: IacGroup[]) => void;
	/** The BYO-IaC module's ROOT output names — the choices the service bind sheet offers. */
	iacOutputs: string[];
	setIacOutputs: (outputs: string[]) => void;
	/** Replace all marketplace add-on nodes (out-of-band; not a staged change). */
	setAddonNodes: (addons: AddonCard[]) => void;
	/** Add a node; returns the new node's id (or the existing one's, for a singleton already placed). */
	addNode: (kind: NodeKind, position?: { x: number; y: number }) => string;
	/** Add a node with an explicit config + placement. Returns the new node's id (or the existing
	 * singleton's). */
	addNodeWithConfig: (
		kind: NodeKind,
		config?: Record<string, unknown>,
		cloudIdentityId?: string | null,
		position?: { x: number; y: number },
	) => string;
	updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
	/** Re-place a node on another cloud identity. Returns the notices the move produced. */
	setNodeIdentity: (
		id: string,
		cloudIdentityId: string | null,
		provider: CloudProviderSlug | null,
	) => ConversionWarning[];
	/** Remove nodes. The project root and any `deletable: false` node are kept; one undo step. */
	removeNodes: (ids: string[]) => void;
	duplicateNodes: (ids: string[]) => void;
	/** Show a card on the workspace rail, replacing whatever is there. `{ back: true }` remembers
	 * the card it replaced, for a detour. */
	openCard: (card: WorkspaceCard, opts?: { back?: boolean }) => void;
	/** The card a detour came from, or null. Cleared by any non-detour open. */
	cardBack: WorkspaceCard | null;
	/** Return to the card a detour came from (no-op when there is none). */
	goBackCard: () => void;
	/** Close the rail. */
	closeCard: () => void;
	/** `openInspector(id)` = `openCard({kind:"inspector", nodeId})`; null closes the rail. */
	openInspector: (id: string | null) => void;
	/** Take an undo checkpoint ahead of a change. */
	commit: () => void;
	undo: () => void;
	redo: () => void;
	reset: () => void;

	/** Where each collection card (the Secrets vault) sits. */
	collectionPositions: CollectionPositions;
	setCollectionPosition: (kind: NodeKind, position: { x: number; y: number }) => void;

	/** Canvas view prefs (ephemeral UI state, not persisted). */
	showConnections: boolean;
	toggleConnections: () => void;
	hiddenKinds: NodeKind[];
	toggleKindVisibility: (kind: NodeKind) => void;
	/** Push apart overlapping cards. */
	repairOverlaps: () => void;
	/** Apply computed auto-layout positions and re-anchor the collection cards. */
	arrange: (positions: Record<string, XYPosition>) => void;

	getCoreIdentity: () => string | null;
	getEffectiveProvider: (id: string) => CloudProviderSlug | null;
}

/** The server data the unconverted shell still copies in, kept apart from the document. */
interface LegacyMirror {
	identities: CloudIdentityOption[];
	iacOutputs: string[];
	/** The out-of-band cards, as the legacy setters last built them. */
	others: CanvasNode[];
	/** `setState({ dirty: true })`, held until the next save, discard or load. */
	dirtyHint: boolean;
}

const mirror = createStore<LegacyMirror>()(() => ({
	identities: [],
	iacOutputs: [],
	others: [],
	dirtyHint: false,
}));

/** The board's nodes as the legacy store presents them: the design, then the mirrored cards. */
function boardNodes(): CanvasNode[] {
	return board.nodes(mirror.getState().others);
}

/** The mirrored cards at their current positions, for commands that lay out around them. */
function placedOthers(): CanvasNode[] {
	return placeNodes(mirror.getState().others, board.document.getState().positions);
}

/** Replace the mirrored cards of one kind with `next`, keeping the rest in place. */
function replaceOthers(kind: NodeKind, next: CanvasNode[]): void {
	const others = mirror.getState().others;
	const kept = others.filter((n) => n.data.kind !== kind);
	// Nothing of this kind before and nothing now: the same array, so nothing re-renders.
	if (next.length === 0 && kept.length === others.length) return;
	mirror.setState({ others: [...kept, ...next] });
}

// ── the projection ───────────────────────────────────────────────────────────────────────────

let edgesMemo: { designNodes: CanvasNode[]; others: CanvasNode[]; edges: CanvasEdge[] } | null =
	null;

/** The derived edges, recomputed only when the design or the mirrored cards change. */
function projectEdges(designNodes: CanvasNode[], others: CanvasNode[]): CanvasEdge[] {
	if (edgesMemo && edgesMemo.designNodes === designNodes && edgesMemo.others === others) {
		return edgesMemo.edges;
	}
	const edges = deriveEdges([...designNodes, ...others]);
	edgesMemo = { designNodes, others, edges };
	return edges;
}

const entryNodes = new WeakMap<HistoryEntry, CanvasNode[]>();
const stackMemo = new WeakMap<HistoryEntry[], CanvasNode[][]>();

/** A history stack as the node sets its steps restore; the same array for the same stack. */
function projectStack(stack: HistoryEntry[]): CanvasNode[][] {
	const cached = stackMemo.get(stack);
	if (cached) return cached;
	const projected = stack.map((entry) => {
		const known = entryNodes.get(entry);
		if (known) return known;
		const nodes = placeNodes(entry.designNodes, entry.positions);
		entryNodes.set(entry, nodes);
		return nodes;
	});
	stackMemo.set(stack, projected);
	return projected;
}

let pendingMemo: {
	designNodes: CanvasNode[];
	baseline: CanvasNode[];
	operations: unknown;
	pending: boolean;
} | null = null;

/** Whether anything is pending against the saved design, recomputed only when an input moves. */
function projectPending(): boolean {
	const d = board.document.getState();
	if (
		pendingMemo &&
		pendingMemo.designNodes === d.designNodes &&
		pendingMemo.baseline === d.baseline &&
		pendingMemo.operations === d.operations
	) {
		return pendingMemo.pending;
	}
	const pending = pendingCount(d) > 0;
	pendingMemo = {
		designNodes: d.designNodes,
		baseline: d.baseline,
		operations: d.operations,
		pending,
	};
	return pending;
}

/** The legacy store's data fields, read off the stores that own them. */
function project(): Pick<
	CanvasStore,
	| "nodes"
	| "edges"
	| "selectedIds"
	| "card"
	| "cardBack"
	| "seed"
	| "dirty"
	| "past"
	| "future"
	| "baseline"
	| "identities"
	| "iacOutputs"
	| "collectionPositions"
	| "showConnections"
	| "hiddenKinds"
> {
	const d = board.document.getState();
	const v = board.view.getState();
	const m = mirror.getState();
	return {
		nodes: board.nodes(m.others),
		edges: projectEdges(d.designNodes, m.others),
		selectedIds: v.selection,
		card: v.card,
		cardBack: v.cardBack,
		seed: d.seed,
		dirty: projectPending() || m.dirtyHint,
		past: projectStack(d.history.past),
		future: projectStack(d.history.future),
		baseline: d.baseline,
		identities: m.identities,
		iacOutputs: m.iacOutputs,
		collectionPositions: d.collectionPositions,
		showConnections: v.showConnections,
		hiddenKinds: v.hiddenKinds,
	};
}

// A command that touches more than one store is ONE change to the legacy store's subscribers:
// the projection is refreshed when the outermost command finishes, not after each store's write.
let commands = 0;
let stale = false;

/** Refresh the projection, unless a command is still in progress. */
function sync(): void {
	if (commands > 0) {
		stale = true;
		return;
	}
	stale = false;
	const next = project();
	const current = facade.getState();
	const changed =
		next.nodes !== current.nodes ||
		next.edges !== current.edges ||
		next.selectedIds !== current.selectedIds ||
		next.card !== current.card ||
		next.cardBack !== current.cardBack ||
		next.seed !== current.seed ||
		next.dirty !== current.dirty ||
		next.past !== current.past ||
		next.future !== current.future ||
		next.baseline !== current.baseline ||
		next.identities !== current.identities ||
		next.iacOutputs !== current.iacOutputs ||
		next.collectionPositions !== current.collectionPositions ||
		next.showConnections !== current.showConnections ||
		next.hiddenKinds !== current.hiddenKinds;
	if (changed) facade.setState(next);
}

/** Run `command` as one change to the legacy store. */
function run<T>(command: () => T): T {
	commands++;
	try {
		return command();
	} finally {
		commands--;
		if (commands === 0 && stale) sync();
	}
}

const facade = createStore<CanvasStore>()(() => ({
	...project(),

	setIdentities: (identities) => mirror.setState({ identities }),

	getEffectiveIdentity: (id) =>
		effectiveIdentity(boardNodes(), id, mirror.getState().identities),

	onNodesChange: (changes) =>
		run(() => {
			const others = mirror.getState().others;
			const next = board.onNodesChange(changes, others);
			if (next !== others) mirror.setState({ others: next });
		}),

	setGraph: (graph) =>
		run(() => {
			board.load(graph, mirror.getState().others);
			mirror.setState({ dirtyHint: false });
		}),

	reseed: (graph, seed) =>
		run(() => {
			const outcome = board.reseed(graph, seed, mirror.getState().others);
			if (outcome === "loaded" || outcome === "replaced") {
				mirror.setState({ dirtyHint: false });
			}
		}),

	setSeedRevision: (revision) => board.document.getState().setSeedRevision(revision),

	setChartNodes: (charts) => replaceOthers("chart", chartNodes(charts)),

	setChartWorkloadNodes: (workloads) => {
		const kept = placedOthers().filter((n) => n.data.kind !== "chart_workload");
		replaceOthers("chart_workload", chartWorkloadNodes(workloads, kept));
	},

	setIacNodes: (groups) => replaceOthers("external", iacNodes(groups)),

	setIacOutputs: (outputs) => mirror.setState({ iacOutputs: outputs }),

	setAddonNodes: (addons) => replaceOthers("addon", addonNodes(addons)),

	addNode: (kind, position) => run(() => board.addNode(kind, position)),

	addNodeWithConfig: (kind, config, cloudIdentityId, position) =>
		run(() => {
			const ownFound = mirror
				.getState()
				.identities.find((i) => i.id === cloudIdentityId)?.provider;
			const ownProvider = ownFound && isCloudProviderSlug(ownFound) ? ownFound : null;
			return board.addNodeWithConfig(
				kind,
				config,
				cloudIdentityId ?? null,
				position,
				ownProvider,
			);
		}),

	updateNodeConfig: (id, patch) => {
		const others = mirror.getState().others;
		if (others.some((n) => n.id === id)) {
			// A card the design does not own: its config is not a design edit and is not undone.
			mirror.setState({
				others: others.map((n) =>
					n.id === id ? { ...n, data: withConfig(n.data, patch) } : n,
				),
			});
			return;
		}
		board.document.getState().updateNodeConfig(id, patch);
	},

	setNodeIdentity: (id, cloudIdentityId, provider) =>
		board.document.getState().setNodeIdentity(id, cloudIdentityId, provider),

	removeNodes: (ids) => run(() => board.removeNodes(ids, mirror.getState().others)),

	duplicateNodes: (ids) => {
		board.document.getState().duplicateNodes(ids);
	},

	openCard: (card, opts) => board.view.getState().openCard(card, opts),
	goBackCard: () => board.view.getState().goBackCard(),
	closeCard: () => board.view.getState().openCard(null),
	openInspector: (id) => {
		// The card a detour came from is left as it is, as it always was by this shim.
		const card: WorkspaceCard | null = id ? { kind: "inspector", nodeId: id } : null;
		board.view.setState({
			card,
			subject: subjectOfCard(card),
			tab: tabOfCard(card),
			focus: null,
		});
	},

	commit: () => board.document.getState().checkpoint("commit"),
	undo: () => run(() => board.undo(mirror.getState().others)),
	redo: () => run(() => board.redo(mirror.getState().others)),

	reset: () =>
		run(() => {
			board.reset();
			mirror.setState({ others: [], dirtyHint: false });
		}),

	discardChanges: () =>
		run(() => {
			board.discard(mirror.getState().others);
			mirror.setState({ dirtyHint: false });
		}),

	commitBaseline: () =>
		run(() => {
			board.document.getState().commitBaseline();
			mirror.setState({ dirtyHint: false });
		}),

	setCollectionPosition: (kind, position) =>
		board.document.getState().setCollectionPosition(kind, position),

	toggleConnections: () => board.view.getState().toggleConnections(),
	toggleKindVisibility: (kind) => board.view.getState().toggleKindVisibility(kind),

	repairOverlaps: () => board.document.getState().repairOverlaps(placedOthers()),
	arrange: (positions) => board.document.getState().arrange(positions),

	getCoreIdentity: () => coreIdentity(board.document.getState().designNodes),
	getEffectiveProvider: (id) => effectiveProvider(boardNodes(), id),
}));

board.document.subscribe(sync);
board.view.subscribe(sync);
mirror.subscribe(sync);

/** A node set handed to `setState`, as a history step that restores it. */
function entryOf(nodes: CanvasNode[]): HistoryEntry {
	const d = board.document.getState();
	const positions: Positions = { ...d.positions };
	for (const node of nodes) positions[node.id] = node.position;
	return {
		designNodes: nodes.filter(isDesignNode).map((n) => designPart(n)),
		positions,
		collectionPositions: d.collectionPositions,
		operations: d.operations,
		label: "restored",
		coalesceKey: null,
		at: 0,
	};
}

/**
 * The legacy `setState`: each key is written to the store that owns it. `edges` is derived and is
 * not written; `dirty` is derived too, and writing it sets or clears the legacy allowance only.
 */
function setLegacyState(
	partial: Partial<CanvasStore> | ((state: CanvasStore) => Partial<CanvasStore>),
): void {
	const patch = typeof partial === "function" ? partial(facade.getState()) : partial;
	run(() => {
		const { nodes, baseline, past, future } = patch;
		if (nodes !== undefined) {
			board.document.getState().replaceNodes(nodes);
			const nodeView: Record<string, NodeViewFlags> = {};
			for (const node of nodes) {
				const flags = flagsOf(node);
				if (Object.keys(flags).length > 0) nodeView[node.id] = flags;
			}
			board.view.getState().setNodeView(nodeView);
			mirror.setState({
				others: nodes.filter((n) => !isDesignNode(n)).map((n) => designPart(n, n.position)),
			});
		}
		if (baseline !== undefined) board.document.getState().replaceBaseline(baseline);
		if (past !== undefined || future !== undefined) {
			const history = board.document.getState().history;
			board.document.getState().replaceHistory({
				past: past === undefined ? history.past : past.map(entryOf),
				future: future === undefined ? history.future : future.map(entryOf),
			});
		}
		if ("seed" in patch) board.document.setState({ seed: patch.seed ?? null });
		if (patch.collectionPositions !== undefined) {
			board.document.setState({ collectionPositions: patch.collectionPositions });
		}
		if ("card" in patch) {
			const card = patch.card ?? null;
			board.view.setState({ card, subject: subjectOfCard(card), tab: tabOfCard(card) });
		}
		if ("cardBack" in patch) board.view.setState({ cardBack: patch.cardBack ?? null });
		if (patch.selectedIds !== undefined) board.view.getState().setSelection(patch.selectedIds);
		if (patch.showConnections !== undefined) {
			board.view.setState({ showConnections: patch.showConnections });
		}
		if (patch.hiddenKinds !== undefined) board.view.setState({ hiddenKinds: patch.hiddenKinds });
		if (patch.identities !== undefined) mirror.setState({ identities: patch.identities });
		if (patch.iacOutputs !== undefined) mirror.setState({ iacOutputs: patch.iacOutputs });
		if (patch.dirty !== undefined) mirror.setState({ dirtyHint: patch.dirty });
	});
}

/** The legacy store as a hook: `useCanvasStore((s) => s.nodes)`. */
function useCanvasStoreHook<T>(selector: (state: CanvasStore) => T): T {
	return useStore(facade, selector);
}

/**
 * The legacy canvas store. A hook with a selector, plus `getState`, `setState` and `subscribe` —
 * the shape it always had. New code reads `lib/canvas/store/use-board.ts` instead.
 */
export const useCanvasStore = Object.assign(useCanvasStoreHook, {
	getState: facade.getState,
	setState: setLegacyState,
	subscribe: facade.subscribe,
	persist: {
		/** Write the draft under another key from now on (the old `persist.setOptions`). */
		setOptions: (options: { name: string }) => board.setDraftKey(options.name),
	},
});

/**
 * Point the persisted draft at `scope`'s own sessionStorage slot and load it. Resolves true when a
 * draft seeded for exactly that scope was restored; false when the slot was empty or held another
 * scope's draft, in which case the store is reset and the caller seeds it from the server.
 *
 * The read is synchronous; the promise is the signature the callers of the old store await.
 */
export async function switchDraftScope(scope: string): Promise<boolean> {
	return run(() => {
		mirror.setState({ others: [], dirtyHint: false });
		return board.openDraftScope(scope);
	});
}
