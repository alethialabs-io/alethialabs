// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The DOCUMENT half of the canvas store (#6764): the design a person is drafting, where its cards
// sit, the saved design it is diffed against, and the undo history of all three.
//
// What is NOT here is the point of the split:
//   - no server mirror. Identities, add-ons, charts and BYO-IaC cards are read from their queries
//     (`use-board-sources.ts`); a card the design does not own is never in this store, so undo,
//     discard and the draft cannot contain one;
//   - no view state. The inspector's subject, the selection and React Flow's per-node flags are in
//     `view-store.ts`;
//   - no derived value. Edges, pending changes and "is it dirty" are computed from what is here
//     (`derive.ts`), so they cannot disagree with it.
//
// A design node is held WITHOUT its position (`UNPLACED`); `positions` says where each card sits.
// A move therefore replaces `positions` and leaves `designNodes` untouched, so nothing keyed on the
// design — validation, the diff, the edges — recomputes while a card is dragged.

import type { XYPosition } from "@xyflow/react";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
	NODE_REGISTRY,
	SINGLETON_KINDS,
} from "@/components/design-project/canvas/graph/node-registry";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import { layoutZoned } from "@/lib/canvas/layout";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { ConversionWarning } from "@/lib/cloud-providers/convert";
import {
	diffNodes,
	draftRevision,
	effectiveProvider,
	isDesignNode,
} from "./derive";
import { UNPLACED, unplaced, type DraftState } from "./draft-persist";
import {
	checkpoint,
	EMPTY_HISTORY,
	stepBack,
	stepForward,
	type HistorySnapshot,
	type HistoryState,
} from "./history";
import {
	applyUniqueName,
	buildNodeData,
	convertInstanceTypesAcrossNodes,
	makeProjectNode,
	newId,
	normalizeAfterEdit,
	normalizeAfterLoad,
	spreadOverlaps,
	takenNames,
	uniqueName,
	withConfig,
	withPlacement,
} from "./normalize";
import {
	PROJECT_NODE_ID,
	type BoardSeed,
	type DraftSeed,
	type Positions,
	type ReviewedPlan,
	type StagedOperation,
} from "./types";

/** What `reseed` did with the server design it was handed. */
export type ReseedOutcome =
	/** Same scope and revision: nothing changed. */
	| "unchanged"
	/** Another scope: a full load. */
	| "loaded"
	/** The server design moved under a draft with pending changes: only the baseline moved. */
	| "baseline-moved"
	/** The server design moved under a clean draft: the design was replaced. */
	| "replaced";

/** A design handed to the store, and the cards beside it that the layout should make room for. */
export interface IncomingGraph {
	nodes: CanvasNode[];
}

/** Options for a load: cards the design does not own, which the zoned layout still places around. */
export interface LoadOptions {
	layoutWith?: CanvasNode[];
}

/** The document: the persisted draft plus what belongs to one editing session only. */
export interface DocumentState extends DraftState {
	history: HistoryState;
	/** True between the first and the last frame of a drag. The draft is not written meanwhile. */
	moving: boolean;
	/** A wizard hand-off waiting to be applied to this draft: its wire string and what it parsed to. */
	seedSlot: { wire: string; seed: BoardSeed } | null;
	/** The plan last reviewed for this draft, and the design it was computed for. */
	reviewedPlan: ReviewedPlan | null;
}

/** Everything that changes the document. */
export interface DocumentActions {
	/** Load a design as the saved state: laid out by zone, history cleared. */
	load: (graph: IncomingGraph, options?: LoadOptions) => void;
	/**
	 * Take a server design WITHOUT discarding what the user is doing:
	 *   - same scope and revision → nothing changes (the common re-render case);
	 *   - same scope, new revision, clean draft → the design and the baseline are replaced; a board
	 *     a person arranged keeps its arrangement for every card that is still there;
	 *   - same scope, new revision, pending changes → only the BASELINE moves, so the changes are
	 *     diffed against the new server truth instead of being lost;
	 *   - different scope → a full load.
	 */
	reseed: (graph: IncomingGraph, seed: DraftSeed, options?: LoadOptions) => ReseedOutcome;
	/** Record the revision the draft now matches (after a save wrote the design). */
	setSeedRevision: (revision: string) => void;
	/** Put a restored draft in place of the document. History does not travel with a draft. */
	hydrate: (draft: DraftState) => void;
	/** Back to an empty, unseeded document. */
	reset: () => void;

	/** Add a node of `kind`. A singleton that is already placed is returned, not duplicated. */
	addNode: (kind: NodeKind, position?: XYPosition) => { id: string; created: boolean };
	/** Add a node with an explicit config and placement. `ownProvider` is the cloud of
	 * `cloudIdentityId`, resolved by the caller from the identity list. */
	addNodeWithConfig: (
		kind: NodeKind,
		config: Record<string, unknown> | undefined,
		cloudIdentityId: string | null,
		position: XYPosition | undefined,
		ownProvider: CloudProviderSlug | null,
	) => { id: string; created: boolean };
	/** Merge `patch` into a node's config. One undo step; edits of the same fields within a second
	 * extend it. */
	updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
	/** Re-place a node on another cloud identity. Returns the notices the move produced. */
	setNodeIdentity: (
		id: string,
		cloudIdentityId: string | null,
		provider: CloudProviderSlug | null,
	) => ConversionWarning[];
	/** Remove nodes. The project root and any `deletable: false` node are kept. Returns the ids
	 * that were removed. */
	removeNodes: (ids: string[]) => string[];
	/** Duplicate the array-kind nodes among `ids`. Returns the new ids. */
	duplicateNodes: (ids: string[]) => string[];

	/** Take the checkpoint a move starts from. A drag takes one, at its first frame. */
	beginMove: () => void;
	/** Put cards at new positions. `moving` is true for every frame of a drag but the last. */
	moveNodes: (patch: Positions, options: { moving: boolean }) => void;
	setCollectionPosition: (kind: NodeKind, position: XYPosition) => void;
	/** Apply computed auto-layout positions and re-anchor the collection cards. */
	arrange: (positions: Positions) => void;
	/** Push apart overlapping cards. `others` are cards the design does not own, moved with them. */
	repairOverlaps: (others?: CanvasNode[]) => void;

	/** Take an undo checkpoint ahead of a change made through several calls. */
	checkpoint: (label: string, coalesceKey?: string) => void;
	/** Run `change` as ONE undo step, whatever it calls. */
	transact: (label: string, change: () => void) => void;
	/** Undo one step. False when there was nothing to undo. */
	undo: () => boolean;
	/** Redo one step. False when there was nothing to redo. */
	redo: () => boolean;
	/** Drop both history stacks. */
	clearHistory: () => void;

	/** Revert the draft to the saved design and drop every staged operation. */
	discard: () => void;
	/** Mark the draft as saved. `revision` is the server revision the save produced, when known, so
	 * the next render of that revision is not taken for a foreign change. */
	commitBaseline: (revision?: string) => void;

	/** Stage an out-of-band operation. Staging the same id again replaces the earlier one. */
	stageOperation: (operation: StagedOperation) => void;
	unstageOperation: (id: string) => void;

	/**
	 * Offer a wizard hand-off: `wire` is its URL form (`v1.template.standard.aws`) and `seed` is what
	 * the hand-off contract parsed it to. The wire string is the seed's identity and the only form
	 * that is kept in the draft, because the contract's version lives in the string. False when this
	 * draft already applied that wire string.
	 */
	offerSeed: (wire: string, seed: BoardSeed) => boolean;
	/** Apply the offered hand-off through `apply`, as one undo step, and empty the slot. False when
	 * the slot was empty. */
	consumeSeed: (apply: (seed: BoardSeed) => void) => boolean;

	/** Record that `planJobId` was computed for the design on the board right now. */
	recordReviewedPlan: (planJobId: string) => void;
	clearReviewedPlan: () => void;

	/** Replace the design nodes and the positions of every node given, with no undo step. For a
	 * caller that holds whole board nodes: React Flow's structural changes. */
	replaceNodes: (nodes: CanvasNode[]) => void;
	/** Replace the saved design, with no other change. */
	replaceBaseline: (baseline: CanvasNode[]) => void;
	/** Replace both history stacks. */
	replaceHistory: (history: HistoryState) => void;
}

export type DocumentStore = StoreApi<DocumentState & DocumentActions>;

/**
 * A board node reduced to what the design owns: its id, type, deletability and data, at `at`.
 * React Flow's per-node state (selected, measured, dragging) is view state and is left behind.
 */
export function designPart(node: CanvasNode, at: XYPosition = UNPLACED): CanvasNode {
	return {
		id: node.id,
		...(node.type === undefined ? {} : { type: node.type }),
		...(node.deletable === undefined ? {} : { deletable: node.deletable }),
		position: at,
		data: node.data,
	};
}

/** `nodes` with each one's position taken from `positions` (its own position when none is held). */
export function placeNodes(nodes: CanvasNode[], positions: Positions): CanvasNode[] {
	return nodes.map((n) => {
		const position = positions[n.id];
		return position ? { ...n, position } : n;
	});
}

/** How many changes are pending against the saved design: design edits plus staged operations. */
export function pendingCount(state: {
	baseline: CanvasNode[];
	designNodes: CanvasNode[];
	operations: StagedOperation[];
}): number {
	return diffNodes(state.baseline, state.designNodes).length + state.operations.length;
}

/** The incoming design with a project root, and nothing the design does not own. */
function designOf(graph: IncomingGraph): CanvasNode[] {
	const base = graph.nodes.some((n) => n.id === PROJECT_NODE_ID)
		? graph.nodes
		: [makeProjectNode(), ...graph.nodes];
	return base.filter(isDesignNode);
}

/**
 * Where each design node sits after a load. A freshly loaded graph arrives as a flat grid, so it is
 * laid out by ZONE to open looking like the system it describes; `keep` holds the places a person
 * already chose, which win. Positions are not part of the pending diff, so a layout can never
 * register as a change.
 */
function layoutDesign(
	design: CanvasNode[],
	others: CanvasNode[],
	keep: Positions | null,
): Positions {
	const all = [...design, ...others];
	const provider = (id: string) =>
		all.find((n) => n.id === id)?.data.provider ??
		all.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ??
		null;
	const layout = layoutZoned(all, provider);
	const positions: Positions = {};
	for (const node of design) {
		positions[node.id] = keep?.[node.id] ?? layout.get(node.id) ?? node.position;
	}
	return positions;
}

/** The state of a document nobody has seeded. */
function emptyDocument(): DocumentState {
	const root = makeProjectNode();
	return {
		designNodes: [unplaced(root)],
		positions: { [root.id]: root.position },
		collectionPositions: {},
		baseline: [root],
		seed: null,
		operations: [],
		arranged: false,
		appliedSeedKeys: [],
		history: EMPTY_HISTORY,
		moving: false,
		seedSlot: null,
		reviewedPlan: null,
	};
}

/** The snapshot fields of the document, for the history. */
function snapshot(state: DocumentState): HistorySnapshot {
	return {
		designNodes: state.designNodes,
		positions: state.positions,
		collectionPositions: state.collectionPositions,
		operations: state.operations,
	};
}

/** Create a document store. One per board; nothing in it is shared between instances. */
export function createDocumentStore(): DocumentStore {
	// Depth of the `transact` calls in progress. While it is non-zero, the checkpoints of the
	// actions a transaction calls are not taken: the transaction's own checkpoint covers them.
	let transactions = 0;

	return createStore<DocumentState & DocumentActions>()((set, get) => {
		/** Take a checkpoint of the document as it stands, unless a transaction already has. */
		const mark = (label: string, coalesceKey?: string) => {
			if (transactions > 0) return;
			set((s) => ({
				history: checkpoint(s.history, snapshot(s), label, {
					coalesceKey,
					now: Date.now(),
				}),
			}));
		};

		return {
			...emptyDocument(),

			load: (graph, options) => {
				const design = designOf(graph);
				const positions = layoutDesign(design, options?.layoutWith ?? [], null);
				// A project saved before its cloud's WAF offer was withdrawn (#1841) still carries
				// `waf_enabled: true`. The DESIRED design is normalized but the baseline is not, so the
				// coercion appears as a pending change the user can see and save — rather than either a
				// silent rewrite or a disabled switch they have no way to clear.
				set({
					designNodes: normalizeAfterLoad(design.map(unplaced)),
					positions,
					baseline: placeNodes(design, positions),
					operations: [],
					arranged: false,
					history: EMPTY_HISTORY,
					moving: false,
					reviewedPlan: null,
				});
			},

			reseed: (graph, seed, options) => {
				const cur = get();
				const sameScope = cur.seed?.scope === seed.scope;
				// The common case — a server re-render (revalidate, a sibling mutation, a status refetch)
				// handed us the design we were already seeded from. Nothing changed on the server, so
				// nothing changes here: the open card, the edits and the history all stay.
				if (sameScope && cur.seed?.revision === seed.revision) return "unchanged";
				if (!sameScope) {
					get().load(graph, options);
					set({ seed });
					return "loaded";
				}
				// Same scope, the server design moved. A board a person arranged keeps its arrangement;
				// one they never touched is laid out afresh, exactly as a clean reload would lay it out.
				const design = designOf(graph);
				const positions = layoutDesign(
					design,
					options?.layoutWith ?? [],
					cur.arranged ? cur.positions : null,
				);
				const baseline = placeNodes(design, positions);
				if (pendingCount(cur) > 0) {
					// The user has a draft in flight. The server truth is what the pending changes must be
					// diffed AGAINST, so only the baseline moves; the draft and the undo history stay. No
					// three-way merge — the diff is honest and the user decides.
					set({ baseline, seed });
					return "baseline-moved";
				}
				set({
					designNodes: normalizeAfterLoad(design.map(unplaced)),
					positions: { ...cur.positions, ...positions },
					baseline,
					history: EMPTY_HISTORY,
					seed,
				});
				return "replaced";
			},

			setSeedRevision: (revision) =>
				set((s) => ({ seed: s.seed ? { ...s.seed, revision } : null })),

			hydrate: (draft) =>
				set({
					...draft,
					history: EMPTY_HISTORY,
					moving: false,
					seedSlot: null,
					reviewedPlan: null,
				}),

			reset: () => set(emptyDocument()),

			addNode: (kind, position) => {
				const { designNodes } = get();
				if (SINGLETON_KINDS.includes(kind)) {
					const existing = designNodes.find((n) => n.data.kind === kind);
					if (existing) return { id: existing.id, created: false };
				}
				mark("add");
				const provider = effectiveProvider(designNodes, PROJECT_NODE_ID) ?? "aws";
				const count = designNodes.length;
				// Array kinds are UNIQUE on (project, name) — suffix to avoid clashes.
				const config = applyUniqueName(
					kind,
					NODE_REGISTRY[kind].defaultData(provider),
					designNodes,
				);
				const node: CanvasNode = {
					id: newId(kind),
					type: kind,
					position: UNPLACED,
					data: buildNodeData(kind, config, null, null),
				};
				set((s) => ({
					designNodes: [...s.designNodes, node],
					positions: {
						...s.positions,
						[node.id]: position ?? { x: 120 + count * 48, y: 180 + count * 36 },
					},
				}));
				return { id: node.id, created: true };
			},

			addNodeWithConfig: (kind, config, cloudIdentityId, position, ownProvider) => {
				const { designNodes } = get();
				if (SINGLETON_KINDS.includes(kind)) {
					const existing = designNodes.find((n) => n.data.kind === kind);
					if (existing) return { id: existing.id, created: false };
				}
				mark("add");
				const provider =
					ownProvider ?? effectiveProvider(designNodes, PROJECT_NODE_ID) ?? "aws";
				const merged: Record<string, unknown> = {
					...NODE_REGISTRY[kind].defaultData(provider),
					...config,
				};
				if (typeof merged.name === "string") {
					merged.name = uniqueName(merged.name, takenNames(designNodes, kind));
				}
				const count = designNodes.length;
				const node: CanvasNode = {
					id: newId(kind),
					type: kind,
					position: UNPLACED,
					data: buildNodeData(kind, merged, cloudIdentityId, ownProvider),
				};
				set((s) => ({
					designNodes: [...s.designNodes, node],
					positions: {
						...s.positions,
						// Click-to-place: drop at the given position (viewport centre) or the cascade fallback.
						[node.id]: position ?? { x: 120 + count * 48, y: 180 + count * 36 },
					},
				}));
				return { id: node.id, created: true };
			},

			updateNodeConfig: (id, patch) => {
				if (!get().designNodes.some((n) => n.id === id)) return;
				mark("edit", `edit:${id}:${Object.keys(patch).sort().join(",")}`);
				set((s) => ({
					designNodes: normalizeAfterEdit(
						s.designNodes.map((n) =>
							n.id === id ? { ...n, data: withConfig(n.data, patch) } : n,
						),
					),
				}));
			},

			setNodeIdentity: (id, cloudIdentityId, provider) => {
				mark("placement");
				const prev = get().designNodes;
				const placed = convertInstanceTypesAcrossNodes(
					prev,
					prev.map((n) =>
						n.id === id
							? { ...n, data: withPlacement(n.data, cloudIdentityId, provider) }
							: n,
					),
				);
				set({ designNodes: normalizeAfterEdit(placed.nodes) });
				return placed.warnings;
			},

			removeNodes: (ids) => {
				const { designNodes } = get();
				// The project root and every `deletable: false` node are kept.
				const removable = ids.filter((id) => {
					if (id === PROJECT_NODE_ID) return false;
					const node = designNodes.find((n) => n.id === id);
					return !!node && node.deletable !== false;
				});
				if (removable.length === 0) return [];
				mark("remove");
				set((s) => ({
					designNodes: s.designNodes.filter((n) => !removable.includes(n.id)),
				}));
				return removable;
			},

			duplicateNodes: (ids) => {
				const { designNodes, positions } = get();
				const dupable = designNodes.filter(
					(n) =>
						ids.includes(n.id) &&
						NODE_REGISTRY[n.data.kind].cardinality === "array",
				);
				if (dupable.length === 0) return [];
				mark("duplicate");
				const taken = takenNames(designNodes);
				const placed: Positions = {};
				const clones = dupable.map((n) => {
					const base = `${configName(n.data) || n.data.kind}-copy`;
					const name = uniqueName(base, taken);
					taken.add(name);
					const id = newId(n.data.kind);
					const from = positions[n.id] ?? n.position;
					placed[id] = { x: from.x + 48, y: from.y + 48 };
					return {
						...structuredClone(n),
						id,
						position: UNPLACED,
						data: withConfig(n.data, { name }),
					} satisfies CanvasNode;
				});
				set((s) => ({
					designNodes: [...s.designNodes, ...clones],
					positions: { ...s.positions, ...placed },
				}));
				return clones.map((n) => n.id);
			},

			beginMove: () => {
				if (!get().moving) mark("move");
			},

			moveNodes: (patch, options) =>
				set((s) => ({
					positions:
						Object.keys(patch).length > 0 ? { ...s.positions, ...patch } : s.positions,
					moving: options.moving,
					arranged: true,
				})),

			setCollectionPosition: (kind, position) => {
				mark("move", `collection:${kind}`);
				set((s) => ({
					collectionPositions: { ...s.collectionPositions, [kind]: position },
					arranged: true,
				}));
			},

			arrange: (positions) => {
				mark("arrange");
				set((s) => ({
					positions: { ...s.positions, ...positions },
					// A tidy re-anchors the collapsed vault cards on their freshly-laid-out members.
					collectionPositions: {},
					arranged: true,
				}));
			},

			repairOverlaps: (others = []) => {
				mark("repair");
				const s = get();
				const spread = spreadOverlaps([
					...placeNodes(s.designNodes, s.positions),
					...others,
				]);
				const positions: Positions = { ...s.positions };
				for (const node of spread) positions[node.id] = node.position;
				set({ positions, arranged: true });
			},

			checkpoint: (label, coalesceKey) => mark(label, coalesceKey),

			transact: (label, change) => {
				mark(label);
				transactions++;
				try {
					change();
				} finally {
					transactions--;
				}
			},

			undo: () => {
				const s = get();
				const step = stepBack(s.history, snapshot(s));
				if (!step) return false;
				set({ ...step.restore, history: step.history, moving: false });
				return true;
			},

			redo: () => {
				const s = get();
				const step = stepForward(s.history, snapshot(s));
				if (!step) return false;
				set({ ...step.restore, history: step.history, moving: false });
				return true;
			},

			clearHistory: () => set({ history: EMPTY_HISTORY }),

			discard: () =>
				set((s) => {
					const positions: Positions = { ...s.positions };
					for (const node of s.baseline) positions[node.id] = node.position;
					return {
						designNodes: s.baseline.map(unplaced),
						positions,
						operations: [],
						history: EMPTY_HISTORY,
						moving: false,
					};
				}),

			commitBaseline: (revision) =>
				set((s) => ({
					baseline: placeNodes(s.designNodes, s.positions),
					operations: [],
					seed: revision && s.seed ? { ...s.seed, revision } : s.seed,
				})),

			stageOperation: (operation) => {
				mark("operation");
				set((s) => ({
					operations: [...s.operations.filter((o) => o.id !== operation.id), operation],
				}));
			},

			unstageOperation: (id) => {
				if (!get().operations.some((o) => o.id === id)) return;
				mark("operation");
				set((s) => ({ operations: s.operations.filter((o) => o.id !== id) }));
			},

			offerSeed: (wire, seed) => {
				if (get().appliedSeedKeys.includes(wire)) return false;
				set({ seedSlot: { wire, seed } });
				return true;
			},

			consumeSeed: (apply) => {
				const slot = get().seedSlot;
				if (!slot) return false;
				// Emptied BEFORE it is applied: an apply that throws must not leave a hand-off that is
				// applied again on the next render.
				set((s) => ({
					seedSlot: null,
					appliedSeedKeys: [...s.appliedSeedKeys, slot.wire],
				}));
				get().transact("seed", () => apply(slot.seed));
				return true;
			},

			recordReviewedPlan: (planJobId) =>
				set((s) => ({
					reviewedPlan: { planJobId, designRevision: draftRevision(s.designNodes) },
				})),

			clearReviewedPlan: () => set({ reviewedPlan: null }),

			replaceNodes: (nodes) =>
				set((s) => {
					const positions: Positions = { ...s.positions };
					for (const node of nodes) positions[node.id] = node.position;
					return {
						designNodes: nodes.filter(isDesignNode).map((n) => designPart(n)),
						positions,
					};
				}),

			replaceBaseline: (baseline) =>
				set({
					baseline: baseline.filter(isDesignNode).map((n) => designPart(n, n.position)),
				}),

			replaceHistory: (history) => set({ history }),
		};
	});
}

/** The persisted part of a document, for the draft slot. */
export function draftOf(state: DocumentState): DraftState {
	return {
		designNodes: state.designNodes,
		positions: state.positions,
		collectionPositions: state.collectionPositions,
		baseline: state.baseline,
		seed: state.seed,
		operations: state.operations,
		arranged: state.arranged,
		appliedSeedKeys: state.appliedSeedKeys,
	};
}
