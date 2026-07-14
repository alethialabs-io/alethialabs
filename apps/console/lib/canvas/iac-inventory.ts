// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The BYO-IaC inventory — the derived view that lets an environment provisioned from a
// customer's own OpenTofu module read as an ARCHITECTURE instead of a single opaque card.
//
// Two sources, one view, in strict precedence:
//
//   1. the last successful PLAN's `resource_changes` — EXACT and count/for_each-EXPANDED.
//      Its addresses are the same strings `environment_cost.resources[]`,
//      `environment_drift.details[]` and the verify report already speak, so cost, drift and
//      audit join onto these nodes exactly, with no heuristics.
//   2. the IAC_SCAN's `scan_report.resources[]` — the DECLARED skeleton (packages/core/
//      iacsafety). Free, needs no cloud credentials, and lands the moment the module is
//      attached — so the board is an architecture before it has ever been planned.
//
// A plan SUPERSEDES a scan wholesale (never merges): the two disagree about `count` blocks by
// construction, and a half-merged inventory would invent addresses that match nothing.
//
// Resources become cards through the kind vocabulary the canvas already speaks —
// `kindForResourceType` (drift-map.ts, all five clouds) — grouped by (kind × module path). A
// real module is 50–200 resources; 200 cards is the wall of boxes the collections rule exists
// to prevent. Types the platform doesn't recognise are NEVER dropped: they roll into an honest
// `Other` group, exactly as unattributable drift rolls up to the environment.

import { z } from "zod";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { resolveAction, type PlanResource } from "@/lib/plan/parse-plan";
import type { IacScanResource } from "@/types/jsonb.types";
import { kindForResourceType } from "./drift-map";

/** The action a planned resource carries. Reuses the Plan tab's own union. */
export type IacAction = PlanResource["action"];

/** The group key used for resources whose Terraform type maps to no canvas kind. */
export const OTHER_GROUP = "other";

/** One resource inside an external group. */
export interface IacMember {
	/** The Terraform address — the join key for cost, drift and verify. */
	address: string;
	/** Terraform type, e.g. "aws_subnet". */
	type: string;
	/** Local name, e.g. "this". */
	name: string;
	/** Module path prefix — "" for the root module, else "module.vpc". */
	module: string;
	/**
	 * What the last plan would do to this resource. Present only when the inventory came from
	 * a PLAN — the static scan cannot know, and an invented "no-op" would read as "live".
	 */
	action?: IacAction;
}

/**
 * One external card: every resource of one kind, in one Terraform module.
 *
 * This is a VIEW, not a model. Members keep their own addresses and are attributed
 * individually; the group is only how the board stays readable.
 */
export interface IacGroup {
	/** Stable identity across refetches: `${kind ?? "other"}|${module}`. */
	key: string;
	/** The canvas kind this group reads as; null → the honest `Other` bucket. */
	kind: NodeKind | null;
	/** Module path prefix — "" for the root module, else "module.vpc". */
	module: string;
	/** Where these addresses came from. A plan's are exact; a scan's are declared. */
	source: "plan" | "scan";
	/** Sorted by address. */
	members: IacMember[];
}

// Terraform's plan JSON. Deliberately NOT `parsePlanJSON` from lib/plan/parse-plan.ts: that
// one DROPS every `no-op` entry, because it answers "what will this deploy change?". An
// inventory needs the opposite — a healthy, fully-applied module is ENTIRELY no-op, and
// reusing the change summary would make the architecture vanish the moment it went green.
// (no-op is also the signal the status derivation reads as "live and unchanged".)
const inventorySchema = z
	.object({
		resource_changes: z
			.array(
				z.object({
					type: z.string().catch(""),
					name: z.string().catch(""),
					address: z.string().catch(""),
					// Present on resources inside a module; absent at the root.
					module_address: z.string().optional(),
					change: z
						.object({ actions: z.array(z.string()).catch([]) })
						.catch({ actions: [] }),
				}),
			)
			.catch([]),
	})
	.catch({ resource_changes: [] });

/**
 * The module path a resource address sits in.
 *
 * Prefers the plan's own `module_address`. The fallback anchors on the resource TYPE rather
 * than counting dots from the end, because a `for_each` key may itself contain dots
 * (`module.vpc["eu.west"].aws_subnet.this["a.b"]`) — splitting on dots would mangle those.
 */
function modulePathOf(
	address: string,
	type: string,
	moduleAddress?: string,
): string {
	if (moduleAddress) return moduleAddress;
	const i = address.lastIndexOf(`.${type}.`);
	return i > 0 ? address.slice(0, i) : "";
}

/** Reads a PLAN's `execution_metadata.plan_result` into inventory members — no-ops included. */
export function parsePlanInventory(
	planResult: Record<string, unknown> | null | undefined,
): IacMember[] {
	if (!planResult) return [];
	const { resource_changes } = inventorySchema.parse(planResult);
	return resource_changes
		.filter((rc) => rc.address && rc.type)
		.map((rc) => ({
			address: rc.address,
			type: rc.type,
			name: rc.name,
			module: modulePathOf(rc.address, rc.type, rc.module_address),
			action: resolveAction(rc.change.actions),
		}));
}

/** The scan's declared inventory as members (no action — a static scan cannot know one). */
function scanMembers(resources: IacScanResource[]): IacMember[] {
	return resources
		.filter((r) => r.address && r.type)
		.map((r) => ({
			address: r.address,
			type: r.type,
			name: r.name,
			module: r.module ?? "",
		}));
}

/**
 * Build the external-card groups for a BYO-IaC environment.
 *
 * `planMembers` wins whenever it is non-empty; the scan skeleton is the fallback that keeps
 * the board non-empty between attach and the first plan. Both empty → `[]`, and the caller
 * shows an honest empty state rather than an architecture that isn't there.
 */
export function buildIacInventory(input: {
	scanResources?: IacScanResource[] | null;
	planMembers?: IacMember[] | null;
}): IacGroup[] {
	const plan = input.planMembers ?? [];
	const scan = input.scanResources ?? [];

	const source: "plan" | "scan" = plan.length > 0 ? "plan" : "scan";
	const members = plan.length > 0 ? plan : scanMembers(scan);
	if (members.length === 0) return [];

	const byKey = new Map<string, IacGroup>();
	for (const member of members) {
		const kind = kindForResourceType(member.type);
		const key = `${kind ?? OTHER_GROUP}|${member.module}`;
		const group = byKey.get(key);
		if (group) group.members.push(member);
		else {
			byKey.set(key, {
				key,
				kind,
				module: member.module,
				source,
				members: [member],
			});
		}
	}

	const groups = [...byKey.values()];
	for (const group of groups) {
		group.members.sort((a, b) => a.address.localeCompare(b.address));
	}
	// Deterministic board order: `Other` last (it is the leftovers bucket), then by kind, then
	// by module — so a refetch never reshuffles the cards under the user's cursor.
	groups.sort((a, b) => {
		const ak = a.kind ?? "￿";
		const bk = b.kind ?? "￿";
		return ak === bk ? a.module.localeCompare(b.module) : ak.localeCompare(bk);
	});
	return groups;
}

/**
 * The group a Terraform address belongs to — the exact-address join that replaces the fuzzy
 * type+name heuristic for IaC-governed environments. Returns null when no group owns it, so
 * the caller can roll it up to the environment rather than badge a card it may not belong to.
 */
export function groupKeyForAddress(
	groups: IacGroup[],
	address: string,
): string | null {
	for (const group of groups) {
		if (group.members.some((m) => m.address === address)) return group.key;
	}
	return null;
}
