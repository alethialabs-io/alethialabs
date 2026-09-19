// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Direct-DB seeding for the Navigation-shell specs. One precondition lives here, and it is the
// only one the shell has that the UI cannot produce: whether the org's sidebar advertises Runners.
//
// WHY THE NAV NEEDS A SEED AT ALL. `buildSidebarNav` appends the Runners row only when
// `capabilities.selfRunners` is true, and that capability is derived server-side, per request, in
// `app/(private)/[org]/layout.tsx` → `orgHasSelfRunners(orgId)` → "does this org own a `runners`
// row with `operator = 'self'`". So the two branches of the nav are two DATABASE states, and a spec
// that only ever measured the org as it happens to be measures one of them and reports on both.
//
// WHY IT IS ITS OWN FILE. `helpers/seed.ts` is owned by the seams and is not a lane's to edit
// (e2e/AUTHORING.md); a domain that needs rows the shared helper does not give it adds
// `helpers/seed-<domain>.ts`. Precedent: `helpers/seed-alerts.ts`.
//
// ── THE ISOLATION RULE THIS FILE OBEYS, AND WHY IT IS NARROWER THAN seed-alerts.ts's ─────────────
//
// `seed-alerts.ts` may clean its whole domain for an org, because nothing else in the suite writes
// alerting rows. The `runners` table is the opposite case: `flows/runners.spec.ts` and
// `flows/runners.negative.spec.ts` both seed and purge self-operated runners, by name prefix, in
// the **team** persona's org — and the suite is `fullyParallel`. So:
//
//   · every row minted here is uniquely named (`e2e-nav-runner-…`) and removed BY ID, never by
//     prefix and never by org. A purge here would delete a sibling spec's fixture mid-test;
//   · the ON branch is seeded into the **owner** (Hobby) org, which no other spec inserts a runner
//     into — `runners.negative.spec.ts` uses the Hobby persona only to read the entitlement upsell,
//     which does not depend on any row existing. That is what makes the OFF branch a real baseline
//     rather than an assumption;
//   · `orgHasSelfRunner` reads the SAME predicate the console does, so a spec can assert the
//     precondition it depends on instead of trusting that it holds.
//
// The rows are otherwise inert: nothing claims a job for a runner that never heartbeats, and the
// personas are per-run accounts in a throwaway CI database.

import { db } from "./db";
import type { Owner } from "./seed";

/** A runner row this helper minted, with everything a caller needs to remove it again. */
export interface SeededNavRunner {
	id: string;
	name: string;
}

/**
 * Inserts one OFFLINE, self-operated runner for the org, which is exactly what flips
 * `orgHasSelfRunners(orgId)` — and therefore the sidebar's Runners row — to true.
 *
 * `operator: "self"` is the load-bearing field: a `managed` runner is an internal (support-admin)
 * surface and deliberately does NOT raise the capability, so seeding one would leave the nav
 * unchanged and the test would report the wrong reason for a green.
 */
export async function seedSelfRunner(
	owner: Owner,
	opts: { name?: string } = {},
): Promise<SeededNavRunner> {
	const sql = db();
	const name = opts.name ?? `e2e-nav-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [row] = await sql<{ id: string }[]>`
		insert into runners ${sql({
			user_id: owner.userId,
			org_id: owner.orgId,
			name,
			operator: "self",
			provisioning: "registered",
			token_hash: `e2e-nav-hash-${Math.random().toString(36).slice(2)}`,
			status: "OFFLINE",
			is_default: false,
			metadata: sql.json({}),
		})}
		returning id`;
	return { id: row.id, name };
}

/**
 * Removes one seeded runner BY ID. Deliberately not "remove the org's runners": a sibling spec's
 * fixture must survive this call, and a broad delete is how a shared persona org loses the floor
 * from under a parallel test.
 */
export async function removeSelfRunner(runner: SeededNavRunner): Promise<void> {
	const sql = db();
	await sql`delete from runners where id = ${runner.id}`;
}

/**
 * The console's own predicate, read straight from the database: does this org own a self-operated
 * runner? `lib/queries/runner-capabilities.ts` asks exactly this, so a spec can state the
 * precondition it is measuring under rather than assuming the org is in the state it wants.
 */
export async function orgHasSelfRunner(orgId: string): Promise<boolean> {
	const sql = db();
	const rows = await sql<{ id: string }[]>`
		select id from runners where org_id = ${orgId} and operator = 'self' limit 1`;
	return rows.length > 0;
}
