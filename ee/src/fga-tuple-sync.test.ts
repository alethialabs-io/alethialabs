// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The OpenFGA dual-write writer's two testable-in-isolation decisions: WHERE a grant's tuples
// live (`grantObject`, below), and HOW MANY of them a read actually returns (`readAllTuples`,
// at the foot of this file). Both are exported for this suite; the class itself is not
// instantiated here — see the note above `readAllTuples`' block for why.
//
// Before #4584 this file had no test at all, and the console-side revoke tests
// (tests/actions/grants.test.ts) `vi.mock` the whole tuple-sync seam — so `grantObject` never
// executed anywhere, in any suite, and a revoke that deleted from an object the write had never
// touched was invisible at every level.
//
// The property asserted here is the one that was violated, stated directly:
//
//     for every stored row that narrows to a scope (grantScopeFromRow), every tuple
//     expandGrant(scope) produces sits on the object grantObject(scope) names.
//
// Since #4582 both functions take the typed `GrantScope`, and a row that resolves to nothing never
// becomes one — so "nothing to delete" is now `grantScopeFromRow` returning null, asserted below
// for exactly the rows the #4584 ruling says confer nothing.
//
// ⚠ ONE DIRECTION ONLY. An empty expansion does NOT imply a null scope: `expandGrant` also
// produces nothing when the scope is fine and every key is org-level (`isOrgLevel` is true for
// every `create`). The `project:create` row below is that case, and it is here so the gap is
// pinned rather than absent.
//
// Both halves come from the REAL core helpers (the `@` alias in vitest.config.ts), not from
// stand-ins. A hand-written expander here would prove this file's model of tuple expansion, which
// is precisely the thing that was wrong: `grantObject` was a second, independent model of it.

import { describe, expect, it } from "vitest";
import {
	type FgaTuple,
	type GrantScope,
	type GrantScopeRow,
	expandGrant,
	grantScopeFromRow,
} from "@/lib/authz/fga-tuples";
import { EMPTY_SCOPE_DENIES } from "@/lib/authz/grant-scope";
import { BUILT_IN_ROLES, PERMISSIONS } from "@/lib/authz/registry";
import { type TupleReader, grantObject, readAllTuples } from "./fga-tuple-sync";

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

/** The rows a `grants` table can hold, including the two shapes that confer nothing. */
const scopes: readonly { name: string; scope: GrantScopeRow }[] = [
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
	// hold on this side too, under the ruled answer for a deny row (#4584: excludes org-wide).
	{
		name: "DENY, org-wide",
		scope: { ...denying, resourceType: "org", resourceId: null },
	},
	{
		name: "DENY, scoped to a project",
		scope: { ...denying, resourceType: "project", resourceId: PROJECT },
	},
	{
		name: "DENY, THE BAD PAIR — excludes org-wide (#4584, ruled)",
		scope: { ...denying, resourceType: "org", resourceId: PROJECT },
	},
	{
		name: "DENY, an unrecognised resource kind carrying an id",
		scope: { ...denying, resourceType: "banana", resourceId: PROJECT },
	},
];

/** A row narrowed the way every production caller narrows it; the test fails if it is null. */
function narrowed(row: GrantScopeRow): GrantScope {
	const scope = grantScopeFromRow(row);
	if (scope === null) throw new Error(`expected ${JSON.stringify(row)} to narrow to a scope`);
	return scope;
}

/**
 * The case that breaks the CONVERSE: a perfectly good project scope whose only permission is
 * `create`, which `isOrgLevel` sends org-wide and a scoped grant therefore never confers. The
 * expansion is empty and the scope is NOT null.
 */
const CREATE_ONLY = {
	scope: { ...principal, resourceType: "project", resourceId: PROJECT },
	keys: ["project:create"],
} as const satisfies { scope: GrantScope; keys: readonly string[] };

describe("grantObject names the object expandGrant actually writes to", () => {
	for (const { name, scope: row } of scopes) {
		it(name, () => {
			const scope = grantScopeFromRow(row);
			if (scope === null) {
				// Nothing is written, so there is nothing to read or delete. Only an ALLOW row of
				// an uninterpretable shape may land here (#4584); a deny row of that shape
				// excludes org-wide and must narrow to the org arm, or its revoke would delete
				// nothing — the leak this file exists to pin, on the other effect.
				expect(row.effect).toBe("allow");
				expect(row.resourceId).not.toBeNull();
				return;
			}
			const tuples = expandGrant(scope, VIEWER_KEYS);
			expect(tuples.length).toBeGreaterThan(0);
			expect(new Set(tuples.map((t) => t.object))).toEqual(new Set([grantObject(scope)]));
		});
	}
});

describe("the invariant runs one way, and this is the row that proves it", () => {
	it("an empty expansion does NOT imply a null scope — the scope is fine, the KEY is org-level", () => {
		const tuples = expandGrant(CREATE_ONLY.scope, CREATE_ONLY.keys);
		expect(tuples).toEqual([]);
		expect(grantObject(CREATE_ONLY.scope)).toBe(`project:${PROJECT}`);
		// The forward direction still holds vacuously (no tuples to sit anywhere), which is
		// exactly why the property table above could not see this.
	});

	it("…and the same scope with a non-create key does expand onto that object", () => {
		// The control. Without it, the case above would also pass if `project:P` scopes stopped
		// expanding altogether.
		const tuples = expandGrant(CREATE_ONLY.scope, ["project:view"]);
		expect(tuples.length).toBeGreaterThan(0);
		expect(new Set(tuples.map((t) => t.object))).toEqual(
			new Set([grantObject(CREATE_ONLY.scope)]),
		);
	});
});

describe("the specific rows the revoke leak was made of", () => {
	// The precise defect: `${resourceType}:${resourceId}` whenever the id was truthy gave
	// `org:<project-uuid>` — an object type/id pair that does not exist — while the tuples had
	// gone to `org:<orgId>`. Since #4582 the ALLOW row of that shape never becomes a scope at all.
	it("the bad pair (allow) narrows to null — it has no scope to expand or revoke", () => {
		expect(grantScopeFromRow({ ...principal, resourceType: "org", resourceId: PROJECT })).toBeNull();
	});

	// The direction that would be far worse than the bug: if a genuine org-wide grant stopped
	// resolving to `org:<orgId>`, every member revoke would silently leave every capability
	// behind. `resource_id NULL` is org-wide whatever the kind column says.
	it("a genuine org-wide grant still points at the org object", () => {
		expect(grantObject(narrowed({ ...principal, resourceType: "org", resourceId: null }))).toBe(
			`org:${ORG}`,
		);
		expect(
			grantObject(narrowed({ ...principal, resourceType: "project", resourceId: null })),
		).toBe(`org:${ORG}`);
	});

	// RULED (#4584): a scope-to-nothing DENY excludes the whole org. Asserted as a literal, not
	// read from the constant — a derived expectation would let the decision be reverted silently.
	it("RULED: a DENY row that scopes to nothing points at the ORG object", () => {
		expect(EMPTY_SCOPE_DENIES).toBe("the_whole_org");
		expect(grantObject(narrowed({ ...denying, resourceType: "org", resourceId: PROJECT }))).toBe(
			`org:${ORG}`,
		);
		// And the ALLOW row of the same shape still confers nothing, so it still has no scope.
		expect(grantScopeFromRow({ ...principal, resourceType: "org", resourceId: PROJECT })).toBeNull();
	});

	it("a normal scoped grant still points at the resource instance", () => {
		expect(
			grantObject(narrowed({ ...principal, resourceType: "project", resourceId: PROJECT })),
		).toBe(`project:${PROJECT}`);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The OpenFGA Read is PAGINATED, and every caller here reads in order to DELETE.
//
// `existingFor` used to be a single `client.read()` — ONE page, at most the server's `page_size`
// tuples — under a docblock asserting it read EVERY tuple the subject had on that object.
// @openfga/sdk 0.8.1 does not auto-paginate: `read()` takes
// `continuationToken` in its OPTIONS argument and hands back the wire's `continuation_token`,
// and until this fix that field was never read anywhere in the repo.
//
// The failure was silent in both halves. A revoke deleted the first page and left the rest, and
// `deleteTuples`' `Promise.allSettled` reports nothing; a surviving `*_deny_*` tuple then keeps a
// subject denied a permission no grant row denies any more. The density is ordinary, not
// pathological: an org-wide allow is already ~one tuple per `PERMISSIONS` key on `org:<orgId>`,
// and the #4584 ruling puts a scope-to-nothing DENY's tuples on that very object.
//
// `readAllTuples` is exported and tested directly for the same reason `grantObject` is: it is
// this file's other pure-ish decision, and the suite may not instantiate `FgaTupleSync` at all —
// `CoreContext.db` is `getServiceDb`, and vitest.config.ts's rule for this suite is that nothing
// here pulls in core's runtime.

/** A scripted OpenFGA Read: one entry per page, in order. */
function fakeReader(
	pages: { tuples?: { key?: FgaTuple }[]; continuation_token?: string }[],
): TupleReader & { calls: ({ continuationToken?: string } | undefined)[] } {
	const calls: ({ continuationToken?: string } | undefined)[] = [];
	let i = 0;
	return {
		calls,
		read(_body, options) {
			calls.push(options);
			const page = pages[Math.min(i, pages.length - 1)];
			i += 1;
			return Promise.resolve(page);
		},
	};
}

const tuple = (n: number): FgaTuple => ({
	user: `user:${USER}`,
	relation: n % 2 === 0 ? "viewer" : "deny_viewer",
	object: `org:${ORG}`,
});

describe("readAllTuples walks Read's pagination to exhaustion", () => {
	it("returns BOTH pages' tuples, not just the first", async () => {
		// The regression, stated at the smallest size that shows it. A single `client.read()`
		// returns page one and stops; the tuples on page two then survive every delete built on
		// this read.
		const first = [tuple(0), tuple(1)];
		const second = [tuple(2)];
		const client = fakeReader([
			{ tuples: first.map((key) => ({ key })), continuation_token: "tok-1" },
			{ tuples: second.map((key) => ({ key })), continuation_token: "" },
		]);

		const all = await readAllTuples(client, { user: `user:${USER}`, object: `org:${ORG}` });

		expect(all).toEqual([...first, ...second]);
		// And the second request carried the token the first page named — reading the response's
		// field under the wrong (camelCase) spelling would send `undefined` here and re-read
		// page one forever, which the non-advancing guard below would then catch.
		expect(client.calls).toEqual([{}, { continuationToken: "tok-1" }]);
	});

	it("ends on an EMPTY token and on an ABSENT one alike", async () => {
		// OpenFGA documents the empty string as "no more tuples". A server that omits the field
		// has no next page to name either, and treating that as a missing page would hang.
		const empty = fakeReader([{ tuples: [{ key: tuple(0) }], continuation_token: "" }]);
		await expect(readAllTuples(empty, { object: `org:${ORG}` })).resolves.toHaveLength(1);
		expect(empty.calls).toHaveLength(1);

		const absent = fakeReader([{ tuples: [{ key: tuple(0) }] }]);
		await expect(readAllTuples(absent, { object: `org:${ORG}` })).resolves.toHaveLength(1);
		expect(absent.calls).toHaveLength(1);
	});

	it("crosses three pages, so the loop is not an unrolled second read", async () => {
		// The control on the case above. A fix that simply read twice would pass "both pages"
		// and lose page three — the same defect one page further out.
		const client = fakeReader([
			{ tuples: [{ key: tuple(0) }], continuation_token: "a" },
			{ tuples: [{ key: tuple(1) }], continuation_token: "b" },
			{ tuples: [{ key: tuple(2) }], continuation_token: "" },
		]);
		await expect(readAllTuples(client, { user: `user:${USER}` })).resolves.toHaveLength(3);
		expect(client.calls).toEqual([{}, { continuationToken: "a" }, { continuationToken: "b" }]);
	});

	it("skips a page entry with no key rather than writing an undefined tuple", async () => {
		const client = fakeReader([
			{ tuples: [{ key: tuple(0) }, {}], continuation_token: "" },
		]);
		await expect(readAllTuples(client, { object: `org:${ORG}` })).resolves.toEqual([tuple(0)]);
	});

	it("THROWS on a non-advancing token instead of looping forever", async () => {
		// A server that always names the same next page cannot terminate the walk. Refusing is
		// the same choice as the bound below: a short read is what the caller cannot detect.
		const client = fakeReader([{ tuples: [{ key: tuple(0) }], continuation_token: "same" }]);
		await expect(readAllTuples(client, { user: `user:${USER}` })).rejects.toThrow(
			/non-advancing continuation token/,
		);
	});

	it("THROWS at the page bound rather than returning a short list", async () => {
		// An ever-CHANGING token defeats the repeat check, so the hard page cap is a second,
		// independent stop. Asserting the rejection is asserting the direction of the failure:
		// returning what it had would be the original defect, re-entered through the guard.
		let n = 0;
		const client: TupleReader = {
			read() {
				n += 1;
				return Promise.resolve({
					tuples: [{ key: tuple(n) }],
					continuation_token: `tok-${n}`,
				});
			},
		};
		await expect(readAllTuples(client, { user: `user:${USER}` })).rejects.toThrow(
			/exceeded 1000 pages/,
		);
		expect(n).toBe(1000);
	});
});
