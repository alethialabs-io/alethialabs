// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The draft a tab keeps across a reload (#6764): its format, its storage slot, and reading an
// older format.
//
// One sessionStorage slot per project:environment, under the key the version-1 draft used, so a
// tab that still holds a version-1 draft opens as the same board. Version 2 stores the design and
// the card positions SEPARATELY (a move rewrites no design), and stores nothing that can be
// derived: the edges, a "dirty" flag, and the retired container geometry are gone.
//
// A slot is read through a schema. A blob that does not parse — another format, a hand-edited or
// truncated value — is reported as unreadable and the caller seeds from the server, rather than a
// half-read draft being shown as the design.

import type { XYPosition } from "@xyflow/react";
import { z } from "zod";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type {
	CanvasNode,
	CanvasNodeData,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CollectionPositions } from "@/lib/canvas/collections";
import { isDesignNode } from "./derive";
import type { DraftSeed, Positions, StagedOperation } from "./types";

/** Prefix of every persisted-draft key; `draftStorageKey(scope)` appends the scope. */
export const DRAFT_STORAGE_PREFIX = "design-project-canvas-draft";

/** The format this module writes. */
export const DRAFT_VERSION = 2;

/** The sessionStorage key a draft scope persists under — one slot per project:environment. */
export function draftStorageKey(scope: string): string {
	return `${DRAFT_STORAGE_PREFIX}:${scope}`;
}

/** The part of the document that survives a reload. */
export interface DraftState {
	/** The design's nodes. Where each sits is in `positions`, never on the node. */
	designNodes: CanvasNode[];
	positions: Positions;
	collectionPositions: CollectionPositions;
	/** The last saved design, as it was laid out when it was loaded or saved. */
	baseline: CanvasNode[];
	seed: DraftSeed | null;
	operations: StagedOperation[];
	/** True once a person has arranged the board, so a moved server design keeps their layout. */
	arranged: boolean;
	/** The wizard hand-offs already applied to this draft, as their wire strings; applying one
	 * again is a no-op. */
	appliedSeedKeys: string[];
}

/** Where a design node sits while it is in the document: nowhere. `positions` holds the place. */
export const UNPLACED: XYPosition = { x: 0, y: 0 };

/** True for a string that names a node kind. */
export function isNodeKind(value: string): value is NodeKind {
	return Object.prototype.hasOwnProperty.call(NODE_REGISTRY, value);
}

/** True for a value shaped like a node's data: a known kind and an object config. */
function isNodeData(value: unknown): value is CanvasNodeData {
	if (typeof value !== "object" || value === null) return false;
	if (!("kind" in value) || !("config" in value)) return false;
	return (
		typeof value.kind === "string" &&
		isNodeKind(value.kind) &&
		typeof value.config === "object" &&
		value.config !== null
	);
}

const xy = z.object({ x: z.number(), y: z.number() });
const nodeData = z.custom<CanvasNodeData>(isNodeData);
const seed = z.object({ scope: z.string(), revision: z.string() });

/** A node as version 1 stored it and as the baseline still does: with its position. */
const placedNode = z.object({
	id: z.string(),
	type: z.string().optional(),
	deletable: z.boolean().optional(),
	position: xy,
	data: nodeData,
});

/** A design node as version 2 stores it: no position. */
const designNode = z.object({
	id: z.string(),
	type: z.string().optional(),
	deletable: z.boolean().optional(),
	data: nodeData,
});

const operation = z.object({
	id: z.string(),
	target: z.enum(["addon", "chart-workload"]),
	verb: z.enum(["install", "update", "remove", "overlay"]),
	targetId: z.string(),
	summary: z.string(),
	input: z.unknown(),
});

const draftV2 = z.object({
	designNodes: z.array(designNode),
	positions: z.record(z.string(), xy),
	collectionPositions: z.record(z.string(), xy),
	baseline: z.array(placedNode),
	seed: seed.nullable(),
	operations: z.array(operation),
	arranged: z.boolean(),
	appliedSeedKeys: z.array(z.string()),
});

/** The version-1 state. `edges` and `containerGeometry` are read past and dropped. */
const draftV1 = z.object({
	nodes: z.array(placedNode),
	baseline: z.array(placedNode),
	collectionPositions: z.record(z.string(), xy).optional(),
	seed: seed.nullable().optional(),
	dirty: z.boolean().optional(),
});

/** The envelope: the state and the format version it is in. */
const envelope = z.object({ state: z.unknown(), version: z.number() });

/** A stored node as a board node. Only keys that were stored are set, so a node reads back equal. */
function toCanvasNode(stored: z.infer<typeof placedNode>): CanvasNode {
	return {
		id: stored.id,
		...(stored.type === undefined ? {} : { type: stored.type }),
		...(stored.deletable === undefined ? {} : { deletable: stored.deletable }),
		position: stored.position,
		data: stored.data,
	};
}

/** Collection positions keyed by node kind; a key that names no kind is dropped. */
function toCollectionPositions(stored: Record<string, XYPosition>): CollectionPositions {
	const out: CollectionPositions = {};
	for (const [kind, position] of Object.entries(stored)) {
		if (isNodeKind(kind)) out[kind] = position;
	}
	return out;
}

/** A node with its position removed: how a design node is held in the document. */
export function unplaced(node: CanvasNode): CanvasNode {
	return node.position === UNPLACED ? node : { ...node, position: UNPLACED };
}

/**
 * A version-1 draft as a version-2 one: positions are lifted off the nodes, cards the design does
 * not own are dropped from the design and the baseline (their positions are kept), and the stored
 * `dirty` flag becomes "this board was arranged" — a version-1 draft was dirty after any move.
 */
export function migrateDraftV1(state: z.infer<typeof draftV1>): DraftState {
	const nodes = state.nodes.map(toCanvasNode);
	const positions: Positions = {};
	for (const node of nodes) positions[node.id] = node.position;
	return {
		designNodes: nodes.filter(isDesignNode).map(unplaced),
		positions,
		collectionPositions: toCollectionPositions(state.collectionPositions ?? {}),
		baseline: state.baseline.map(toCanvasNode).filter(isDesignNode),
		seed: state.seed ?? null,
		operations: [],
		arranged: state.dirty ?? false,
		appliedSeedKeys: [],
	};
}

/**
 * Read a stored draft, in either format. Null when the value is not a draft this module can read.
 */
export function parseDraft(raw: string): DraftState | null {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return null;
	}
	const outer = envelope.safeParse(json);
	if (!outer.success) return null;
	if (outer.data.version === 1) {
		const v1 = draftV1.safeParse(outer.data.state);
		return v1.success ? migrateDraftV1(v1.data) : null;
	}
	if (outer.data.version !== DRAFT_VERSION) return null;
	const v2 = draftV2.safeParse(outer.data.state);
	if (!v2.success) return null;
	return {
		designNodes: v2.data.designNodes.map((n) => toCanvasNode({ ...n, position: UNPLACED })),
		positions: v2.data.positions,
		collectionPositions: toCollectionPositions(v2.data.collectionPositions),
		baseline: v2.data.baseline.map(toCanvasNode),
		seed: v2.data.seed,
		operations: v2.data.operations.map((o) => ({ ...o, input: o.input })),
		arranged: v2.data.arranged,
		appliedSeedKeys: v2.data.appliedSeedKeys,
	};
}

/** A draft as the string a slot holds. */
export function serializeDraft(draft: DraftState): string {
	return JSON.stringify({
		state: {
			designNodes: draft.designNodes.map((n) => ({
				id: n.id,
				type: n.type,
				deletable: n.deletable,
				data: n.data,
			})),
			positions: draft.positions,
			collectionPositions: draft.collectionPositions,
			baseline: draft.baseline.map((n) => ({
				id: n.id,
				type: n.type,
				deletable: n.deletable,
				position: n.position,
				data: n.data,
			})),
			seed: draft.seed,
			operations: draft.operations,
			arranged: draft.arranged,
			appliedSeedKeys: draft.appliedSeedKeys,
		},
		version: DRAFT_VERSION,
	});
}

/** The draft stored under `key`, or null when the slot is empty, unreadable or unavailable. */
export function readDraft(key: string): DraftState | null {
	if (typeof sessionStorage === "undefined") return null;
	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem(key);
	} catch {
		raw = null;
	}
	return raw === null ? null : parseDraft(raw);
}

/** Store `draft` under `key`. A full or unavailable storage is not an error the board can act on. */
export function writeDraft(key: string, draft: DraftState): void {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(key, serializeDraft(draft));
	} catch {
		// Quota exceeded or storage disabled: the draft lives on in memory for this page load.
	}
}
