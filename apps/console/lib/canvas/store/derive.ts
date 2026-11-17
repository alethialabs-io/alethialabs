// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Everything the board DERIVES from its nodes (#6764): the edges, the pending changes, a node's
// effective cloud, the design's revision and whether a reviewed plan still describes it. Pure
// functions over values, so a derived fact is never stored where it could go stale.

import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type {
	CanvasEdge,
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import { fnv1a32, stableStringify } from "@/lib/canvas/design-revision";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import {
	PROJECT_NODE_ID,
	type FieldChange,
	type PendingChange,
	type ReviewedPlan,
	type StagedOperation,
} from "./types";

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

/** True for a node the design owns: one that is saved, diffed and undone. */
export function isDesignNode(node: CanvasNode): boolean {
	return !OUT_OF_BAND.has(node.data.kind);
}

/** The project root node's chosen identity = the stack's CORE; null until picked. */
export function coreIdentity(nodes: CanvasNode[]): string | null {
	return nodes.find((n) => n.id === PROJECT_NODE_ID)?.data.cloud_identity_id ?? null;
}

/**
 * The cloud a node deploys to: its own placement, else the project root's. The provider stamped on
 * the node wins; when a node carries none, the identity list answers for the identity it resolves
 * to, so a caller holding the list does not depend on the stamp being fresh.
 */
export function effectiveProvider(
	nodes: CanvasNode[],
	id: string,
	identities: readonly CloudIdentityOption[] = [],
): CloudProviderSlug | null {
	const node = nodes.find((n) => n.id === id);
	if (!node) return null;
	const root = nodes.find((n) => n.id === PROJECT_NODE_ID);
	const stamped = node.data.provider ?? root?.data.provider ?? null;
	if (stamped) return stamped;
	const identityId = node.data.cloud_identity_id ?? root?.data.cloud_identity_id ?? null;
	const listed = identities.find((i) => i.id === identityId)?.provider;
	return listed && isCloudProviderSlug(listed) ? listed : null;
}

/** The identity a node resolves to (its own, else the project CORE), from the identity list. */
export function effectiveIdentity(
	nodes: CanvasNode[],
	id: string,
	identities: readonly CloudIdentityOption[],
): CloudIdentityOption | null {
	const node = nodes.find((n) => n.id === id);
	if (!node) return null;
	const effId = node.data.cloud_identity_id ?? coreIdentity(nodes);
	return identities.find((i) => i.id === effId) ?? null;
}

/**
 * Canonical dependency edges, derived from the nodes (not user-drawn). A service's declared
 * bindings become service→resource edges; a described chart workload draws its parent edge and its
 * own binding edges.
 */
export function deriveEdges(nodes: CanvasNode[]): CanvasEdge[] {
	const byKind = (kind: NodeKind) => nodes.filter((n) => n.data.kind === kind);
	const edges: CanvasEdge[] = [];

	// W2 — the board draws NO substrate spine. The old network→cluster→every-leaf dependency edges
	// existed only to say "this all runs on the cluster"; the cluster/network are env settings now
	// (implicit substrate), so the only edges are the derived service→resource bindings below.

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

/** Human label for a node from its config (resource name, else the kind). */
function nodeName(n: CanvasNode): string {
	return configName(n.data) || n.data.kind;
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

/**
 * The same diff as {@link diffNodes}, one row per changed FIELD: what the saved design holds and
 * what the draft holds. A node that is wholly new or wholly removed is one row with a null field.
 * Every node `diffNodes` reports appears here and no other does, so the two can be shown side by
 * side without disagreeing about what is pending.
 */
export function diffFields(baseline: CanvasNode[], nodes: CanvasNode[]): FieldChange[] {
	const base = new Map(baseline.map((n) => [n.id, n]));
	const cur = new Map(nodes.map((n) => [n.id, n]));
	const rows: FieldChange[] = [];
	for (const change of diffNodes(baseline, nodes)) {
		const head = { id: change.id, op: change.op, kind: change.kind, name: change.name };
		if (change.op !== "modified") {
			rows.push({ ...head, field: null, before: undefined, after: undefined });
			continue;
		}
		const prev = base.get(change.id);
		const next = cur.get(change.id);
		if (!prev || !next) continue;
		const before = Object.entries(prev.data.config);
		const after = Object.entries(next.data.config);
		const keys = new Set([...before.map(([k]) => k), ...after.map(([k]) => k)]);
		for (const key of [...keys].sort()) {
			const was = before.find(([k]) => k === key)?.[1];
			const is = after.find(([k]) => k === key)?.[1];
			if (JSON.stringify(was) === JSON.stringify(is)) continue;
			rows.push({ ...head, field: key, before: was, after: is });
		}
		if (prev.data.cloud_identity_id !== next.data.cloud_identity_id) {
			rows.push({
				...head,
				field: "cloud_identity_id",
				before: prev.data.cloud_identity_id,
				after: next.data.cloud_identity_id,
			});
		}
	}
	return rows;
}

const revisionCache = new WeakMap<CanvasNode[], string>();

/**
 * A content hash of the design the nodes describe: equal for equal content, whatever the object
 * identity, and blind to where a card sits. A plan is recorded against it, so "is this plan still
 * about this design" is one string comparison.
 */
export function draftRevision(designNodes: CanvasNode[]): string {
	const cached = revisionCache.get(designNodes);
	if (cached !== undefined) return cached;
	const revision = fnv1a32(
		stableStringify(
			designNodes
				.filter(isDesignNode)
				.map((n) => ({ id: n.id, data: n.data })),
		),
	);
	revisionCache.set(designNodes, revision);
	return revision;
}

/** What the board knows about the plan in front of a deploy. */
export type PlanReviewState =
	/** No plan has been reviewed for this draft. */
	| "none"
	/** The reviewed plan was computed for exactly the design on the board. */
	| "current"
	/** The design moved after the plan was computed. */
	| "stale";

/** Whether the reviewed plan still describes the design on the board. */
export function planReviewState(
	reviewedPlan: ReviewedPlan | null,
	designNodes: CanvasNode[],
): PlanReviewState {
	if (!reviewedPlan) return "none";
	return reviewedPlan.designRevision === draftRevision(designNodes) ? "current" : "stale";
}

/** Why Deploy is, or is not, on offer. */
export interface DeployGate {
	allowed: boolean;
	reason: "ok" | "no-plan" | "stale-plan" | "unsaved-edits";
	/** The plan a deploy would apply; null unless `allowed`. */
	planJobId: string | null;
}

/**
 * Whether Deploy may be offered. It may only when a reviewed plan is current for the design on the
 * board AND nothing is pending against the saved design — there is no other path to `allowed`.
 *
 * `serverCurrent` is the server's own answer for the same plan (`canvas.reviewPlan.current`); when
 * it is known and false, the plan is stale whatever the board believes.
 */
export function deployGate(input: {
	reviewedPlan: ReviewedPlan | null;
	designNodes: CanvasNode[];
	baseline: CanvasNode[];
	operations: StagedOperation[];
	serverCurrent?: boolean;
}): DeployGate {
	const state = planReviewState(input.reviewedPlan, input.designNodes);
	if (!input.reviewedPlan || state === "none") {
		return { allowed: false, reason: "no-plan", planJobId: null };
	}
	if (state === "stale" || input.serverCurrent === false) {
		return { allowed: false, reason: "stale-plan", planJobId: null };
	}
	const pending =
		diffNodes(input.baseline, input.designNodes).length + input.operations.length;
	if (pending > 0) return { allowed: false, reason: "unsaved-edits", planJobId: null };
	return { allowed: true, reason: "ok", planJobId: input.reviewedPlan.planJobId };
}
