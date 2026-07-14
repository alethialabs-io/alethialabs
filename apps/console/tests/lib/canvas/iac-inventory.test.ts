// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	buildIacInventory,
	groupKeyForAddress,
	parsePlanInventory,
	type IacMember,
} from "@/lib/canvas/iac-inventory";
import type { IacScanResource } from "@/types/jsonb.types";

/** A plan_result as the runner posts it (runner.go: metadata.plan_result = {resource_changes}). */
function planResult(
	entries: {
		address: string;
		type: string;
		name: string;
		module_address?: string;
		actions: string[];
	}[],
): Record<string, unknown> {
	return {
		resource_changes: entries.map((e) => ({
			address: e.address,
			type: e.type,
			name: e.name,
			...(e.module_address ? { module_address: e.module_address } : {}),
			change: { actions: e.actions },
		})),
	};
}

const scan = (
	rows: { address: string; type: string; name: string; module?: string }[],
): IacScanResource[] => rows;

describe("parsePlanInventory", () => {
	it("KEEPS no-op resources", () => {
		// The whole point. A healthy, fully-applied module is ENTIRELY no-op, and lib/plan/parse-plan's
		// parsePlanJSON drops no-ops because it answers "what will this deploy change?". Reusing it
		// would have made the architecture VANISH the moment the environment went green.
		const members = parsePlanInventory(
			planResult([
				{ address: "aws_vpc.main", type: "aws_vpc", name: "main", actions: ["no-op"] },
				{ address: "aws_subnet.a", type: "aws_subnet", name: "a", actions: ["create"] },
			]),
		);
		expect(members.map((m) => m.address)).toEqual(["aws_vpc.main", "aws_subnet.a"]);
		expect(members[0].action).toBe("no-op");
		expect(members[1].action).toBe("create");
	});

	it("prefers the plan's module_address for the module path", () => {
		const [member] = parsePlanInventory(
			planResult([
				{
					address: 'module.vpc.aws_subnet.this[0]',
					type: "aws_subnet",
					name: "this",
					module_address: "module.vpc",
					actions: ["create"],
				},
			]),
		);
		expect(member.module).toBe("module.vpc");
	});

	it("derives the module path by anchoring on the TYPE, so for_each keys containing dots survive", () => {
		// `module.vpc["eu.west"].aws_subnet.this["a.b"]` — counting dots from the end would mangle it.
		const [member] = parsePlanInventory(
			planResult([
				{
					address: 'module.vpc["eu.west"].aws_subnet.this["a.b"]',
					type: "aws_subnet",
					name: "this",
					actions: ["create"],
				},
			]),
		);
		expect(member.module).toBe('module.vpc["eu.west"]');
	});

	it("is empty for a missing / malformed plan rather than throwing", () => {
		expect(parsePlanInventory(null)).toEqual([]);
		expect(parsePlanInventory({ nonsense: true })).toEqual([]);
	});
});

describe("buildIacInventory", () => {
	it("groups by (kind × module) through the canvas's own kind vocabulary", () => {
		const groups = buildIacInventory({
			planMembers: parsePlanInventory(
				planResult([
					{ address: "module.vpc.aws_vpc.this", type: "aws_vpc", name: "this", module_address: "module.vpc", actions: ["create"] },
					{ address: "module.vpc.aws_subnet.a", type: "aws_subnet", name: "a", module_address: "module.vpc", actions: ["create"] },
					{ address: "module.eks.aws_eks_cluster.main", type: "aws_eks_cluster", name: "main", module_address: "module.eks", actions: ["create"] },
				]),
			),
		});

		expect(groups.map((g) => [g.kind, g.module, g.members.length])).toEqual([
			["cluster", "module.eks", 1],
			["network", "module.vpc", 2],
		]);
	});

	it("never drops an unrecognised type — it rolls into the honest Other group", () => {
		// A customer module is full of random_password / null_resource / tls_* / custom providers.
		// Dropping them would understate their architecture; this mirrors the unattributed-drift rule.
		const groups = buildIacInventory({
			planMembers: parsePlanInventory(
				planResult([
					{ address: "null_resource.hook", type: "null_resource", name: "hook", actions: ["create"] },
					{ address: "tls_private_key.k", type: "tls_private_key", name: "k", actions: ["create"] },
				]),
			),
		});
		expect(groups).toHaveLength(1);
		expect(groups[0].kind).toBeNull();
		expect(groups[0].key).toBe("other|");
		expect(groups[0].members).toHaveLength(2);
	});

	it("orders Other last, so the leftovers bucket never leads the board", () => {
		const groups = buildIacInventory({
			planMembers: parsePlanInventory(
				planResult([
					{ address: "null_resource.hook", type: "null_resource", name: "hook", actions: ["create"] },
					{ address: "aws_vpc.main", type: "aws_vpc", name: "main", actions: ["create"] },
				]),
			),
		});
		expect(groups.map((g) => g.kind)).toEqual(["network", null]);
	});

	it("lets a PLAN supersede the scan wholesale — never merging the two", () => {
		// They disagree about `count` BY CONSTRUCTION: the scan declares `aws_subnet.this` once; the
		// plan expands it to [0] and [1]. A merged inventory would invent an address matching nothing.
		const groups = buildIacInventory({
			scanResources: scan([
				{ address: "aws_subnet.this", type: "aws_subnet", name: "this" },
			]),
			planMembers: parsePlanInventory(
				planResult([
					{ address: "aws_subnet.this[0]", type: "aws_subnet", name: "this", actions: ["create"] },
					{ address: "aws_subnet.this[1]", type: "aws_subnet", name: "this", actions: ["create"] },
				]),
			),
		});
		expect(groups).toHaveLength(1);
		expect(groups[0].source).toBe("plan");
		expect(groups[0].members.map((m) => m.address)).toEqual([
			"aws_subnet.this[0]",
			"aws_subnet.this[1]",
		]);
	});

	it("falls back to the scan skeleton when nothing has been planned yet", () => {
		// This is what makes the board an architecture the moment the (free, credential-less) scan
		// lands — before the environment has ever seen a cloud credential.
		const groups = buildIacInventory({
			scanResources: scan([
				{ address: "module.vpc.aws_vpc.this", type: "aws_vpc", name: "this", module: "module.vpc" },
			]),
			planMembers: [],
		});
		expect(groups).toHaveLength(1);
		expect(groups[0].source).toBe("scan");
		expect(groups[0].kind).toBe("network");
		expect(groups[0].module).toBe("module.vpc");
		// A scan cannot know what a deploy would do, and an invented "no-op" would read as "live".
		expect(groups[0].members[0].action).toBeUndefined();
	});

	it("is empty when the module has been neither scanned nor planned", () => {
		// An older runner emits no scan_report.resources. Degrade to nothing — do NOT fabricate an
		// empty architecture, which would read as "this module builds nothing".
		expect(buildIacInventory({ scanResources: null, planMembers: [] })).toEqual([]);
		expect(buildIacInventory({})).toEqual([]);
	});
});

describe("groupKeyForAddress", () => {
	const groups = buildIacInventory({
		planMembers: parsePlanInventory(
			planResult([
				{ address: "aws_vpc.main", type: "aws_vpc", name: "main", actions: ["no-op"] },
			]),
		),
	});

	it("joins a Terraform address onto its group exactly", () => {
		expect(groupKeyForAddress(groups, "aws_vpc.main")).toBe("network|");
	});

	it("returns null for an address no group owns, rather than guessing", () => {
		// The honesty rule: drift we cannot place rolls up to the environment. A wrong badge on the
		// wrong card is worse than an admitted "unattributed".
		expect(groupKeyForAddress(groups, "aws_db_instance.orders")).toBeNull();
	});
});

describe("the members contract", () => {
	it("keeps every member's address, so cost/drift/verify can join on it", () => {
		const members: IacMember[] = parsePlanInventory(
			planResult([
				{ address: "aws_vpc.main", type: "aws_vpc", name: "main", actions: ["no-op"] },
			]),
		);
		expect(members[0]).toMatchObject({
			address: "aws_vpc.main",
			type: "aws_vpc",
			name: "main",
			module: "",
		});
	});
});
