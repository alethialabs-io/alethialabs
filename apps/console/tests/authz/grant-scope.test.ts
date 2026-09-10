// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared scope predicate (#4584). This is the module that exists so the community
// `PostgresRbacPDP` and the enterprise OpenFGA expander cannot answer "what does this row scope
// to?" differently — so the assertions here are about the RULING, and the parity integration
// suite is what proves both engines actually consume it.

import { describe, expect, it } from "vitest";
import { INSTANCE_TYPES, PARENTS } from "@/lib/authz/fga-hierarchy";
import { grantTarget } from "@/lib/authz/grant-scope";
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
