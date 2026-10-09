// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: `elench_drafts`, its RLS and its two owner-pinned functions (ADR 0001 slice 1,
// `docs/adr/0001-elench-drafts-state-machine.md` §3.1-§3.3, #5737). Real Postgres.
//
// What it proves, each by asking the database rather than reading the schema file:
//   1. RLS is ENABLEd (and not forced) and the policy is `owner_only`, user AND org;
//   2. a member never reads, edits, deletes or writes as another member's draft in one org;
//   3. the org wall holds for the user's OWN drafts too;
//   4. one conversation in two orgs is two rows, both insertable (§3.2);
//   5. the purge and the count reach the caller's rows in every org and never another user's, and
//      the count skips a discarded draft (which is not unsent) while the purge still removes it;
//   6. EXECUTE is not PUBLIC's: a role with no grant cannot call either function;
//   7. A11: with the policy FORCEd under a non-BYPASSRLS owner, the purge RAISES instead of
//      silently purging only the current org's rows.
//
// The app-role cases need a distinct `alethia_app` connection (ALETHIA_APP_DATABASE_URL): the
// migration role is BYPASSRLS, so an isolation assertion run through it passes by construction.
// Cases 6 and 7 change roles and ownership inside a service-role transaction that is always rolled
// back, so nothing they do outlives the test.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { getServiceDb, type Tx, withScope } from "@/lib/db";
import { elenchDrafts, type NewElenchDraft } from "@/lib/db/schema";
import { APP_ROLE_DISTINCT, describeIfDb, refusalText } from "./db";

// Two teammates in one org, plus a second org the first user also belongs to.
const USER = randomUUID();
const MATE = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();

/** A draft row's values for (user, org, conversation): an active, empty-of-claims draft. */
function draft(userId: string, orgId: string, conversationId: string): NewElenchDraft {
	return {
		user_id: userId,
		org_id: orgId,
		conversation_id: conversationId,
		revision: 1,
		status: "active",
		text: `draft of ${userId} in ${orgId}`,
		mentions: [],
		artifacts: [],
		cell_target: { x: 1, y: 2 },
	};
}

/** Insert a draft through the APP role, scoped to (userId, orgId), as the actions will. */
async function insertAs(userId: string, orgId: string, values: NewElenchDraft): Promise<string> {
	const [row] = await withScope({ ownerId: userId, orgId }, (tx) =>
		tx.insert(elenchDrafts).values(values).returning({ id: elenchDrafts.id }),
	);
	return row.id;
}

/** The ids of every draft the app role shows under (userId, orgId). */
async function visibleTo(userId: string, orgId: string): Promise<string[]> {
	const rows = await withScope({ ownerId: userId, orgId }, (tx) =>
		tx
			.select({ id: elenchDrafts.id })
			.from(elenchDrafts)
			.where(inArray(elenchDrafts.user_id, [USER, MATE])),
	);
	return rows.map((r) => r.id).sort();
}

/** The rows the SERVICE role sees for a conversation, as `user/org` pairs. */
async function rowsOf(conversationId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ user: elenchDrafts.user_id, org: elenchDrafts.org_id })
		.from(elenchDrafts)
		.where(eq(elenchDrafts.conversation_id, conversationId));
	return rows.map((r) => `${r.user}/${r.org}`).sort();
}

const countRow = z.array(z.object({ n: z.number() }));

/** Call one of the two functions through the app role under (userId, orgId); returns its integer. */
async function callAs(
	fn: "purge" | "count",
	userId: string,
	orgId: string,
	conversationId: string,
): Promise<number> {
	const res = await withScope({ ownerId: userId, orgId }, (tx) =>
		tx.execute(
			fn === "purge"
				? sql`select public.purge_elench_drafts_of_conversation(${conversationId}::uuid) as n`
				: sql`select public.count_elench_drafts_of_conversation(${conversationId}::uuid) as n`,
		),
	);
	return countRow.parse(res)[0].n;
}

/** Thrown to roll a service-role transaction back once its assertions have run. */
class Rollback extends Error {}

/** Run `fn` in a service-role transaction that is ALWAYS rolled back. */
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
	try {
		await getServiceDb().transaction(async (tx) => {
			await fn(tx);
			throw new Rollback("rollback");
		});
	} catch (err) {
		if (!(err instanceof Rollback)) throw err;
	}
}

/** Set the two RLS GUCs for the rest of `tx`, exactly as withScope does. */
async function scopeTx(tx: Tx, userId: string, orgId: string): Promise<void> {
	await tx.execute(
		sql`select set_config('app.current_owner', ${userId}, true), set_config('app.current_org', ${orgId}, true)`,
	);
}

/** Seed (USER, A, c), (USER, B, c) and (MATE, A, c) on the service role, inside `tx`. */
async function seedThreeInTx(tx: Tx, conversationId: string): Promise<void> {
	await tx.insert(elenchDrafts).values([
		draft(USER, ORG_A, conversationId),
		draft(USER, ORG_B, conversationId),
		draft(MATE, ORG_A, conversationId),
	]);
}

/** The purge's answer inside `tx`, under the scope `tx` already carries. */
async function purgeInTx(tx: Tx, conversationId: string): Promise<number> {
	const res = await tx.execute(
		sql`select public.purge_elench_drafts_of_conversation(${conversationId}::uuid) as n`,
	);
	return countRow.parse(res)[0].n;
}

const rlsRows = z.array(z.object({ rls: z.boolean(), forced: z.boolean() }));
const policyRows = z.array(
	z.object({
		name: z.string(),
		cmd: z.string(),
		qual: z.string().nullable(),
		check: z.string().nullable(),
	}),
);
const fnRows = z.array(
	z.object({
		name: z.string(),
		definer: z.boolean(),
		config: z.array(z.string()).nullable(),
		public_exec: z.boolean(),
		app_exec: z.boolean(),
	}),
);

describeIfDb("elench_drafts: RLS and the owner-pinned functions (ADR 0001 slice 1)", () => {
	afterAll(async () => {
		await getServiceDb()
			.delete(elenchDrafts)
			.where(inArray(elenchDrafts.user_id, [USER, MATE]));
	});

	// ── 1. The catalog ──────────────────────────────────────────────────────────────────────────

	it("RLS is enabled on elench_drafts (and not forced, as no table here is)", async () => {
		const [row] = rlsRows.parse(
			await getServiceDb().execute(sql`
				select relrowsecurity as rls, relforcerowsecurity as forced
				  from pg_class where oid = 'public.elench_drafts'::regclass
			`),
		);
		expect(row).toEqual({ rls: true, forced: false });
	});

	it("carries exactly the owner_only policy: every command, user AND org", async () => {
		const rows = policyRows.parse(
			await getServiceDb().execute(sql`
				select polname as name, polcmd::text as cmd,
				       pg_get_expr(polqual, polrelid) as qual,
				       pg_get_expr(polwithcheck, polrelid) as "check"
				  from pg_policy where polrelid = 'public.elench_drafts'::regclass
			`),
		);
		expect(rows.map((r) => r.name)).toEqual(["owner_only"]);
		const [p] = rows;
		expect(p.cmd).toBe("*");
		const both =
			/^\(\(user_id = \(current_setting\('app\.current_owner'::text, true\)\)::uuid\) AND \(org_id = \(current_setting\('app\.current_org'::text, true\)\)::uuid\)\)$/;
		expect(p.qual).toMatch(both);
		expect(p.check).toMatch(both);
	});

	it("both functions are SECURITY DEFINER with search_path pinned and row_security off; PUBLIC cannot execute them, the app role can", async () => {
		const rows = fnRows.parse(
			await getServiceDb().execute(sql`
				select p.proname as name, p.prosecdef as definer, p.proconfig as config,
				       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
				                where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
				       has_function_privilege('alethia_app', p.oid, 'EXECUTE') as app_exec
				  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
				 where n.nspname = 'public'
				   and p.proname in ('purge_elench_drafts_of_conversation', 'count_elench_drafts_of_conversation')
				 order by p.proname
			`),
		);
		expect(rows.map((r) => r.name)).toEqual([
			"count_elench_drafts_of_conversation",
			"purge_elench_drafts_of_conversation",
		]);
		for (const r of rows) {
			expect({ name: r.name, definer: r.definer }).toEqual({ name: r.name, definer: true });
			expect(r.config).toEqual(
				expect.arrayContaining(["search_path=pg_catalog, public", "row_security=off"]),
			);
			expect({ name: r.name, public_exec: r.public_exec, app_exec: r.app_exec }).toEqual({
				name: r.name,
				public_exec: false,
				app_exec: true,
			});
		}
	});

	// ── 2-4. Isolation through the app role ────────────────────────────────────────────────────

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a member never reads, edits, deletes or writes as another member's draft in one org",
		async () => {
			const conversation = randomUUID();
			const mine = await insertAs(USER, ORG_A, draft(USER, ORG_A, conversation));

			expect(await visibleTo(USER, ORG_A)).toContain(mine);
			// The teammate is scoped to the SAME org and still sees nothing: the policy is an AND.
			expect(await visibleTo(MATE, ORG_A)).not.toContain(mine);

			const edited = await withScope({ ownerId: MATE, orgId: ORG_A }, (tx) =>
				tx
					.update(elenchDrafts)
					.set({ text: "overwritten" })
					.where(eq(elenchDrafts.id, mine))
					.returning({ id: elenchDrafts.id }),
			);
			expect(edited).toEqual([]);
			const removed = await withScope({ ownerId: MATE, orgId: ORG_A }, (tx) =>
				tx.delete(elenchDrafts).where(eq(elenchDrafts.id, mine)).returning({ id: elenchDrafts.id }),
			);
			expect(removed).toEqual([]);

			// Writing a row in the other member's name is refused by WITH CHECK.
			const forged = await refusalText(() =>
				insertAs(MATE, ORG_A, draft(USER, ORG_A, randomUUID())),
			);
			expect(forged).toMatch(/row-level security/);

			const [still] = await getServiceDb()
				.select({ text: elenchDrafts.text })
				.from(elenchDrafts)
				.where(eq(elenchDrafts.id, mine));
			expect(still.text).toBe(`draft of ${USER} in ${ORG_A}`);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"the org wall holds: the user's own draft in org B is invisible from org A, and cannot be written there",
		async () => {
			const inB = await insertAs(USER, ORG_B, draft(USER, ORG_B, randomUUID()));
			expect(await visibleTo(USER, ORG_B)).toContain(inB);
			expect(await visibleTo(USER, ORG_A)).not.toContain(inB);

			const edited = await withScope({ ownerId: USER, orgId: ORG_A }, (tx) =>
				tx
					.update(elenchDrafts)
					.set({ text: "from A" })
					.where(eq(elenchDrafts.id, inB))
					.returning({ id: elenchDrafts.id }),
			);
			expect(edited).toEqual([]);

			// A row naming org B, written from org A's scope, is refused by WITH CHECK.
			const crossOrg = await refusalText(() =>
				insertAs(USER, ORG_A, draft(USER, ORG_B, randomUUID())),
			);
			expect(crossOrg).toMatch(/row-level security/);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"one conversation in two orgs is two rows, and both inserts succeed (§3.2)",
		async () => {
			const conversation = randomUUID();
			const a = await insertAs(USER, ORG_A, draft(USER, ORG_A, conversation));
			const b = await insertAs(USER, ORG_B, draft(USER, ORG_B, conversation));
			expect(a).not.toBe(b);
			expect(await rowsOf(conversation)).toEqual(
				[`${USER}/${ORG_A}`, `${USER}/${ORG_B}`].sort(),
			);
			// The key itself still refuses a second row for one (user, org, conversation).
			const dup = await refusalText(() =>
				insertAs(USER, ORG_A, draft(USER, ORG_A, conversation)),
			);
			expect(dup).toMatch(/uq_elench_drafts_key/);
		},
	);

	// ── 5. The owner-pinned functions ──────────────────────────────────────────────────────────

	it.skipIf(!APP_ROLE_DISTINCT)(
		"the count and the purge reach the caller's rows in every org, and never another user's",
		async () => {
			const conversation = randomUUID();
			await insertAs(USER, ORG_A, draft(USER, ORG_A, conversation));
			await insertAs(USER, ORG_B, draft(USER, ORG_B, conversation));
			// A teammate's draft under the SAME conversation id, in the caller's own org.
			await insertAs(MATE, ORG_A, draft(MATE, ORG_A, conversation));

			expect(await callAs("count", USER, ORG_A, conversation)).toBe(2);
			expect(await callAs("count", MATE, ORG_A, conversation)).toBe(1);

			expect(await callAs("purge", USER, ORG_A, conversation)).toBe(2);
			// Both of USER's rows are gone, across orgs; the teammate's row is untouched.
			expect(await rowsOf(conversation)).toEqual([`${MATE}/${ORG_A}`]);
			expect(await callAs("purge", USER, ORG_B, conversation)).toBe(0);
			expect(await callAs("count", MATE, ORG_A, conversation)).toBe(1);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"the count skips a discarded draft in another org, and the purge still removes it (#5855)",
		async () => {
			const conversation = randomUUID();
			await insertAs(USER, ORG_A, draft(USER, ORG_A, conversation));
			// The caller's draft of the same conversation in a SECOND org, discarded: not unsent.
			await insertAs(USER, ORG_B, {
				...draft(USER, ORG_B, conversation),
				status: "discarded",
				discarded_at: new Date(),
			});
			expect(await rowsOf(conversation)).toEqual(
				[`${USER}/${ORG_A}`, `${USER}/${ORG_B}`].sort(),
			);

			// From either org's scope, only the active draft in org A is counted.
			expect(await callAs("count", USER, ORG_A, conversation)).toBe(1);
			expect(await callAs("count", USER, ORG_B, conversation)).toBe(1);

			// Deleting the thread still removes the discarded row along with the active one.
			expect(await callAs("purge", USER, ORG_A, conversation)).toBe(2);
			expect(await rowsOf(conversation)).toEqual([]);
		},
	);

	// ── 6. EXECUTE is not PUBLIC's ─────────────────────────────────────────────────────────────

	it("a role with no grant cannot execute either function", async () => {
		const stranger = `elench_stranger_${randomUUID().replaceAll("-", "")}`;
		await inRolledBackTx(async (tx) => {
			await tx.execute(sql.raw(`CREATE ROLE ${stranger} NOLOGIN`));
			await tx.execute(sql.raw(`SET LOCAL ROLE ${stranger}`));
			for (const fn of [
				"purge_elench_drafts_of_conversation",
				"count_elench_drafts_of_conversation",
			]) {
				const text = await refusalText(() =>
					tx.transaction((sp) =>
						sp.execute(sql`select ${sql.raw(`public.${fn}`)}(${randomUUID()}::uuid)`),
					),
				);
				expect(text).toMatch(/permission denied for function/);
			}
		});
	});

	// ── 7. A11: forced row security raises, it does not filter ─────────────────────────────────

	it("the purge raises instead of filtering when row security is forced", async () => {
		const conversation = randomUUID();
		const owner = `elench_owner_${randomUUID().replaceAll("-", "")}`;

		/**
		 * Hand the table and the purge to a NOLOGIN role with neither SUPERUSER nor BYPASSRLS. That is
		 * the case A11 is about: such an owner bypasses a policy only while it is not forced. (A
		 * superuser or BYPASSRLS owner, as the CI migration role is, ignores FORCE altogether — so the
		 * ownership change is what makes FORCE mean anything here.)
		 */
		async function handOver(tx: Tx): Promise<void> {
			await tx.execute(sql.raw(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`));
			await tx.execute(sql.raw(`ALTER TABLE public.elench_drafts OWNER TO ${owner}`));
			await tx.execute(
				sql.raw(
					`ALTER FUNCTION public.purge_elench_drafts_of_conversation(uuid) OWNER TO ${owner}`,
				),
			);
		}

		// Control: the same owner, NOT forced — the owner bypasses the policy, so the purge reaches
		// both of USER's orgs from org A's scope. Without this, the raise below could be any error.
		await inRolledBackTx(async (tx) => {
			await seedThreeInTx(tx, conversation);
			await handOver(tx);
			await scopeTx(tx, USER, ORG_A);
			expect(await purgeInTx(tx, conversation)).toBe(2);
		});

		// Forced: the owner is now subject to the policy, which would show it only org A's row. With
		// `row_security = off` Postgres refuses the query rather than purge one org and report success.
		await inRolledBackTx(async (tx) => {
			await seedThreeInTx(tx, conversation);
			await handOver(tx);
			await tx.execute(sql`ALTER TABLE public.elench_drafts FORCE ROW LEVEL SECURITY`);
			await scopeTx(tx, USER, ORG_A);
			const text = await refusalText(() => tx.transaction((sp) => purgeInTx(sp, conversation)));
			expect(text).toMatch(/would be affected by row-level security policy/);
			// Nothing was purged: all three rows are still there inside this transaction.
			const left = await tx
				.select({ id: elenchDrafts.id })
				.from(elenchDrafts)
				.where(eq(elenchDrafts.conversation_id, conversation));
			expect(left).toHaveLength(3);
		});

		// Both transactions rolled back: no row, no role and no ownership change survives.
		expect(await rowsOf(conversation)).toEqual([]);
	});
});
