// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import {
	NODE_REGISTRY,
	SINGLETON_KINDS,
} from "@/components/design-spec/canvas/graph/node-registry";
import type {
	CanvasEdge,
	CanvasNode,
	CanvasNodeData,
	NodeKind,
} from "@/components/design-spec/canvas/graph/types";

const PROJECT_NODE_ID = "project-root";
const HISTORY_CAP = 50;

/** A browser-only stable id for new nodes (canvas is client-side). */
function newId(kind: NodeKind): string {
	return `${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

/** The project root node's chosen identity = the stack's CORE; null until picked. */
function coreIdentity(nodes: CanvasNode[]): string | null {
	return nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.cloud_identity_id ?? null;
}

/** A node's effective cloud identity (its own, else the project CORE). */
function effectiveIdentity(node: CanvasNode, core: string | null): string | null {
	return node.data.cloud_identity_id ?? core;
}

/**
 * Canonical dependency edges, derived from the nodes (not user-drawn): network→
 * cluster and cluster→{every leaf}. A CORE↔CORE edge whose endpoints resolve to
 * different cloud identities is a hot cross-cloud edge → typed "gated".
 */
function deriveEdges(nodes: CanvasNode[]): CanvasEdge[] {
	const core = coreIdentity(nodes);
	const byKind = (kind: NodeKind) => nodes.filter((n) => n.data.kind === kind);
	const cluster = byKind("cluster")[0];
	const network = byKind("network")[0];
	const edges: CanvasEdge[] = [];

	const link = (source: CanvasNode, target: CanvasNode) => {
		const sourceCore = NODE_REGISTRY[source.data.kind].classification === "core";
		const targetCore = NODE_REGISTRY[target.data.kind].classification === "core";
		const gated =
			sourceCore &&
			targetCore &&
			effectiveIdentity(source, core) !== effectiveIdentity(target, core);
		edges.push({
			id: `${source.id}->${target.id}`,
			source: source.id,
			target: target.id,
			type: gated ? "gated" : "dependency",
		});
	};

	if (network && cluster) link(network, cluster);
	if (cluster) {
		const leafKinds: NodeKind[] = [
			"database",
			"cache",
			"queue",
			"topic",
			"nosql",
			"dns",
			"secret",
			"repositories",
		];
		for (const kind of leafKinds) {
			for (const leaf of byKind(kind)) link(cluster, leaf);
		}
	}
	return edges;
}

/** A name unique among existing names of the same kind. */
function uniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	let i = 2;
	while (taken.has(`${base}-${i}`)) i++;
	return `${base}-${i}`;
}

interface CanvasStore {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	selectedIds: string[];
	inspectorNodeId: string | null;
	dirty: boolean;
	/** Undo/redo snapshot stacks (node sets; edges re-derived on restore). */
	past: CanvasNode[][];
	future: CanvasNode[][];
	/** Verified cloud identities (server data) — seeded for label/provider lookup. */
	identities: CloudIdentityOption[];
	setIdentities: (identities: CloudIdentityOption[]) => void;
	getEffectiveIdentity: (id: string) => CloudIdentityOption | null;

	onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
	setGraph: (graph: { nodes: CanvasNode[] }) => void;
	addNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
	/** Add a node with an explicit config + placement (used by Ask AI proposals). */
	addNodeWithConfig: (
		kind: NodeKind,
		config?: Record<string, unknown>,
		cloudIdentityId?: string | null,
	) => void;
	updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
	setNodeIdentity: (
		id: string,
		cloudIdentityId: string | null,
		provider: CloudProviderSlug | null,
	) => void;
	removeNodes: (ids: string[]) => void;
	duplicateNodes: (ids: string[]) => void;
	openInspector: (id: string | null) => void;
	commit: () => void;
	undo: () => void;
	redo: () => void;
	reset: () => void;

	getNode: (id: string) => CanvasNode | undefined;
	getCoreIdentity: () => string | null;
	getEffectiveProvider: (id: string) => CloudProviderSlug | null;
}

function makeProjectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		deletable: false,
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: null,
		},
	};
}

export const useCanvasStore = create<CanvasStore>()(
	persist(
		(set, get) => ({
			nodes: [makeProjectNode()],
			edges: [],
			selectedIds: [],
			inspectorNodeId: null,
			dirty: false,
			past: [],
			future: [],
			identities: [],

			setIdentities: (identities) => set({ identities }),

			onNodesChange: (changes) => {
				const nodes = applyNodeChanges(changes, get().nodes);
				const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
				// Edges are derived; only recompute on add/remove, not every drag frame.
				const structural = changes.some(
					(c) => c.type === "remove" || c.type === "add",
				);
				const dirty =
					get().dirty ||
					changes.some(
						(c) => c.type === "remove" || c.type === "add" || c.type === "position",
					);
				set({
					nodes,
					selectedIds,
					dirty,
					...(structural ? { edges: deriveEdges(nodes) } : {}),
				});
			},

			setGraph: ({ nodes }) => {
				const withRoot = nodes.some((n) => n.id === PROJECT_NODE_ID)
					? nodes
					: [makeProjectNode(), ...nodes];
				set({
					nodes: withRoot,
					edges: deriveEdges(withRoot),
					selectedIds: [],
					inspectorNodeId: null,
					dirty: false,
					past: [],
					future: [],
				});
			},

			commit: () =>
				set((s) => ({
					past: [...s.past, structuredClone(s.nodes)].slice(-HISTORY_CAP),
					future: [],
				})),

			addNode: (kind, position) => {
				const { nodes } = get();
				if (SINGLETON_KINDS.includes(kind)) {
					const existing = nodes.find((n) => n.data.kind === kind);
					if (existing) {
						set({ inspectorNodeId: existing.id, selectedIds: [existing.id] });
						return;
					}
				}
				get().commit();
				const provider = get().getEffectiveProvider(PROJECT_NODE_ID) ?? "aws";
				const count = nodes.length;
				const config = NODE_REGISTRY[kind].defaultData(provider);
				// Array kinds are UNIQUE on (spec, name) — suffix to avoid clashes.
				if (typeof config.name === "string") {
					const taken = new Set(
						nodes
							.filter((n) => n.data.kind === kind)
							.map((n) => n.data.config.name as string),
					);
					config.name = uniqueName(config.name, taken);
				}
				const node: CanvasNode = {
					id: newId(kind),
					type: kind,
					position: position ?? { x: 120 + count * 48, y: 180 + count * 36 },
					data: { kind, config, cloud_identity_id: null, provider: null },
				};
				const next = [...nodes, node];
				set({
					nodes: next,
					edges: deriveEdges(next),
					inspectorNodeId: node.id,
					selectedIds: [node.id],
					dirty: true,
				});
			},

			addNodeWithConfig: (kind, config, cloudIdentityId) => {
				const { nodes, identities } = get();
				if (SINGLETON_KINDS.includes(kind)) {
					const existing = nodes.find((n) => n.data.kind === kind);
					if (existing) {
						set({ inspectorNodeId: existing.id, selectedIds: [existing.id] });
						return;
					}
				}
				get().commit();
				const ownProvider = cloudIdentityId
					? ((identities.find((i) => i.id === cloudIdentityId)
							?.provider as CloudProviderSlug) ?? null)
					: null;
				const provider =
					ownProvider ?? get().getEffectiveProvider(PROJECT_NODE_ID) ?? "aws";
				const merged = { ...NODE_REGISTRY[kind].defaultData(provider), ...config };
				if (typeof merged.name === "string") {
					const taken = new Set(
						nodes
							.filter((n) => n.data.kind === kind)
							.map((n) => n.data.config.name as string),
					);
					merged.name = uniqueName(merged.name, taken);
				}
				const count = nodes.length;
				const node: CanvasNode = {
					id: newId(kind),
					type: kind,
					position: { x: 120 + count * 48, y: 180 + count * 36 },
					data: {
						kind,
						config: merged,
						cloud_identity_id: cloudIdentityId ?? null,
						provider: ownProvider,
					},
				};
				const next = [...nodes, node];
				set({
					nodes: next,
					edges: deriveEdges(next),
					inspectorNodeId: node.id,
					selectedIds: [node.id],
					dirty: true,
				});
			},

			updateNodeConfig: (id, patch) => {
				const next = get().nodes.map((n) =>
					n.id === id
						? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } }
						: n,
				);
				set({ nodes: next, edges: deriveEdges(next), dirty: true });
			},

			setNodeIdentity: (id, cloudIdentityId, provider) => {
				get().commit();
				const next = get().nodes.map((n) =>
					n.id === id
						? {
								...n,
								data: {
									...n.data,
									cloud_identity_id: cloudIdentityId,
									provider,
								} satisfies CanvasNodeData,
							}
						: n,
				);
				set({ nodes: next, edges: deriveEdges(next), dirty: true });
			},

			removeNodes: (ids) => {
				const removable = ids.filter((id) => id !== PROJECT_NODE_ID);
				if (removable.length === 0) return;
				get().commit();
				const next = get().nodes.filter((n) => !removable.includes(n.id));
				const inspectorNodeId = get().inspectorNodeId;
				set({
					nodes: next,
					edges: deriveEdges(next),
					selectedIds: [],
					inspectorNodeId:
						inspectorNodeId && removable.includes(inspectorNodeId)
							? null
							: inspectorNodeId,
					dirty: true,
				});
			},

			duplicateNodes: (ids) => {
				const dupable = get().nodes.filter(
					(n) =>
						ids.includes(n.id) &&
						NODE_REGISTRY[n.data.kind].cardinality === "array",
				);
				if (dupable.length === 0) return;
				get().commit();
				const taken = new Set(
					get().nodes
						.map((n) => n.data.config.name)
						.filter((v): v is string => typeof v === "string"),
				);
				const clones = dupable.map((n) => {
					const base = `${(n.data.config.name as string) || n.data.kind}-copy`;
					const name = uniqueName(base, taken);
					taken.add(name);
					return {
						...structuredClone(n),
						id: newId(n.data.kind),
						position: { x: n.position.x + 48, y: n.position.y + 48 },
						selected: false,
						data: { ...n.data, config: { ...n.data.config, name } },
					} satisfies CanvasNode;
				});
				const next = [...get().nodes, ...clones];
				set({ nodes: next, edges: deriveEdges(next), dirty: true });
			},

			openInspector: (id) => set({ inspectorNodeId: id }),

			undo: () => {
				const { past, nodes, future } = get();
				if (past.length === 0) return;
				const prev = past[past.length - 1];
				set({
					nodes: prev,
					edges: deriveEdges(prev),
					past: past.slice(0, -1),
					future: [structuredClone(nodes), ...future].slice(0, HISTORY_CAP),
					selectedIds: [],
					inspectorNodeId: null,
					dirty: true,
				});
			},

			redo: () => {
				const { future, nodes, past } = get();
				if (future.length === 0) return;
				const nextNodes = future[0];
				set({
					nodes: nextNodes,
					edges: deriveEdges(nextNodes),
					future: future.slice(1),
					past: [...past, structuredClone(nodes)].slice(-HISTORY_CAP),
					selectedIds: [],
					inspectorNodeId: null,
					dirty: true,
				});
			},

			reset: () =>
				set({
					nodes: [makeProjectNode()],
					edges: [],
					selectedIds: [],
					inspectorNodeId: null,
					dirty: false,
					past: [],
					future: [],
				}),

			getNode: (id) => get().nodes.find((n) => n.id === id),
			getCoreIdentity: () => coreIdentity(get().nodes),
			getEffectiveIdentity: (id) => {
				const { nodes, identities } = get();
				const node = nodes.find((n) => n.id === id);
				if (!node) return null;
				const effId = node.data.cloud_identity_id ?? coreIdentity(nodes);
				return identities.find((i) => i.id === effId) ?? null;
			},
			getEffectiveProvider: (id) => {
				const node = get().nodes.find((n) => n.id === id);
				if (!node) return null;
				if (node.data.provider) return node.data.provider;
				const project = get().nodes.find((n) => n.id === PROJECT_NODE_ID);
				return project?.data.provider ?? null;
			},
		}),
		{
			name: "design-spec-canvas-draft",
			storage: createJSONStorage(() => sessionStorage),
			version: 1,
			// Persist only the graph; identities are server data, history is ephemeral.
			partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
		},
	),
);

export { PROJECT_NODE_ID };
