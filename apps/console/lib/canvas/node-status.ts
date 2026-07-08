"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-node status for the Architecture canvas. Status is a DERIVED value — never stored on the
// node (that would corrupt graphToForm / structuralHash / the staged-change diff). Phase 1 resolves
// the client-only *design readiness* layer (needs-setup / gated / ready) from the same validation
// the deploy uses; Phase 2 layers the resolved server/provisioning status on top via a resolver.

import { useMemo } from "react";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { projectFormSchema } from "@/lib/validations/project-form.schema";

/**
 * The user-facing status states a node can be in. Phase 1 resolves the client-only readiness subset;
 * the commented states land in Phase 2 (server/provisioning) — the visual map below is pre-seeded so
 * adding them is data-only.
 */
export type NodeStatusState =
	| "needs-setup"
	| "ready"
	| "gated";
// Phase 2: | "new" | "queued" | "applying" | "live" | "update-pending"
//          | "drifted" | "failed" | "destroying" | "destroy-failed" | "orphaned" | "stale"

/** A grayscale `vx-status` modifier (dot fill/shape, never hue) + a terse mono label. */
export interface NodeStatusMeta {
	vx: "idle" | "active" | "pending" | "failed" | "disabled" | "live";
	label: string;
}

/** Central state → visual mapping. Keeps base-node and the inspector in lockstep and gives Phase 2
 * one place to extend. */
export const NODE_STATUS_META: Record<NodeStatusState, NodeStatusMeta> = {
	"needs-setup": { vx: "idle", label: "Needs setup" },
	ready: { vx: "active", label: "Ready" },
	gated: { vx: "disabled", label: "Gated" },
};

export interface NodeReadiness {
	state: NodeStatusState;
	/** First actionable config issue when `needs-setup`. */
	issue?: string;
	complete: boolean;
	gated: boolean;
}

// Which ProjectFormData key each node kind validates under (mirrors NODE_REGISTRY.schemaKey).
const SINGLETON_SCHEMA_KIND: Record<string, NodeKind> = {
	project: "project",
	network: "network",
	cluster: "cluster",
	dns: "dns",
	repositories: "repositories",
};
const ARRAY_SCHEMA_KIND: Record<string, NodeKind> = {
	databases: "database",
	caches: "cache",
	queues: "queue",
	topics: "topic",
	nosql_tables: "nosql",
	secrets: "secret",
};

/**
 * Stable per-node key: singletons by kind, array items by `kind:name` (matches the component
 * tables' `(project, env, name)` uniqueness). Phase 2 uses this to join resolved server status.
 */
export function nodeStatusKey(node: CanvasNode): string {
	const def = NODE_REGISTRY[node.data.kind];
	if (def.cardinality === "singleton") return node.data.kind;
	const name = configName(node.data) ?? "";
	return `${node.data.kind}:${name}`;
}

// The whole-graph parse is O(nodes); memoize on the nodes array reference so every node component
// reuses a single computation per render/commit (zustand keeps `nodes` referentially stable).
let cacheRef: CanvasNode[] | null = null;
let cacheIssues: Record<string, string> = {};

/**
 * Maps each node id → its first config issue (absent = complete). Reuses the EXACT deploy-time
 * validation (graphToForm + projectFormSchema) so readiness always equals deployability. Issues on
 * keys with no matching node (e.g. a required-but-absent component) are dropped — they're a
 * graph-level concern surfaced at deploy, not a per-node badge.
 */
function computeIssues(nodes: CanvasNode[]): Record<string, string> {
	// Readiness is a non-critical overlay — a malformed draft must never crash the canvas. Any
	// unexpected throw (schema edge case, bad persisted config) degrades to "no issues" (all ready).
	let result: ReturnType<typeof projectFormSchema.safeParse>;
	try {
		result = projectFormSchema.safeParse(graphToForm(nodes));
	} catch {
		return {};
	}
	if (result.success) return {};
	const issues: Record<string, string> = {};
	for (const issue of result.error.issues) {
		const head = issue.path[0];
		const idx = issue.path[1];
		if (typeof head !== "string") continue;
		let nodeId: string | undefined;
		if (head === "source_repos" || head === "project") {
			// Source repos + project fields both live on the project root node.
			nodeId = nodes.find((n) => n.data.kind === "project")?.id;
		} else if (SINGLETON_SCHEMA_KIND[head]) {
			nodeId = nodes.find((n) => n.data.kind === SINGLETON_SCHEMA_KIND[head])?.id;
		} else if (ARRAY_SCHEMA_KIND[head] && typeof idx === "number") {
			nodeId = nodes.filter((n) => n.data.kind === ARRAY_SCHEMA_KIND[head])[idx]?.id;
		}
		if (nodeId && !issues[nodeId]) issues[nodeId] = issue.message;
	}
	return issues;
}

function issueMap(nodes: CanvasNode[]): Record<string, string> {
	if (nodes !== cacheRef) {
		cacheRef = nodes;
		cacheIssues = computeIssues(nodes);
	}
	return cacheIssues;
}

/**
 * Client-only design readiness for a node — `needs-setup` (invalid/incomplete config), `gated`
 * (cross-cloud CORE placement, mirrors the Go provisioner gate), or `ready`. Derived live from the
 * store with no server round-trip; Phase 2 resolves the server/provisioning status on top.
 */
export function useNodeReadiness(id: string): NodeReadiness {
	const nodes = useCanvasStore((s) => s.nodes);
	const core = useCanvasStore((s) => s.getCoreIdentity());
	return useMemo(() => {
		const node = nodes.find((n) => n.id === id);
		if (!node) return { state: "ready", complete: true, gated: false };
		const issue = issueMap(nodes)[id];
		const complete = !issue;
		const def = NODE_REGISTRY[node.data.kind];
		const effId = node.data.cloud_identity_id ?? core;
		const gated = def.classification === "core" && !!core && effId !== core;
		const state: NodeStatusState = !complete
			? "needs-setup"
			: gated
				? "gated"
				: "ready";
		return { state, issue, complete, gated };
	}, [id, nodes, core]);
}
