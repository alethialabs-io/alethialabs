// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The OpenFGA dual-write writer's one pure decision: WHERE a grant's tuples live.
//
// Before #4584 this file had no test at all, and the console-side revoke tests
// (tests/actions/grants.test.ts) `vi.mock` the whole tuple-sync seam — so `grantObject` never
// executed anywhere, in any suite, and a revoke that deleted from an object the write had never
// touched was invisible at every level.
//
// The property asserted here is the one that was violated, stated directly:
//
//     grantObject(...) is the object EVERY tuple expandGrant(...) produces sits on,
//     and null exactly when expandGrant produces none.
//
// Both halves come from the REAL core helpers (the `@` alias in vitest.config.ts), not from
// stand-ins. A hand-written expander here would prove this file's model of tuple expansion, which
// is precisely the thing that was wrong: `grantObject` was a second, independent model of it.

import { describe, expect, it } from "vitest";
import { expandGrant } from "@/lib/authz/fga-tuples";
import { EMPTY_SCOPE_DENIES, targetForEffect } from "@/lib/authz/grant-scope";
import { BUILT_IN_ROLES, PERMISSIONS } from "@/lib/authz/registry";
import { grantObject } from "./fga-tuple-sync";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const ALL_KEYS: string[] = PERMISSIONS.map((p) => p.key);
const viewer = BUILT_IN_ROLES.viewer;
const VIEWER_KEYS: string[] = viewer === "*" ? ALL_KEYS : viewer;

const principal = {
	orgId: ORG,
	principalType: "user" as const,
	principalId: USER,
	effect: "allow" as const,
};
const denying = { ...principal, effect: "deny" as const };

/** The scopes a `grants` row can present, including the two that confer nothing. */
const scopes = [
	{
		name: "org-wide (resource_id NULL, 'org' kind — what ensureMemberGrant writes)",
		scope: { ...principal, resourceType: "org", resourceId: null },
	},
	{
		name: "org-wide (resource_id NULL, 'project' kind — what the parity fixture writes)",
		scope: { ...principal, resourceType: "project", resourceId: null },
	},
	{
		name: "scoped to a project",
		scope: { ...principal, resourceType: "project", resourceId: PROJECT },
	},
	{
		name: "scoped to a connector (in PARENTS, absent from GRANT_SCOPES)",
		scope: { ...principal, resourceType: "connector", resourceId: PROJECT },
	},
	{
		name: "THE BAD PAIR — 'org' kind carrying a resource id",
		scope: { ...principal, resourceType: "org", resourceId: PROJECT },
	},
	{
		name: "an unrecognised resource kind carrying an id",
		scope: { ...principal, resourceType: "banana", resourceId: PROJECT },
	},
	// The deny side of each shape. An allow row is asked what it CONFERS and a deny row what it
	// EXCLUDES, so `grantObject` and `expandGrant` both take the effect — and the invariant has to
	// hold on this side too, under whichever way `EMPTY_SCOPE_DENIES` is ruled.
	{
		name: "DENY, org-wide",
		scope: { ...denying, resourceType: "org", resourceId: null },
	},
	{
		name: "DENY, scoped to a project",
		scope: { ...denying, resourceType: "project", resourceId: PROJECT },
	},
	{
		name: "DENY, THE BAD PAIR — the undecided direction (#4584)",
		scope: { ...denying, resourceType: "org", resourceId: PROJECT },
	},
	{
		name: "DENY, an unrecognised resource kind carrying an id",
		scope: { ...denying, resourceType: "banana", resourceId: PROJECT },
	},
] as const;

describe("grantObject names the object expandGrant actually writes to", () => {
	for (const { name, scope } of scopes) {
		it(name, () => {
			const tuples = expandGrant(scope, VIEWER_KEYS);
			const object = grantObject(targetForEffect, scope);

			if (tuples.length === 0) {
				// Nothing was written, so there is nothing to read or delete. Returning an
				// object here is how the leak happened: the delete went somewhere real (or
				// somewhere impossible) while the write had gone elsewhere.
				expect(object).toBeNull();
				return;
			}
			expect(object).not.toBeNull();
			expect(new Set(tuples.map((t) => t.object))).toEqual(new Set([object]));
		});
	}
});

describe("the specific rows the revoke leak was made of", () => {
	// The precise defect: `${resourceType}:${resourceId}` whenever the id was truthy gave
	// `org:<project-uuid>` — an object type/id pair that does not exist — while the tuples had
	// gone to `org:<orgId>`. Named as its own case because the property test above would still
	// pass if BOTH sides moved to the same wrong place.
	it("the bad pair yields null, never org:<resource-uuid>", () => {
		const scope = { ...principal, resourceType: "org", resourceId: PROJECT };
		expect(grantObject(targetForEffect, scope)).toBeNull();
		expect(grantObject(targetForEffect, scope)).not.toBe(`org:${PROJECT}`);
		expect(expandGrant(scope, VIEWER_KEYS)).toEqual([]);
	});

	// The direction that would be far worse than the bug: if a genuine org-wide grant stopped
	// resolving to `org:<orgId>`, every member revoke would silently leave every capability
	// behind. `resource_id NULL` is org-wide whatever the kind column says, and both writers of
	// that shape are covered above.
	it("a genuine org-wide grant still points at the org object", () => {
		expect(
			grantObject(targetForEffect, {
				...principal,
				resourceType: "org",
				resourceId: null,
			}),
		).toBe(`org:${ORG}`);
	});

	// The deny direction is the maintainer's open ruling, so this asserts what the constant SAYS
	// rather than a number typed here: flipping `EMPTY_SCOPE_DENIES` moves the expectation with
	// the behaviour, which is the whole point of the constant existing.
	it("a DENY row that scopes to nothing follows EMPTY_SCOPE_DENIES", () => {
		const scope = { ...denying, resourceType: "org", resourceId: PROJECT };
		expect(grantObject(targetForEffect, scope)).toBe(
			EMPTY_SCOPE_DENIES === "the_whole_org" ? `org:${ORG}` : null,
		);
		// And the ALLOW row of the same shape is unaffected by that ruling either way.
		expect(
			grantObject(targetForEffect, { ...principal, resourceType: "org", resourceId: PROJECT }),
		).toBeNull();
	});

	it("a normal scoped grant still points at the resource instance", () => {
		expect(
			grantObject(targetForEffect, {
				...principal,
				resourceType: "project",
				resourceId: PROJECT,
			}),
		).toBe(`project:${PROJECT}`);
	});
});
