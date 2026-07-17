// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { ByoChartState, ChartWorkloadState } from "@/app/server/actions/byo-charts";
import type { IacGroup } from "@/lib/canvas/iac-inventory";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import {
	NODE_REGISTRY,
	SINGLETON_KINDS,
} from "@/components/design-project/canvas/graph/node-registry";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type {
	CanvasEdge,
	CanvasNode,
	CanvasNodeData,
	NodeConfigMap,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CollectionPositions } from "@/lib/canvas/collections";
import type { ContainerBox, ContainerGeometry } from "@/lib/canvas/zones";
import { applyLayout, layoutZoned } from "@/lib/canvas/layout";

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
export function deriveEdges(nodes: CanvasNode[]): CanvasEdge[] {
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
			"service",
			"database",
			"cache",
			"queue",
			"topic",
			"nosql",
			"dns",
			"secret",
			"bucket",
			"registry",
			"repositories",
		];
		for (const kind of leafKinds) {
			for (const leaf of byKind(kind)) link(cluster, leaf);
		}
	}

	// W3: a service's declared bindings become service→resource edges — derived from the model like
	// every other edge (the binding lives on the service's config). A binding whose target isn't
	// placed draws nothing; the service node's readiness surfaces that dangling binding instead.
	for (const svc of nodes) {
		if (svc.data.kind !== "service") continue;
		for (const b of svc.data.config.bindings ?? []) {
			const target = nodes.find(
				(n) => n.data.kind === b.target.kind && configName(n.data) === b.target.name,
			);
			if (!target) continue;
			edges.push({
				// One edge per (service, resource) relationship — collapses multiple injects to one wire.
				id: `bind:${svc.id}->${target.id}`,
				source: svc.id,
				target: target.id,
				type: "binding",
			});
		}
	}

	// W5 Path A — described chart workloads. Each is drawn as a child of its parent `chart-` node
	// (a solid parent edge), and each of its W3 bindings draws a dotted "consumes" edge to the
	// backing resource it binds to — resolved by (kind, name) exactly like the service binding rule.
	// A binding whose target isn't placed on the canvas simply draws nothing (never a dangling edge).
	for (const wl of byKind("chart_workload")) {
		if (wl.data.kind !== "chart_workload") continue;
		const config = wl.data.config;
		const parent = nodes.find((n) => n.id === `chart-${config.chartId}`);
		if (parent) {
			edges.push({
				id: `${parent.id}->${wl.id}`,
				source: parent.id,
				target: wl.id,
				type: "dependency",
			});
		}
		for (const b of config.bindings ?? []) {
			const target = nodes.find(
				(n) => n.data.kind === b.target.kind && configName(n.data) === b.target.name,
			);
			if (!target) continue;
			edges.push({
				id: `cwbind:${wl.id}->${target.id}`,
				source: wl.id,
				target: target.id,
				type: "cw_binding",
			});
		}
	}
	return edges;
}

/** Approximate node footprint used by overlap repair + relayout (px). */
const NODE_W = 240;
const NODE_H = 130;

/**
 * Deterministic tidy layout by kind — mirrors formToGraph's grid so "Reset canvas"
 * returns a readable arrangement without destroying any nodes/config. Project sits up
 * top; singletons in an infrastructure row; array kinds stack in rows below.
 */
function layoutByKind(nodes: CanvasNode[]): CanvasNode[] {
	const singletonRow: NodeKind[] = ["network", "cluster", "dns", "repositories"];
	const arrayRows: NodeKind[] = [
		"database",
		"cache",
		"queue",
		"topic",
		"nosql",
		"secret",
		"bucket",
		"registry",
	];
	const counts = new Map<NodeKind, number>();
	return nodes.map((n) => {
		const kind = n.data.kind;
		if (kind === "project") return { ...n, position: { x: 260, y: 0 } };
		const si = singletonRow.indexOf(kind);
		if (si !== -1) return { ...n, position: { x: 60 + si * 220, y: 180 } };
		const ri = arrayRows.indexOf(kind);
		if (ri !== -1) {
			const i = counts.get(kind) ?? 0;
			counts.set(kind, i + 1);
			return { ...n, position: { x: 120 + i * 220, y: 340 + ri * 130 } };
		}
		// Unknown kinds (e.g. future storage) flow into a trailing grid.
		const i = counts.get(kind) ?? 0;
		counts.set(kind, i + 1);
		return { ...n, position: { x: 120 + i * 220, y: 340 + arrayRows.length * 130 } };
	});
}

/** Push apart any nodes whose footprints overlap (keeps the project root anchored). */
function spreadOverlaps(nodes: CanvasNode[]): CanvasNode[] {
	const placed: CanvasNode[] = [];
	const overlaps = (a: CanvasNode, b: CanvasNode) =>
		Math.abs(a.position.x - b.position.x) < NODE_W &&
		Math.abs(a.position.y - b.position.y) < NODE_H;
	for (const node of nodes) {
		if (node.id === PROJECT_NODE_ID) {
			placed.push(node);
			continue;
		}
		let pos = { ...node.position };
		let guard = 0;
		while (placed.some((p) => overlaps({ ...node, position: pos }, p)) && guard < 200) {
			pos = { x: pos.x, y: pos.y + NODE_H + 20 };
			guard++;
		}
		placed.push({ ...node, position: pos });
	}
	return placed;
}

/**
 * Kinds persisted OUT-OF-BAND rather than through the form graph: BYO Helm charts and marketplace
 * add-ons (`project_addons`), and the external cards of a bring-your-own IaC module
 * (`project_iac_sources` + the last plan). They're loaded straight from the server, never written by
 * `graphToForm`, and must never appear in the Deploy diff — they aren't staged changes. Deploying a
 * card the design does not own would be the Deploy button lying.
 */
export const OUT_OF_BAND = new Set<NodeKind>([
	"chart",
	"chart_workload",
	"addon",
	"external",
]);

/** A staged difference between the canvas (desired) and the saved baseline. */
export interface PendingChange {
	id: string;
	op: "new" | "modified" | "removed";
	kind: NodeKind;
	name: string;
}

/** Human label for a node from its config (resource name, else project name, else kind). */
function nodeName(n: CanvasNode): string {
	return configName(n.data) || n.data.kind;
}

// ── discriminant/config reunion helpers ─────────────────────────────────────
// TypeScript can't correlate a node's runtime `kind` with its `config` type through
// an object spread (the classic discriminated-union limitation), so the few spots that
// rebuild a node's data from an edited config/placement assert the reunion here, once.

/** Assemble a node's data payload from a kind + config (+ placement). */
function buildNodeData<K extends NodeKind>(
	kind: K,
	config: NodeConfigMap[K],
	cloudIdentityId: string | null,
	provider: CloudProviderSlug | null,
): CanvasNodeData<K> {
	return {
		kind,
		config,
		cloud_identity_id: cloudIdentityId,
		provider,
	};
}

/** Merge a (partial) config patch into a node's data, keeping its kind. */
function withConfig<T extends CanvasNodeData>(
	data: T,
	patch: Partial<T["config"]>,
): T {
	return { ...data, config: { ...data.config, ...patch } };
}

/** Update a node's placement (identity + derived provider), keeping its kind + config. */
function withPlacement(
	data: CanvasNodeData,
	cloudIdentityId: string | null,
	provider: CloudProviderSlug | null,
): CanvasNodeData {
	return { ...data, cloud_identity_id: cloudIdentityId, provider };
}

/** For array kinds, suffix the config's `name` so it's unique among same-kind nodes. */
function applyUniqueName<K extends NodeKind>(
	kind: K,
	config: NodeConfigMap[K],
	nodes: CanvasNode[],
): NodeConfigMap[K] {
	const current = configName({
		kind,
		config,
		cloud_identity_id: null,
		provider: null,
	} as CanvasNodeData);
	if (NODE_REGISTRY[kind].cardinality !== "array" || !current) return config;
	const taken = new Set(
		nodes
			.filter((n) => n.data.kind === kind)
			.map((n) => configName(n.data))
			.filter((v): v is string => typeof v === "string"),
	);
	return { ...config, name: uniqueName(current, taken) };
}

/**
 * Diff the desired canvas against the saved baseline → the staged-change list shown in
 * the Pending Changes bar. The project root is excluded (it isn't a provisionable add).
 */
export function diffNodes(baseline: CanvasNode[], nodes: CanvasNode[]): PendingChange[] {
	const base = new Map(baseline.map((n) => [n.id, n]));
	const cur = new Map(nodes.map((n) => [n.id, n]));
	const changes: PendingChange[] = [];
	for (const n of nodes) {
		// The project root isn't a provisionable add; chart nodes are persisted out-of-band
		// (project_addons) so they never belong in the Deploy diff.
		if (n.id === PROJECT_NODE_ID || OUT_OF_BAND.has(n.data.kind)) continue;
		const prev = base.get(n.id);
		if (!prev) {
			changes.push({ id: n.id, op: "new", kind: n.data.kind, name: nodeName(n) });
		} else if (
			JSON.stringify(prev.data.config) !== JSON.stringify(n.data.config) ||
			prev.data.cloud_identity_id !== n.data.cloud_identity_id
		) {
			changes.push({ id: n.id, op: "modified", kind: n.data.kind, name: nodeName(n) });
		}
	}
	for (const n of baseline) {
		if (n.id === PROJECT_NODE_ID || OUT_OF_BAND.has(n.data.kind)) continue;
		if (!cur.has(n.id)) {
			changes.push({ id: n.id, op: "removed", kind: n.data.kind, name: nodeName(n) });
		}
	}
	return changes;
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
	/** Last-saved/loaded snapshot the Pending Changes bar diffs against. */
	baseline: CanvasNode[];
	/** Revert the canvas to the baseline (discard all staged changes). */
	discardChanges: () => void;
	/** Mark the current canvas as the new saved baseline (after a successful deploy). */
	commitBaseline: () => void;
	/** Verified cloud identities (server data) — seeded for label/provider lookup. */
	identities: CloudIdentityOption[];
	setIdentities: (identities: CloudIdentityOption[]) => void;
	getEffectiveIdentity: (id: string) => CloudIdentityOption | null;

	onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
	setGraph: (graph: { nodes: CanvasNode[] }) => void;
	/** Replace all BYO chart nodes from getProjectByoCharts (out-of-band; not a staged change). */
	setChartNodes: (charts: ByoChartState[]) => void;
	/** Replace all described chart-workload nodes from getProjectChartWorkloads (W5 Path A;
	 * out-of-band; read-mostly; not a staged change). Each renders as a child of its `chart-` node. */
	setChartWorkloadNodes: (workloads: ChartWorkloadState[]) => void;
	/** Replace the external cards of a BYO IaC module (out-of-band; read-only; not a staged
	 * change). Built by `buildIacInventory` from the module's scan + last plan. */
	setIacNodes: (groups: IacGroup[]) => void;
	/** Replace all marketplace add-on nodes (out-of-band; not a staged change). */
	setAddonNodes: (
		addons: {
			id: string;
			name: string;
			version: string;
			namespace: string;
			status?: string;
			health?: string | null;
			sync?: string | null;
		}[],
	) => void;
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

	/** Where each collection card (the Secrets vault) sits. A collection has no store row of its own,
	 * and its members' positions are never drawn, so the collapsed card needs a position here. */
	collectionPositions: CollectionPositions;
	setCollectionPosition: (kind: NodeKind, position: { x: number; y: number }) => void;

	/** User-overridden geometry (position + size) per CONTAINER (VPC / cluster / BYO module). Containers
	 * are synthetic — no store row — so their user-set box lives here, session-only, exactly like
	 * `collectionPositions`. Absent = derive the box from members. NEVER in the DB or the Deploy diff. */
	containerGeometry: ContainerGeometry;
	/** Pin a container's box (a drag or resize). */
	setContainerGeometry: (id: string, box: ContainerBox) => void;
	/** Drop a container's override so it auto-fits its members again (the "re-fit" affordance). */
	resetContainerGeometry: (id: string) => void;
	/** Drag a container: shift its members' absolute positions by `delta`, and shift each pinned box in
	 * `pins` (the dragged container itself + any pinned nested child) by the same delta so it tracks. */
	translateContainer: (
		delta: { x: number; y: number },
		opts: { memberIds: string[]; pins: { id: string; box: ContainerBox }[] },
	) => void;

	/** Canvas view prefs (ephemeral UI state, not persisted). */
	showConnections: boolean;
	toggleConnections: () => void;
	hiddenKinds: NodeKind[];
	toggleKindVisibility: (kind: NodeKind) => void;
	/** Non-destructive tidy actions for the canvas-settings popover. */
	repairOverlaps: () => void;
	relayout: () => void;

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
			baseline: [makeProjectNode()],
			identities: [],
			// Edges are ON: a dependency graph you have to opt into isn't a dependency graph. The
			// derived edges (network → cluster → leaves) are what make the board readable as a system.
			showConnections: true,
			hiddenKinds: [],
			collectionPositions: {},
			containerGeometry: {},

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
				// Preserve any already-loaded BYO chart nodes across a form reseed — they're
				// out-of-band (loaded from getProjectByoCharts), not part of the form graph, so the
				// incoming form-derived `nodes` never contain them and would otherwise wipe them.
				const charts = get().nodes.filter((n) => OUT_OF_BAND.has(n.data.kind));
				const base = nodes.some((n) => n.id === PROJECT_NODE_ID)
					? nodes
					: [makeProjectNode(), ...nodes];
				// A freshly-loaded graph arrives from formToGraph as a flat grid. Lay it out by ZONE so it
				// opens looking like the system it describes. Positions aren't part of the staged diff
				// (diffNodes compares config + placement, never position), so this can never register as
				// a pending change.
				const seeded = [...base, ...charts];
				const provider = (id: string) =>
					seeded.find((n) => n.id === id)?.data.provider ??
					seeded.find((n) => n.id === PROJECT_NODE_ID)?.data.provider ??
					null;
				const withRoot = applyLayout(seeded, layoutZoned(seeded, provider));
				set({
					nodes: withRoot,
					edges: deriveEdges(withRoot),
					selectedIds: [],
					inspectorNodeId: null,
					dirty: false,
					past: [],
					future: [],
					// The loaded graph is the saved state → it becomes the diff baseline. (Chart
					// nodes ride along but diffNodes skips them, so they never show as changes.)
					baseline: structuredClone(withRoot),
					// A freshly laid-out graph derives fresh container boxes; a stale override from a prior
					// project must not survive and strand a region away from its members.
					containerGeometry: {},
				});
			},

			setChartNodes: (charts) => {
				const nonChart = get().nodes.filter((n) => n.data.kind !== "chart");
				const chartNodes: CanvasNode[] = charts.map((c, i) => ({
					id: `chart-${c.id}`,
					type: "chart",
					// Non-deletable: detaching is out-of-band (detachByoChart) via the node's own
					// action, so a stray keyboard-delete can't orphan a project_addons row.
					deletable: false,
					position: { x: 900, y: 160 + i * 150 },
					data: {
						kind: "chart",
						config: {
							id: c.id,
							repoUrl: c.repoUrl,
							chartPath: c.chartPath,
							ref: c.ref,
							namespace: c.namespace,
							status: c.status,
							health: c.health,
							sync: c.sync,
							scanStatus: c.scanStatus,
							scanReport: c.scanReport,
						},
						cloud_identity_id: null,
						provider: null,
					},
				}));
				const next = [...nonChart, ...chartNodes];
				set({ nodes: next, edges: deriveEdges(next) });
			},

			setChartWorkloadNodes: (workloads) => {
				const others = get().nodes.filter((n) => n.data.kind !== "chart_workload");
				// Stack each chart's described workloads beneath its parent `chart-` node (fallback to a
				// column if the chart node hasn't loaded yet — the two loaders run independently). Like
				// chart nodes, these are non-deletable: they're an out-of-band description, not a staged
				// change, so a stray Backspace must not orphan the render.
				const perChart = new Map<string, number>();
				const workloadNodes: CanvasNode[] = workloads.map((w) => {
					const parent = others.find((n) => n.id === `chart-${w.chartId}`);
					const i = perChart.get(w.chartId) ?? 0;
					perChart.set(w.chartId, i + 1);
					const px = parent?.position.x ?? 900;
					const py = parent?.position.y ?? 160;
					return {
						id: `cw-${w.id}`,
						type: "chart_workload",
						deletable: false,
						position: { x: px + 40, y: py + 150 + i * 130 },
						data: {
							kind: "chart_workload",
							config: {
								id: w.id,
								chartId: w.chartId,
								name: w.name,
								kind: w.kind,
								rendered: w.rendered,
								bindings: w.bindings,
								config: w.config,
								valuePaths: w.valuePaths,
							},
							cloud_identity_id: null,
							provider: null,
						},
					};
				});
				const next = [...others, ...workloadNodes];
				set({ nodes: next, edges: deriveEdges(next) });
			},

			setAddonNodes: (addons) => {
				const others = get().nodes.filter((n) => n.data.kind !== "addon");
				const addonNodes: CanvasNode[] = addons.map((a, i) => ({
					id: `addon-${a.id}`,
					type: "addon",
					// Not keyboard-deletable: an add-on is removed by disabling it (which tears down its
					// ArgoCD Application), never by a stray Backspace on the board.
					deletable: false,
					position: { x: 120 + (i % 2) * 270, y: 520 + Math.floor(i / 2) * 150 },
					data: {
						kind: "addon",
						config: {
							id: a.id,
							name: a.name,
							version: a.version,
							namespace: a.namespace,
							status: a.status,
							health: a.health,
							sync: a.sync,
						},
						cloud_identity_id: null,
						provider: null,
					},
				}));
				const next = [...others, ...addonNodes];
				set({ nodes: next, edges: deriveEdges(next) });
			},

			setIacNodes: (groups) => {
				const prev = get().nodes;
				// Where each external card already sits. This is fed by the environment-status query,
				// which POLLS (every 30s, every 4s mid-deploy) — so without remembering positions, a
				// card the user dragged somewhere sensible would snap back to the default grid on the
				// next poll, over and over. The card's CONTENT still refreshes; only its place is kept.
				const placed = new Map(
					prev
						.filter((n) => n.data.kind === "external")
						.map((n) => [n.id, n.position] as const),
				);
				const others = prev.filter((n) => n.data.kind !== "external");
				const iacNodes: CanvasNode[] = groups.map((g, i) => {
					const id = `external-${g.key}`;
					return {
						id,
						type: "external",
						// Read-only: the customer's module owns these. There is nothing to delete here —
						// removing a resource means editing their Terraform, not this board.
						deletable: false,
						position:
							placed.get(id) ??
							// Only a card the board has never seen needs a home.
							{ x: 120 + (i % 3) * 300, y: 340 + Math.floor(i / 3) * 190 },
						data: {
							kind: "external",
							config: {
								key: g.key,
								mappedKind: g.kind,
								module: g.module,
								source: g.source,
								members: g.members,
							},
							cloud_identity_id: null,
							provider: null,
						},
					};
				});
				const next = [...others, ...iacNodes];
				set({ nodes: next, edges: deriveEdges(next) });
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
				const config = applyUniqueName(
					kind,
					NODE_REGISTRY[kind].defaultData(provider),
					nodes,
				);
				// Array kinds are UNIQUE on (project, name) — suffix to avoid clashes.
				const node: CanvasNode = {
					id: newId(kind),
					type: kind,
					position: position ?? { x: 120 + count * 48, y: 180 + count * 36 },
					data: buildNodeData(kind, config, null, null),
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
				const merged: Record<string, unknown> = {
					...NODE_REGISTRY[kind].defaultData(provider),
					...config,
				};
				if (typeof merged.name === "string") {
					const taken = new Set(
						nodes
							.filter((n) => n.data.kind === kind)
							.map((n) => configName(n.data))
							.filter((v): v is string => typeof v === "string"),
					);
					merged.name = uniqueName(merged.name, taken);
				}
				const count = nodes.length;
				const node: CanvasNode = {
					id: newId(kind),
					type: kind,
					position: { x: 120 + count * 48, y: 180 + count * 36 },
					data: buildNodeData(kind, merged, cloudIdentityId ?? null, ownProvider),
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
						? { ...n, data: withConfig(n.data, patch) }
						: n,
				);
				set({ nodes: next, edges: deriveEdges(next), dirty: true });
			},

			setNodeIdentity: (id, cloudIdentityId, provider) => {
				get().commit();
				const next = get().nodes.map((n) =>
					n.id === id
						? { ...n, data: withPlacement(n.data, cloudIdentityId, provider) }
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
						.map((n) => configName(n.data))
						.filter((v): v is string => typeof v === "string"),
				);
				const clones = dupable.map((n) => {
					const base = `${configName(n.data) || n.data.kind}-copy`;
					const name = uniqueName(base, taken);
					taken.add(name);
					return {
						...structuredClone(n),
						id: newId(n.data.kind),
						position: { x: n.position.x + 48, y: n.position.y + 48 },
						selected: false,
						data: withConfig(n.data, { name }),
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
					baseline: [makeProjectNode()],
					collectionPositions: {},
					containerGeometry: {},
				}),

			discardChanges: () => {
				const baseline = structuredClone(get().baseline);
				set({
					nodes: baseline,
					edges: deriveEdges(baseline),
					selectedIds: [],
					inspectorNodeId: null,
					dirty: false,
					past: [],
					future: [],
					// Discard reverts the VIEW too — container overrides go back to derived with the graph.
					containerGeometry: {},
				});
			},

			commitBaseline: () => set((s) => ({ baseline: structuredClone(s.nodes), dirty: false })),

			setCollectionPosition: (kind, position) =>
				set((s) => ({
					collectionPositions: { ...s.collectionPositions, [kind]: position },
					dirty: true,
				})),

			setContainerGeometry: (id, box) =>
				set((s) => ({
					containerGeometry: { ...s.containerGeometry, [id]: box },
					dirty: true,
				})),

			resetContainerGeometry: (id) =>
				set((s) => {
					if (!(id in s.containerGeometry)) return {};
					const containerGeometry = { ...s.containerGeometry };
					delete containerGeometry[id];
					return { containerGeometry, dirty: true };
				}),

			translateContainer: (delta, { memberIds, pins }) =>
				set((s) => {
					const moving = new Set(memberIds);
					// A no-op delta happens on click-without-move — don't churn the store.
					if (delta.x === 0 && delta.y === 0) return {};
					const nodes = s.nodes.map((n) =>
						moving.has(n.id)
							? { ...n, position: { x: n.position.x + delta.x, y: n.position.y + delta.y } }
							: n,
					);
					const containerGeometry = { ...s.containerGeometry };
					for (const p of pins) {
						containerGeometry[p.id] = {
							x: p.box.x + delta.x,
							y: p.box.y + delta.y,
							width: p.box.width,
							height: p.box.height,
						};
					}
					return { nodes, containerGeometry, dirty: true };
				}),

			toggleConnections: () => set((s) => ({ showConnections: !s.showConnections })),

			toggleKindVisibility: (kind) =>
				set((s) => ({
					hiddenKinds: s.hiddenKinds.includes(kind)
						? s.hiddenKinds.filter((k) => k !== kind)
						: [...s.hiddenKinds, kind],
				})),

			repairOverlaps: () => {
				get().commit();
				const next = spreadOverlaps(get().nodes);
				set({ nodes: next, dirty: true });
			},

			relayout: () => {
				get().commit();
				// Zone-aware: the cluster's workloads inside the cluster, managed data in the VPC beside
				// it, periphery clear of both — so the board lays out the way the system is actually
				// shaped rather than as one row per kind.
				const next = applyLayout(
					get().nodes,
					layoutZoned(get().nodes, (id) => get().getEffectiveProvider(id)),
				);
				// Drop the collection cards' pinned positions AND the container overrides too, so a "tidy"
				// re-anchors the vaults + re-fits every region on their freshly-laid-out members instead of
				// stranding them where they were dragged.
				set({ nodes: next, collectionPositions: {}, containerGeometry: {}, dirty: true });
			},

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
			name: "design-project-canvas-draft",
			storage: createJSONStorage(() => sessionStorage),
			version: 1,
			// Persist the graph + baseline (so the pending-changes diff survives reload), where the
			// collection cards were dragged to, and any container geometry the user set; identities are
			// server data and history is ephemeral.
			partialize: (state) => ({
				nodes: state.nodes,
				edges: state.edges,
				baseline: state.baseline,
				collectionPositions: state.collectionPositions,
				containerGeometry: state.containerGeometry,
			}),
		},
	),
);

export { PROJECT_NODE_ID };
