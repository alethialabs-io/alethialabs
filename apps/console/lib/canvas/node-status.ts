"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-node status for the Architecture canvas. Status is a DERIVED value — never stored on the
// node (that would corrupt graphToForm / structuralHash / the staged-change diff).
//
// Two layers, merged by `resolveNodeStatus`'s precedence ladder:
//   • DESIGN readiness (client) — needs-setup / gated / ready, from the exact validation the deploy
//     uses, so "ready" always means "deployable".
//   • SERVER truth (component_status, the env's in-flight job, drift, the cluster probe) — every one
//     of which already existed in the database and, until now, reached nothing.

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
import type { DriftDetail } from "@/types/jsonb.types";
import {
	externalStatusKey,
	type ComponentServerStatus,
	type EnvironmentStatus,
	type IacEnvironment,
} from "./component-status";
import { useEnvironmentStatus } from "./environment-status-context";

/**
 * Every state a node can be in — the DESIGN states (resolved client-side, from the same validation
 * the deploy uses) and the SERVER states (resolved from the component row, the environment's
 * in-flight job, and the cluster probe).
 *
 * Drift is deliberately NOT a state here. It's an OVERLAY that rides on top of whatever the node
 * already is — a drifted node is still `live` — which is what stops this from degenerating into one
 * state per combination.
 */
export type NodeStatusState =
	// design (client)
	| "needs-setup"
	| "ready"
	| "gated"
	// provisioning lifecycle (server)
	| "not-deployed"
	| "queued"
	| "applying"
	| "updating"
	| "update-pending"
	| "live"
	| "destroying"
	| "destroyed"
	| "failed"
	// keep-proving-it (server)
	| "unreachable";

/** A grayscale `vx-status` modifier (dot fill/shape, never hue) + a terse mono label. */
export interface NodeStatusMeta {
	vx: "idle" | "active" | "pending" | "failed" | "disabled" | "live";
	label: string;
}

/**
 * Central state → visual mapping. Every modifier used below ALREADY ships in the design system's
 * token layer (packages/brand/src/tokens.css) — no new tokens were needed to express all of this,
 * because status was always meant to read through dot fill and shape rather than hue.
 */
export const NODE_STATUS_META: Record<NodeStatusState, NodeStatusMeta> = {
	"needs-setup": { vx: "idle", label: "Needs setup" },
	ready: { vx: "active", label: "Ready" },
	gated: { vx: "disabled", label: "Gated" },
	"not-deployed": { vx: "idle", label: "Not deployed" },
	queued: { vx: "pending", label: "Queued" },
	applying: { vx: "live", label: "Applying" },
	updating: { vx: "pending", label: "Updating" },
	"update-pending": { vx: "pending", label: "Update pending" },
	live: { vx: "active", label: "Live" },
	destroying: { vx: "pending", label: "Destroying" },
	destroyed: { vx: "disabled", label: "Destroyed" },
	failed: { vx: "failed", label: "Failed" },
	unreachable: { vx: "failed", label: "Unreachable" },
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
	storage_buckets: "bucket",
	container_registries: "registry",
};

/**
 * Stable per-node key: singletons by kind, array items by `kind:name` (matches the component
 * tables' `(project, env, name)` uniqueness). Phase 2 uses this to join resolved server status.
 *
 * An EXTERNAL card (one kind's worth of a BYO IaC module) has no component row and no `name`, so it
 * is keyed by its group key — matching `externalStatusKey()` on the server.
 */
export function nodeStatusKey(node: CanvasNode): string {
	if (node.data.kind === "external") return externalStatusKey(node.data.config.key);
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
 * (cross-cloud CORE placement, mirrors the Go provisioner gate), or `ready`.
 *
 * PURE, so a caller that must resolve MANY nodes at once — a collection card reporting its worst
 * member — can loop over them. Calling a hook per member would break the rules of hooks the moment
 * a resource is added or removed and the list length changed.
 */
export function nodeReadiness(
	nodes: CanvasNode[],
	core: string | null,
	id: string,
): NodeReadiness {
	const node = nodes.find((n) => n.id === id);
	if (!node) return { state: "ready", complete: true, gated: false };
	const issue = issueMap(nodes)[id];
	const complete = !issue;
	const def = NODE_REGISTRY[node.data.kind];
	const effId = node.data.cloud_identity_id ?? core;
	const gated = def.classification === "core" && !!core && effId !== core;
	const state: NodeStatusState = !complete ? "needs-setup" : gated ? "gated" : "ready";
	return { state, issue, complete, gated };
}

/** {@link nodeReadiness} for a single node, bound to the store. */
export function useNodeReadiness(id: string): NodeReadiness {
	const nodes = useCanvasStore((s) => s.nodes);
	const core = useCanvasStore((s) => s.getCoreIdentity());
	return useMemo(() => nodeReadiness(nodes, core, id), [id, nodes, core]);
}

/** A node's fully-resolved status: one state, why it's in it, and any overlays riding on top. */
export interface NodeStatus {
	state: NodeStatusState;
	/** The most actionable line for this state (a config issue, a failure message, a probe reason). */
	message?: string;
	/** Drifted resources attributed to this node. An OVERLAY — the node keeps its base state. */
	drift: DriftDetail[];
	/** What the deploy produced (endpoints, ArgoCD URL, repository URL). Empty until deployed. */
	outputs: { label: string; value: string }[];
	/** Monthly cost from the last PLAN. Null = not priced (never planned, or not a priced resource). */
	monthlyCost: number | null;
	/** The itemised cost lines behind `monthlyCost` (Terraform address → monthly). Empty when unpriced. */
	costLines: { address: string; monthlyCost: number }[];
	/** True once this node exists in the environment's provisioned state. */
	deployed: boolean;
}

/**
 * THE PRECEDENCE LADDER — first match wins.
 *
 * A node has several truths at once (its design is invalid AND it's live AND it drifted), so the
 * order they resolve in is the whole contract. It is written out here, once, because this is exactly
 * where a status system rots: someone adds a state, slots it in "somewhere reasonable", and the
 * canvas starts lying.
 *
 *   1  failed          — a real, actionable break outranks everything
 *   2  in flight       — queued · applying · updating · destroying (the truth is "we're mid-change")
 *   3  needs-setup     — the design itself is invalid; nothing downstream matters
 *   4  gated           — the design is valid but will not provision
 *   5  destroyed       — it's gone
 *   6  not deployed    — designed, never applied
 *   7  unreachable     — live-but-imperfect: it exists, but the cluster didn't answer
 *   8  update pending  — live, but the design has moved ahead of what's deployed
 *   9  live / ready    — the calm nominal state
 *
 * Drift and cost are NEVER base states. They're overlays that ride on whatever the node already is.
 *
 * Pure, so the ladder is unit-testable without React or a database.
 */
export function resolveNodeStatus(
	readiness: NodeReadiness,
	server: ComponentServerStatus | undefined,
	env: Pick<EnvironmentStatus, "activeJob" | "updatePending" | "probe">,
	opts: { isCluster?: boolean } = {},
): NodeStatus {
	// No component row: this node has never been provisioned, so the design layer is the whole truth.
	if (!server) {
		return {
			state: readiness.state,
			message: readiness.issue,
			drift: [],
			outputs: [],
			monthlyCost: null,
			costLines: [],
			deployed: false,
		};
	}

	const drift = server.drift;
	const base = {
		drift,
		outputs: server.outputs ?? [],
		monthlyCost: server.monthlyCost ?? null,
		costLines: server.costLines ?? [],
		deployed: true,
	};

	// 1 — a real break.
	if (server.lifecycle === "FAILED") {
		return { ...base, state: "failed", message: server.message ?? undefined };
	}

	// 2 — mid-change. What's happening outranks what the design says about it.
	if (server.lifecycle === "CREATING") return { ...base, state: "applying" };
	if (server.lifecycle === "UPDATING") return { ...base, state: "updating" };
	if (server.lifecycle === "DESTROYING") return { ...base, state: "destroying" };

	// 3/4 — the design is broken or won't provision. Surfaced even over a live resource, because the
	// NEXT deploy is what the user is about to do, and it will not work.
	if (readiness.state === "needs-setup") {
		return { ...base, state: "needs-setup", message: readiness.issue };
	}
	if (readiness.state === "gated") return { ...base, state: "gated" };

	// 5/6 — not (or no longer) there.
	if (server.lifecycle === "DESTROYED") return { ...base, state: "destroyed", deployed: false };
	if (server.lifecycle === "PENDING") {
		return env.activeJob
			? { ...base, state: "queued", deployed: false }
			: { ...base, state: "not-deployed", deployed: false };
	}

	// ACTIVE from here on.
	// 7 — it exists, but the cluster's API server didn't answer. Only the cluster can be unreachable.
	if (opts.isCluster && env.probe?.reachable === false) {
		return { ...base, state: "unreachable", message: env.probe.message ?? undefined };
	}

	// 8 — live, but the saved design has moved ahead of what was deployed.
	if (env.updatePending) return { ...base, state: "update-pending" };

	// 9 — nominal.
	return { ...base, state: "live" };
}

/**
 * THE EXTERNAL LADDER — the same shape as the one above, for a card the design does not own.
 *
 * A BYO IaC module has NO per-resource status anywhere: no component rows are written for it, and
 * until W8 `project_iac_sources.status` was a column nothing ever wrote. So this state is DERIVED,
 * from the three things the server actually knows:
 *
 *   • the safety gate's verdict — a rejected module will not provision, whatever else is true;
 *   • whether a deploy ever applied this module (`deployed_commit_sha`);
 *   • what the LAST PLAN would still do to these particular resources (their plan actions).
 *
 * The order mirrors the component ladder, and for the same reason: a card has several truths at
 * once, and picking one is the whole contract.
 *
 *   1  failed          — the module's own apply broke
 *   2  in flight       — a job is changing it right now
 *   3  needs-setup     — the safety gate rejected it; the next deploy will not run
 *   4  not deployed    — never applied
 *   5  update pending  — applied, but the last plan would still change these resources
 *   6  live            — applied, and the last plan says no-op
 *
 * Drift and cost stay OVERLAYS — they ride on whatever state this returns, exactly as they do for a
 * component node. Pure, so it is unit-testable without React or a database.
 */
export function resolveExternalStatus(
	config: { members: { action?: string }[]; source: "plan" | "scan" },
	source: IacEnvironment["source"],
	server: ComponentServerStatus | undefined,
	env: Pick<EnvironmentStatus, "activeJob">,
): NodeStatus {
	const base = {
		drift: server?.drift ?? [],
		outputs: [],
		monthlyCost: server?.monthlyCost ?? null,
		costLines: server?.costLines ?? [],
		deployed: !!source.deployedCommitSha,
	};

	// 1 — the module's apply broke.
	if (server?.lifecycle === "FAILED") {
		return { ...base, state: "failed", message: server.message ?? undefined };
	}

	// 2 — mid-change.
	if (server?.lifecycle === "CREATING") return { ...base, state: "applying" };
	if (server?.lifecycle === "UPDATING") return { ...base, state: "updating" };
	if (server?.lifecycle === "DESTROYING") return { ...base, state: "destroying" };
	if (env.activeJob && !source.deployedCommitSha) {
		return { ...base, state: "queued", deployed: false };
	}

	// 3 — the safety gate rejected the module (or it has never been scanned, which is NOT a pass).
	// Fail-closed: this is the same verdict that blocks provisioning server-side.
	if (source.scanOk !== true) {
		return {
			...base,
			state: "needs-setup",
			message:
				source.scanOk === false
					? "The IaC safety scan rejected this module — it will not provision."
					: "This module has not been scanned yet.",
		};
	}

	// 4 — never applied.
	if (!source.deployedCommitSha) {
		return { ...base, state: "not-deployed", deployed: false };
	}

	// 5 — applied, but the last plan would still change these resources. Only a PLAN can tell us:
	// the static scan carries no actions, and inventing "no-op" would read as a confident "live".
	if (
		config.source === "plan" &&
		config.members.some((m) => m.action && m.action !== "no-op")
	) {
		return { ...base, state: "update-pending" };
	}

	// 6 — nominal.
	return { ...base, state: "live" };
}

/**
 * A node's resolved status: design readiness merged with the environment's server truth through the
 * precedence ladder above. Falls back to pure readiness when there's no environment status yet (the
 * create flow, or while the first fetch is in flight), so the canvas never blocks on the network.
 */
export function useNodeStatus(id: string): NodeStatus {
	const readiness = useNodeReadiness(id);
	const env = useEnvironmentStatus();
	const node = useCanvasStore((s) => s.nodes.find((n) => n.id === id));

	return useMemo(() => {
		if (!node)
			return {
				state: readiness.state,
				drift: [],
				outputs: [],
				monthlyCost: null,
				costLines: [],
				deployed: false,
			};
		const key = nodeStatusKey(node);
		// External cards belong to a module the design doesn't own, so the design-readiness half of
		// the ladder is meaningless for them — they resolve through their own.
		if (node.data.kind === "external" && env.iac) {
			return resolveExternalStatus(
				node.data.config,
				env.iac.source,
				env.components[key],
				env,
			);
		}
		return resolveNodeStatus(readiness, env.components[key], env, {
			isCluster: node.data.kind === "cluster",
		});
	}, [readiness, env, node]);
}

/**
 * The hook-free form of {@link useNodeStatus} — resolves ONE node from an already-held graph +
 * environment status. This is what lets a collection card resolve all forty of its members in a
 * plain loop: a hook per member would break the rules of hooks the moment a secret is added.
 */
export function resolveNodeStatusFor(
	nodes: CanvasNode[],
	core: string | null,
	env: EnvironmentStatus,
	id: string,
): NodeStatus {
	const node = nodes.find((n) => n.id === id);
	const readiness = nodeReadiness(nodes, core, id);
	if (!node)
		return {
			state: readiness.state,
			drift: [],
			outputs: [],
			monthlyCost: null,
			costLines: [],
			deployed: false,
		};
	return resolveNodeStatus(readiness, env.components[nodeStatusKey(node)], env, {
		isCluster: node.data.kind === "cluster",
	});
}
