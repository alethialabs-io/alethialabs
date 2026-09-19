// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The OpenFGA dual-write writer. Postgres is the source of truth; this mirrors grant
// / hierarchy / team changes into the FGA store, and backfill() reconciles the whole
// store from Postgres at boot. Uses ONLY core's pure helpers (core.fga.*) + core.db
// (raw SQL) — no core runtime import. Standup-verified (needs a running OpenFGA).

import { OpenFgaClient } from "@openfga/sdk";
import { sql } from "drizzle-orm";
import type { FgaTuple, GrantScope } from "@/lib/authz/fga-tuples";
import type { HierarchyEdge, ScopedGrant, TupleSync } from "@/lib/authz/tuple-sync";
import type { CoreContext } from "@/lib/enterprise";

/** OpenFGA write batches are bounded; chunk to stay under the limit. */
const BATCH = 80;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** The OpenFGA subject string for a grant principal. */
function grantSubject(g: { principalType: "user" | "team"; principalId: string }): string {
	return g.principalType === "team"
		? `team:${g.principalId}#member`
		: `user:${g.principalId}`;
}

/**
 * The hard stop on `readAllTuples`' loop, counted in PAGES because the page SIZE is the server's
 * and not ours — nothing here sends `page_size`. A correct server ends the walk by returning an
 * empty `continuation_token`; this bounds a server that never does.
 *
 * A thousand pages is far beyond anything a grant expansion reaches at any page size OpenFGA
 * serves: `PERMISSIONS` is under a hundred keys, so a subject's tuples on one object are in the
 * tens, and even the whole-store-by-subject read in `revokeMemberGrant` is bounded by that times
 * the objects one member is granted on. Reaching this means the server is misbehaving, not that
 * the subject is unusually privileged.
 */
const MAX_READ_PAGES = 1000;

/**
 * The only capability `readAllTuples` needs of the client: OpenFGA's Read, with its pagination
 * surface. Declared structurally rather than as `OpenFgaClient` so a test can hand it a page
 * SEQUENCE without standing up the SDK's `$response` envelope — `OpenFgaClient` satisfies it.
 *
 * The asymmetric casing is the SDK's, not a typo, and getting it wrong is silent: the REQUEST
 * takes `continuationToken` in the second (options) argument — @openfga/sdk 0.8.1 maps it onto
 * the wire's `continuation_token` itself — while the RESPONSE carries the wire spelling
 * `continuation_token`. Reading `res.continuationToken` would be `undefined` on every page and
 * the loop would stop after the first one, which is precisely the bug this replaces.
 */
export interface TupleReader {
	read(
		body?: { user?: string; object?: string; relation?: string },
		options?: { continuationToken?: string },
	): Promise<{
		tuples?: { key?: FgaTuple }[];
		continuation_token?: string;
	}>;
}

/**
 * EVERY tuple matching the filter, walked to exhaustion across OpenFGA's Read pagination.
 *
 * ⚠ THE REASON THIS EXISTS. `client.read()` returns ONE PAGE — at most the server's `page_size`
 * tuples, plus a `continuation_token` naming the next. @openfga/sdk 0.8.1 does NOT auto-paginate
 * (`client.js` forwards `page_size`/`continuation_token` and returns the single response), and
 * before this the token was read nowhere in the repo — so the one call this replaces returned a
 * PAGE while its caller was written as though it returned the set.
 *
 * Every caller here reads in order to DELETE, so a partial read is a partial revoke: the surplus
 * tuples survive, unattributable to any grant row, and `deleteTuples`' `Promise.allSettled`
 * reports nothing. The density that reaches a page boundary is ordinary, not pathological: an
 * org-wide `admin` allow is already about one tuple per `PERMISSIONS` key on `org:<orgId>`, and
 * the #4584 ruling puts a scope-to-nothing DENY's tuples on that very object, on top of it. If
 * the survivor is a `*_deny_*` tuple the subject stays denied a permission no row denies.
 *
 * The bound is now `MAX_READ_PAGES` pages, and exceeding it THROWS rather than returning what it
 * has. A short read is what the caller cannot detect; a thrown error fails the revoke loudly and
 * leaves Postgres — the source of truth — to be re-asserted by `backfill` at the next boot.
 * A token that repeats is the same refusal for the same reason: it cannot terminate.
 */
export async function readAllTuples(
	client: TupleReader,
	filter: { user?: string; object?: string },
): Promise<FgaTuple[]> {
	const out: FgaTuple[] = [];
	const seen = new Set<string>();
	let token: string | undefined;

	for (let page = 0; page < MAX_READ_PAGES; page++) {
		const res = await client.read(filter, token === undefined ? {} : { continuationToken: token });
		for (const t of res.tuples ?? []) {
			if (t.key) out.push(t.key);
		}
		// An EMPTY token is the documented end of the walk, not a missing field — and an absent
		// one is treated the same way, because a server that omits it has no next page to name.
		const next = res.continuation_token;
		if (!next) return out;
		if (seen.has(next)) {
			throw new Error(
				`OpenFGA Read returned a non-advancing continuation token after ${page + 1} page(s) for ${JSON.stringify(filter)}; refusing to loop`,
			);
		}
		seen.add(next);
		token = next;
	}

	throw new Error(
		`OpenFGA Read exceeded ${MAX_READ_PAGES} pages for ${JSON.stringify(filter)}; refusing to read further`,
	);
}

/**
 * The OpenFGA object a grant's tuples LIVE on.
 *
 * THE INVARIANT: every tuple `expandGrant` produces for the same scope sits on the object this
 * returns. Both read the same typed `GrantScope` (#4582) — org arm → `org:<orgId>`, resource arm
 * → `<resourceType>:<resourceId>` — and that type is the only way a scope reaches either of them.
 * The effect is not an input here, and does not need to be: the #4584 ruling that an allow row
 * and a deny row of the same contradictory shape resolve differently is applied BEFORE a
 * `GrantScope` exists, by `grantScopeFromRow` (via `targetForEffect`), and a row that resolves to
 * nothing never becomes a `GrantScope` at all — its callers skip it, so there is nothing here to
 * return null for.
 *
 * ⚠ THE CONVERSE DOES NOT HOLD. `expandGrant` also produces nothing when every permission key is
 * org-level — `isOrgLevel` is true for EVERY `create` action — so
 * `expandGrant({resourceType:"project", resourceId:P}, ["project:create"])` is `[]` while this
 * returns `project:P`. That combination is writable today.
 *
 * ⚠ The consequence is real and PRE-EXISTING: `clearGrantTuples` will clear the subject's tuples
 * on `project:P` and then write nothing back. Narrowing that would mean taking the keys here and
 * skipping on an empty expansion — which trades this wipe for stale tuples when a role's bundle
 * becomes entirely org-level, so it is a design question rather than a typo, and it is recorded
 * rather than decided. See the note on `clearGrantTuples`.
 *
 * It used to be `resourceId ? \`${resourceType}:${resourceId}\` : \`org:${orgId}\`` — the two
 * columns read independently of the expander. For an `('org', <resource-uuid>)` row that produced
 * `org:<resource-uuid>`, an object type/id pair that does not exist, while `expandGrant` had
 * written the tuples on `org:<orgId>`. The pre-write delete and `removeScopedGrant` both looked
 * there and found nothing, so REVOKING SUCH A GRANT REMOVED THE ROW AND LEFT THE ACCESS (#4584).
 * That pair is no longer a `GrantScope`, so it cannot reach this function.
 *
 * Exported because the invariant is a PURE property and is unit-tested as one: for each row
 * shape, narrow it, expand it for real, and assert every tuple's object equals what this returns.
 */
export function grantObject(g: GrantScope): string {
	return g.resourceType === "org"
		? `org:${g.orgId}`
		: `${g.resourceType}:${g.resourceId}`;
}

export class FgaTupleSync implements TupleSync {
	constructor(
		private readonly core: CoreContext,
		private readonly client: OpenFgaClient,
	) {}

	/**
	 * The idempotent "replace this grant's tuples" delete: clear whatever the subject already has
	 * on the object this grant writes to. A no-op when the grant expands to nothing.
	 *
	 * ⚠ THIS IS COARSE, AND IT HAS ALWAYS BEEN. `existingFor` reads EVERY tuple the subject has on
	 * that object and deletes all of them — not only the ones this grant contributed, which the
	 * store cannot attribute anyway. For an org-wide grant that means clearing the subject's whole
	 * org-object capability set. Pre-existing behaviour for every `resource_id IS NULL` row; noted
	 * because the #4584 ruling extends WHICH rows land on the org object (below), and it fails
	 * closed and is re-asserted from Postgres by `backfill` at the next boot.
	 *
	 * ⚠ AND "EVERY" IS A CLAIM WITH A BOUND BEHIND IT, which is the only reason it may be written
	 * here at all. An earlier version of this sentence asserted the totality while `existingFor`
	 * issued ONE unpaginated `client.read()` — one page of however many tuples existed — so a
	 * revoke on a dense org object was silently PARTIAL and a surviving `*_deny_*` tuple could
	 * keep a subject denied a permission no row denied any more. `existingFor` now walks
	 * `readAllTuples`, whose bound is `MAX_READ_PAGES` and whose behaviour AT the bound is to
	 * throw, not to return a short list. A coarse delete is a decision; a short one is a leak.
	 *
	 * ⚠ AND THE TWO EFFECTS NOW BEHAVE DIFFERENTLY FOR A ROW THAT SCOPES TO NOTHING (#4584):
	 *
	 *   allow — `grantScopeFromRow` returns null, so no caller reaches this and nothing is
	 *     cleared — including the tuples such a row wrote under the PRE-#4584 reading: those sit
	 *     on `org:<orgId>`, indistinguishable from a legitimate org-wide grant's, and deleting
	 *     them blind would revoke real access.
	 *   deny — the ruling is that it excludes ORG-WIDE, so its tuples genuinely DO live on
	 *     `org:<orgId>` and this clears them — together with everything else the subject has
	 *     there, per the coarseness above.
	 *
	 * Which is one more reason the audit says NEVER remediate one of these by revoking. Whether
	 * any exist, and whether removing them takes access from anyone, is what the #4583 audit
	 * answers per row (docs/ops/grants-scope-contradictions.sql).
	 */
	private async clearGrantTuples(subject: string, grant: GrantScope): Promise<void> {
		await this.deleteTuples(await this.existingFor(subject, grantObject(grant)));
	}

	private async writeTuples(tuples: FgaTuple[]): Promise<void> {
		for (const batch of chunk(tuples, BATCH)) {
			await this.client.write({ writes: batch }).catch(() => {
				// Tolerate already-exists on re-runs by retrying tuple-by-tuple.
				return Promise.allSettled(
					batch.map((t) => this.client.write({ writes: [t] })),
				).then(() => undefined);
			});
		}
	}

	private async deleteTuples(tuples: FgaTuple[]): Promise<void> {
		for (const batch of chunk(tuples, BATCH)) {
			await Promise.allSettled(
				batch.map((t) => this.client.write({ deletes: [t] })),
			);
		}
	}

	/**
	 * Every current tuple for a subject on an object (to replace a grant idempotently), walked
	 * across Read pagination — see `readAllTuples` for what "every" is bounded by and what it
	 * does instead of returning a short answer.
	 */
	private async existingFor(user: string, object: string): Promise<FgaTuple[]> {
		return readAllTuples(this.client, { user, object });
	}

	private async builtinRoleId(role: string): Promise<string | null> {
		const rows = await this.core.db.execute<{ id: string }>(
			sql`select id from role where name = ${role} and is_builtin = true limit 1`,
		);
		return rows[0]?.id ?? null;
	}

	async syncMemberGrant(orgId: string, userId: string, role: string): Promise<void> {
		const roleId = await this.builtinRoleId(role);
		if (!roleId) return;
		const keys = await this.core.fga.rolePermissionKeys(roleId);
		const tuples = this.core.fga.expandGrant(
			{
				orgId,
				principalType: "user",
				principalId: userId,
				effect: "allow",
				resourceType: "org",
			},
			keys,
		);
		// Replace: drop the user's existing org-wide tuples, then write the new set.
		await this.deleteTuples(await this.existingFor(`user:${userId}`, `org:${orgId}`));
		await this.writeTuples(tuples);
	}

	async revokeMemberGrant(_orgId: string, userId: string): Promise<void> {
		// Remove every tuple where this user is the subject (org-wide + any scoped). This one is
		// filtered by SUBJECT ALONE, across every object in the store, so it is the call here most
		// certain to exceed a page: a member with an org-wide role plus scoped grants on a few
		// projects clears 50 tuples without being remarkable. It walks the pages for that reason.
		await this.deleteTuples(await readAllTuples(this.client, { user: `user:${userId}` }));
	}

	async syncScopedGrant(grant: ScopedGrant): Promise<void> {
		const keys = grant.permissionKey
			? [grant.permissionKey]
			: grant.roleId
				? await this.core.fga.rolePermissionKeys(grant.roleId)
				: [];
		// `ScopedGrant` IS a `GrantScope` (plus what it grants), so there is no scope to rebuild
		// here — and no way to rebuild one from free strings, which is the point (#4582).
		const tuples = this.core.fga.expandGrant(grant, keys);
		await this.clearGrantTuples(grantSubject(grant), grant);
		await this.writeTuples(tuples);
	}

	async removeScopedGrant(grant: ScopedGrant): Promise<void> {
		await this.clearGrantTuples(grantSubject(grant), grant);
	}

	async syncHierarchyEdge(edge: HierarchyEdge): Promise<void> {
		await this.writeTuples([this.core.fga.hierarchyTuple(edge)]);
	}

	async removeHierarchyEdge(edge: HierarchyEdge): Promise<void> {
		await this.deleteTuples([this.core.fga.hierarchyTuple(edge)]);
	}

	async syncTeamMember(teamId: string, userId: string): Promise<void> {
		await this.writeTuples([this.core.fga.teamMemberTuple(teamId, userId)]);
	}

	async removeTeamMember(teamId: string, userId: string): Promise<void> {
		await this.deleteTuples([this.core.fga.teamMemberTuple(teamId, userId)]);
	}

	async resyncRole(roleId: string): Promise<void> {
		const keys = await this.core.fga.rolePermissionKeys(roleId);
		const grants = await this.core.db.execute<{
			org_id: string;
			principal_type: "user" | "team";
			principal_id: string;
			effect: "allow" | "deny";
			resource_type: string;
			resource_id: string | null;
		}>(sql`
			select org_id, principal_type, principal_id, effect, resource_type, resource_id
			from grants where role_id = ${roleId}
		`);
		for (const g of grants) {
			// The scope, EXACTLY as syncScopedGrant sees it. This loop used to inline its own
			// copy of the object expression and its own `g.resource_id ? g.resource_type : "org"`
			// normalisation — a structural duplicate that a fix to `grantObject` alone would have
			// left wrong, which is the shape where the second renderer never gets the fix.
			//
			// The row is raw columns, so it is NARROWED, not spread: an allow row that confers
			// nothing is null and has no tuples to clear or write (#4582, applying the #4584 ruling
			// through `targetForEffect`; a deny row of that shape comes back org-wide).
			const scope = this.core.fga.grantScopeFromRow({
				orgId: g.org_id,
				principalType: g.principal_type,
				principalId: g.principal_id,
				effect: g.effect,
				resourceType: g.resource_type,
				resourceId: g.resource_id,
			});
			if (scope === null) continue;
			await this.clearGrantTuples(grantSubject(scope), scope);
			await this.writeTuples(this.core.fga.expandGrant(scope, keys));
		}
	}

	async backfill(): Promise<void> {
		// 1. Write (or refresh) the authorization model.
		await this.client.writeAuthorizationModel(this.core.fga.buildModel());

		// 2. Grants → permission tuples (expand each grant's role).
		const grants = await this.core.db.execute<{
			org_id: string;
			principal_type: "user" | "team";
			principal_id: string;
			effect: "allow" | "deny";
			role_id: string | null;
			permission_key: string | null;
			resource_type: string;
			resource_id: string | null;
		}>(sql`
			select org_id, principal_type, principal_id, effect, role_id, permission_key,
			       resource_type, resource_id
			from grants
		`);
		const tuples: FgaTuple[] = [];
		for (const g of grants) {
			// Narrowed, not spread — see `resyncRole`. A null scope writes nothing, as it always
			// did; it just no longer reaches the expander to find that out.
			const scope = this.core.fga.grantScopeFromRow({
				orgId: g.org_id,
				principalType: g.principal_type,
				principalId: g.principal_id,
				effect: g.effect,
				resourceType: g.resource_type,
				resourceId: g.resource_id,
			});
			if (scope === null) continue;
			const keys = g.permission_key
				? [g.permission_key]
				: g.role_id
					? await this.core.fga.rolePermissionKeys(g.role_id)
					: [];
			tuples.push(...this.core.fga.expandGrant(scope, keys));
		}

		// 3. Hierarchy edges → parent tuples.
		const edges = await this.core.db.execute<{
			child_type: string;
			child_id: string;
			parent_type: string;
			parent_id: string;
		}>(sql`select child_type, child_id, parent_type, parent_id from resource_hierarchy`);
		for (const e of edges) {
			tuples.push(
				this.core.fga.hierarchyTuple({
					childType: e.child_type,
					childId: e.child_id,
					parentType: e.parent_type,
					parentId: e.parent_id,
				}),
			);
		}

		await this.writeTuples(tuples);
	}
}
