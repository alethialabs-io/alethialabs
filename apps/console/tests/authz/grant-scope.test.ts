// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared scope predicate (#4584). This is the module that exists so the community
// `PostgresRbacPDP` and the enterprise OpenFGA expander cannot answer "what does this row scope
// to?" differently — so the assertions here are about the RULING, and the parity integration
// suite is what proves both engines actually consume it.

import { describe, expect, it } from "vitest";
import { INSTANCE_TYPES, PARENTS } from "@/lib/authz/fga-hierarchy";
import {
	denyTarget,
	EMPTY_SCOPE_DENIES,
	grantTarget,
	targetForEffect,
} from "@/lib/authz/grant-scope";
import { GRANT_SCOPES } from "@/lib/queries/access-grants";
import { RESOURCES } from "@/lib/authz/registry";

describe("grantTarget — a null resource_id, and only that, is org-wide", () => {
	it("is org-wide for a null id, whatever the kind column happens to say", () => {
		// `resource_id NULL = org-wide (wildcard)` is the column's own contract, and the kind
		// column does not get a vote: rows written by `ensureMemberGrant` carry 'org', rows the
		// parity fixture writes carry 'project'. Both are org-wide.
		for (const kind of ["org", "project", "runner", "cloud_identity", "banana"]) {
			expect(grantTarget(kind, null)).toEqual({ kind: "org" });
		}
	});

	it("is scoped for every kind the hierarchy says has its own instance object", () => {
		for (const kind of INSTANCE_TYPES) {
			expect(grantTarget(kind, "R1")).toEqual({
				kind: "resource",
				resourceType: kind,
				resourceId: "R1",
			});
		}
	});
});

describe("grantTarget — the rows that confer nothing", () => {
	it('refuses the "org" kind carrying an id, naming which contradiction it is', () => {
		expect(grantTarget("org", "P1")).toEqual({
			kind: "none",
			reason: "org_kind_with_resource_id",
		});
	});

	it("refuses an unrecognised kind carrying an id", () => {
		expect(grantTarget("banana", "P1")).toEqual({
			kind: "none",
			reason: "unscopable_resource_kind",
		});
	});

	// The registry has resource kinds with no per-instance object — `job` is high-volume and
	// ephemeral, `member`/`activity`/`billing` resolve at the org. A grant naming one of those
	// alongside an id is as unrepresentable as the `org` pair, and lands the same way.
	it("refuses a registry resource that is not an instance type", () => {
		const orgLevel = RESOURCES.filter((r) => !(r in PARENTS) && r !== "org");
		expect(orgLevel.length).toBeGreaterThan(0);
		for (const kind of orgLevel) {
			expect(grantTarget(kind, "X1")).toEqual({
				kind: "none",
				reason: "unscopable_resource_kind",
			});
		}
	});
});

// ── The deny direction (#4584 — RULED: excludes the whole org) ──────────────────────────────────
// `grantTarget` answers what a row CONFERS. A deny row is asked what it EXCLUDES, and for a row
// that scopes to nothing those get DIFFERENT answers by ruling (#4584): confers nothing, excludes
// the whole org. Both fail closed — the symmetry is in the direction, not the value. These assert
// the SPLIT (the two questions go to different predicates) and, below, the ruled value itself.
describe("targetForEffect asks a DENY row a different question", () => {
	it("routes allow rows to grantTarget and deny rows to denyTarget", () => {
		for (const [type, id] of [
			["org", null],
			["project", "P1"],
			["org", "P1"],
			["banana", "P1"],
		] as const) {
			expect(targetForEffect("allow", type, id)).toEqual(grantTarget(type, id));
			expect(targetForEffect("deny", type, id)).toEqual(denyTarget(type, id));
		}
	});

	it("agrees with grantTarget on every row that DOES scope to something", () => {
		// The split may only touch the `none` case. If a deny row that names a real resource
		// started resolving differently, every scoped exclusion in the product would move.
		for (const [type, id] of [
			["org", null],
			["project", null],
			["project", "P1"],
			["runner", "R1"],
			["connector", "C1"],
			["cloud_identity", "I1"],
		] as const) {
			expect(denyTarget(type, id)).toEqual(grantTarget(type, id));
		}
	});

	// ⚠ THE RULING, PINNED AS A LITERAL (#4584). While the deny direction was undecided these
	// expectations READ `EMPTY_SCOPE_DENIES`, so that flipping it moved the tests with the
	// behaviour — which is what made the switch a one-line change. The ruling is now made, and a
	// derived expectation would mean the decision had nothing behind it: flipping the constant
	// back would be silently green. So the value is asserted directly, here and at every level.
	it("RULED: a scope-to-nothing DENY excludes the whole org", () => {
		expect(EMPTY_SCOPE_DENIES).toBe("the_whole_org");
		for (const type of ["org", "banana", "job"]) {
			expect(denyTarget(type, "P1")).toEqual({ kind: "org" });
			// …and the ALLOW row of the same shape still confers nothing. The two answers are
			// different VALUES on purpose — what is symmetric is the direction, both fail-closed.
			expect(grantTarget(type, "P1").kind).toBe("none");
		}
	});

	it("never resolves a deny to the resource it names — OpenFGA cannot express that", () => {
		// The third possible ruling, and the reason it is not on offer: there is no object of
		// that type and id for a deny tuple to sit on, so choosing it would move the divergence
		// rather than close it. `GrantTarget`'s resource arm is typed to make it unwritable.
		const target = denyTarget("org", "P1");
		expect(target.kind).not.toBe("resource");
	});
});

describe("the scopable set is derived from the hierarchy, not from the facet list", () => {
	it("is exactly the keys of PARENTS", () => {
		expect(new Set(INSTANCE_TYPES)).toEqual(new Set(Object.keys(PARENTS)));
	});

	// #4582's text suggests reusing `GRANT_SCOPES`. It is a read-side facet list and it OMITS
	// `connector`, so adopting it would turn a connector-scoped grant — which expands correctly
	// today — into a row that confers nothing. This asserts the difference rather than trusting
	// the prose, because the prose is what was wrong.
	it("includes connector, which GRANT_SCOPES does not", () => {
		const scopable: readonly string[] = INSTANCE_TYPES;
		const facets: readonly string[] = GRANT_SCOPES;
		expect(scopable).toContain("connector");
		expect(facets).not.toContain("connector");
	});
});
