// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the defense-in-depth enqueue guard `assertRunnerInOrg` against real
// Postgres. Seeds two orgs, each with a self-operated runner, and proves the guard
// mirrors claim_next_job's admission EXACTLY: it ACCEPTS an in-org self runner AND a
// managed (org_id NULL) platform-fleet runner (both claimable), and REJECTS a
// different-tenant self runner and a non-existent runner id (same rejection — no
// cross-tenant disclosure).
//
// The runner's owning org is read from `runners.org_id` — the SAME column
// claim_next_job compares against `v_runner_org_id` — so this exercises the exact
// notion of "the runner's org" the execution guard uses. `org_id` is backfilled to
// `user_id` by the set_org_id trigger on insert, which this test also asserts.
//
// The file also covers `resolveUnassignedRunnerJobOrg` (#4022) — the same "which org does this
// job take" question asked where NO runner is named, so there is no row to read it from. It sits
// here, on the same fixture, because both answers must agree with the same claim predicate.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRunnerInOrg, resolveUnassignedRunnerJobOrg } from "@/lib/authz/runner-org";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { runners } from "@/lib/db/schema";
import { describeIfDb, seedManagedRunner } from "./db";

// Community model: org_id === user_id (backfilled by the set_org_id trigger).
const ORG_A = randomUUID();
const ORG_B = randomUUID();

/**
 * A user who belongs to TWO orgs — their personal one (their own id) and a Teams org. This
 * is the shape the no-backfill ruling turns on: `runnerPersonal` is stamped with the personal
 * org by the trigger (as every pre-#3874 CLI deploy was), while the user now acts in TEAM_ORG.
 */
const USER_MULTI = randomUUID();
const TEAM_ORG = randomUUID();

let runnerA: string;
let runnerB: string;
let managedRunner: string;
let runnerPersonal: string;
let runnerTeam: string;

/** Inserts a self-operated runner owned by `userId`; org_id backfills to user_id. */
async function seedSelfRunner(userId: string, name: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: userId,
			name,
			operator: "self", // self ⇒ user_id NOT NULL + provisioning NOT NULL (CHECKs)
			provisioning: "registered",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	// The set_org_id trigger must backfill org_id = user_id — the org notion the
	// claim guard (v_runner_org_id) and this validator both key on.
	expect(row.org_id).toBe(userId);
	return row.id;
}

/**
 * Inserts a self-operated runner stamped with an EXPLICIT org — the shape #3874 writes from
 * now on (the CLI deploy route sets org_id itself, since getServiceDb() sets no GUC for the
 * trigger to read). The explicit value must survive: the trigger only fills a NULL.
 */
async function seedTeamRunner(
	userId: string,
	orgId: string,
	name: string,
): Promise<string> {
	const [row] = await getServiceDb()
		.insert(runners)
		.values({
			user_id: userId,
			org_id: orgId,
			name,
			operator: "self",
			provisioning: "deployed",
			token_hash: `hash-${name}`,
			status: "OFFLINE",
		})
		.returning({ id: runners.id, org_id: runners.org_id });
	// The trigger fires `IF NEW.org_id IS NULL` only, so an explicit stamp is authoritative.
	// If this ever fails, the deploy route's explicit org_id is being overwritten and every
	// forward-stamped runner is silently back in a personal org.
	expect(row.org_id).toBe(orgId);
	return row.id;
}

/** Thrown to roll a probe transaction back. Never escapes {@link resolveWithEmptyManagedPool}. */
class RollbackProbe extends Error {}

/**
 * Resolves with the MANAGED pool emptied, inside a transaction that ALWAYS rolls back.
 *
 * The managed probe is a property of the whole `runners` table, not of one caller's fleet — a
 * managed runner belongs to no tenant and its Phase B arm ignores org — so a resolution that must
 * be read with the pool empty cannot be arranged by choosing ids. THIS FIXTURE'S OWN `beforeAll`
 * seeds `managedRunner`, and other files sharing this database may seed more, so an assertion
 * about the empty-pool arm written against the live table would be answering a question about
 * whichever rows happened to exist. The delete is real inside the transaction and discarded on the
 * way out, so nothing another test can observe ever changes.
 *
 * The rollback is a sentinel error rather than `tx.rollback()` because drizzle's own rollback
 * signal is a driver-level detail; a class declared here is unambiguous, and a failure that is NOT
 * the sentinel is rethrown rather than swallowed into a pass.
 */
async function resolveWithEmptyManagedPool(
	orgId: string,
	personalOrgId: string,
): Promise<string> {
	// An array rather than a `let … | null`: the assignment happens inside a callback, where
	// TypeScript's control-flow narrowing does not follow it, so a nullable local would read as
	// `null` at the check below and as `never` after it.
	const answer: string[] = [];
	try {
		await getServiceDb().transaction(async (tx) => {
			await tx.delete(runners).where(eq(runners.operator, "managed"));
			answer.push(await resolveUnassignedRunnerJobOrg(tx, orgId, personalOrgId));
			throw new RollbackProbe();
		});
	} catch (e: unknown) {
		if (!(e instanceof RollbackProbe)) throw e;
	}
	// A probe that never reached the resolver would otherwise hand back a value that reads like
	// an answer. There is no "no result" branch: this throws rather than reporting one.
	if (answer.length !== 1)
		throw new Error(
			`probe transaction resolved ${answer.length} orgs, expected exactly 1`,
		);
	return answer[0];
}

describeIfDb("assertRunnerInOrg (defense-in-depth enqueue guard)", () => {
	beforeAll(async () => {
		runnerA = await seedSelfRunner(ORG_A, `it-runner-a-${ORG_A.slice(0, 8)}`);
		runnerB = await seedSelfRunner(ORG_B, `it-runner-b-${ORG_B.slice(0, 8)}`);
		managedRunner = await seedManagedRunner(`it-managed-${ORG_A.slice(0, 8)}`);
		// LET THE TRIGGER STAMP IT. Writing `org_id: USER_MULTI` by hand would only prove a test
		// can type a uuid twice; seeding it the way production seeded it proves the row this
		// allowance exists for is the row the database actually produces.
		runnerPersonal = await seedSelfRunner(
			USER_MULTI,
			`it-runner-personal-${USER_MULTI.slice(0, 8)}`,
		);
		runnerTeam = await seedTeamRunner(
			USER_MULTI,
			TEAM_ORG,
			`it-runner-team-${TEAM_ORG.slice(0, 8)}`,
		);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(runners).where(eq(runners.id, runnerA));
		await db.delete(runners).where(eq(runners.id, runnerB));
		await db.delete(runners).where(eq(runners.id, managedRunner));
		await db.delete(runners).where(eq(runners.id, runnerPersonal));
		await db.delete(runners).where(eq(runners.id, runnerTeam));
	});

	it("ACCEPTS a runner that belongs to the caller's org, and RETURNS its org", async () => {
		// The return value is not decoration: the DESTROY_RUNNER enqueue stamps `jobs.org_id`
		// with it (#3874), so a guard that validated and then discarded the org would leave the
		// caller to guess — and guessing `actor.orgId` is the QUEUED-forever defect.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerA, ORG_A),
		).resolves.toBe(ORG_A);
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, ORG_B),
		).resolves.toBe(ORG_B);
	});

	it("REJECTS a runner owned by another org (cross-tenant assignment)", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerA, ORG_B),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("REJECTS a non-existent runner id with the SAME error (no disclosure)", async () => {
		await expect(
			assertRunnerInOrg(getServiceDb(), randomUUID(), ORG_A),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("ACCEPTS a managed (org_id NULL) runner for any tenant — mirrors claim_next_job's `v_operator='managed'` admission", async () => {
		// A managed platform-fleet runner belongs to no tenant and assumes-role into the
		// job's own org at run time, so pinning to it is legitimate for any caller — the
		// enqueue guard must not be stricter than the claim guard that would accept it.
		// It returns NULL rather than the caller's org: null is what `runners.org_id` holds, and
		// the enqueue site falls back to the actor's org on it (a managed runner assumes-role
		// into the job's own org, so any org's job is claimable — claim_next_job Phase A's
		// `v_operator = 'managed'` arm).
		await expect(
			assertRunnerInOrg(getServiceDb(), managedRunner, ORG_A),
		).resolves.toBeNull();
		await expect(
			assertRunnerInOrg(getServiceDb(), managedRunner, ORG_B),
		).resolves.toBeNull();
	});

	// ── The transitional personal-org admission (#3874) ──────────────────────────────────
	//
	// #3874 stamps org_id FORWARD ONLY: the maintainer's ruling refuses a backfill, so every
	// runner the CLI deployed before it keeps `org_id = user_id` — the deployer's personal
	// org. `runnerPersonal` below is exactly that row: seeded with no explicit org_id so the
	// set_org_id trigger stamps user_id, the same way production did. A member of a Teams org
	// calling with `orgId = TEAM_ORG` must still be able to destroy it, or the no-backfill
	// ruling makes every historical runner permanently undestroyable.
	//
	// The allowance is an ADMISSION, not a relaxation, and the third-org case below is the
	// assertion that says so: `personalOrgId` is the caller's own id, proven by the CLI token,
	// so it can only ever admit rows the caller already owns. Without that test "transitional
	// allowance" and "accept anything" are indistinguishable from the outside.
	it("ACCEPTS the caller's PERSONAL org when personalOrgId is passed — the pre-#3874 runner stays destroyable", async () => {
		// USER_MULTI's personal org is their own id; TEAM_ORG is the org they act in today.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerPersonal, TEAM_ORG, USER_MULTI),
		).resolves.toBe(USER_MULTI);
	});

	it("REFUSES that same runner when personalOrgId is NOT passed (call sites opt in)", async () => {
		// The deploy route deliberately does not opt in — it stamps its job `actor.orgId`, so
		// admitting a personal-org runner there would queue a job nothing can ever claim.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerPersonal, TEAM_ORG),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	it("ACCEPTS the ACTIVE org's runner under the same call shape", async () => {
		// The allowance must not have replaced the ordinary arm: a runner stamped with the team
		// org — what #3874 writes from now on — is still admitted, and returns the team org.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerTeam, TEAM_ORG, USER_MULTI),
		).resolves.toBe(TEAM_ORG);
	});

	it("STILL REFUSES a THIRD org's runner with the allowance in play — it is an admission, not `accept anything`", async () => {
		// runnerB belongs to ORG_B: neither the caller's active org nor their personal org.
		// If this ever passes, the transitional allowance has become a hole in tenancy.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, TEAM_ORG, USER_MULTI),
		).rejects.toBeInstanceOf(ForbiddenError);
		// And the personal org is not a skeleton key in the other direction either: the caller
		// cannot reach ORG_B's runner by naming their own personal org as the active one.
		await expect(
			assertRunnerInOrg(getServiceDb(), runnerB, USER_MULTI, USER_MULTI),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	// ── `resolveUnassignedRunnerJobOrg` — the same question with no runner to ask (#4022) ────
	//
	// Every enqueue that NAMES an executor stamps the job with the value `assertRunnerInOrg`
	// returns above. One that names none has no row to read, and the actor's org was taken to
	// be the safe answer on the reading that `claim_next_job` Phase B is org-agnostic. Only its
	// MANAGED arm is; the `ELSE` arm a self runner takes repeats Phase A's equality, so for a
	// caller whose fleet is entirely pre-#3874 that answer was unclaimable by every runner they
	// had — QUEUED forever, no error.
	//
	// The resolver reads the fleet instead, and these live in THIS describe, on THIS fixture,
	// because the property they pin is one no mock can: the scan sees the caller's two
	// admissible orgs and nothing else, while ORG_A / ORG_B / USER_MULTI's pair sit in the same
	// table as third parties.
	it("resolve: prefers the ACTIVE org when a self runner of that org exists (mixed-vintage fleet)", async () => {
		// USER_MULTI holds both vintages. `runnerTeam` can claim a TEAM_ORG job, so the
		// forward-correct tenancy is kept and the legacy row does not drag the stamp back.
		await expect(
			resolveUnassignedRunnerJobOrg(getServiceDb(), TEAM_ORG, USER_MULTI),
		).resolves.toBe(TEAM_ORG);
	});

	it("resolve: falls to the PERSONAL org when the fleet is pre-#3874 and there is NO managed pool", async () => {
		// The #4022 failing input, built the way production built it: the trigger stamps the
		// personal org, and the caller then acts in a Teams org they have no runner in.
		//
		// It runs with the managed pool emptied, and that condition is the finding rather than a
		// fixture detail. A self-only scan called this a STRICT improvement; it is not, wherever a
		// managed runner exists, because Phase B's managed arm has no org predicate and would have
		// claimed the active-org stamp. So the personal org is only correct when nothing at all
		// can take the other value — which is the case this arranges, and the case below is its
		// twin with the single missing row put back.
		const legacyUser = randomUUID();
		const legacyRunner = await seedSelfRunner(
			legacyUser,
			`it-4022-legacy-${legacyUser.slice(0, 8)}`,
		);
		try {
			await expect(
				resolveWithEmptyManagedPool(randomUUID(), legacyUser),
			).resolves.toBe(legacyUser);
		} finally {
			await getServiceDb().delete(runners).where(eq(runners.id, legacyRunner));
		}
	});

	it("resolve: KEEPS the active org on that same fleet once a managed runner exists", async () => {
		// The control for the case above, and the review finding stated as a test. The fleet is
		// identical — one pre-#3874 self runner, a Teams org the caller has none in — and the only
		// difference is `managedRunner`, seeded by this file's beforeAll and left in place here.
		// Moving the stamp anyway would cost the job `plan_priority('team') + 2 = 12` → `2`, a
		// concurrency cap of 8 → 2, and the paid exemption from the 25/24h job quota, in exchange
		// for nothing: the managed arm could always claim it.
		const legacyUser = randomUUID();
		const legacyRunner = await seedSelfRunner(
			legacyUser,
			`it-4022-managed-${legacyUser.slice(0, 8)}`,
		);
		const activeOrg = randomUUID();
		try {
			// The premise, asserted rather than assumed — this case means nothing if the pool the
			// beforeAll seeded is not actually there.
			const [managed] = await getServiceDb()
				.select({ id: runners.id })
				.from(runners)
				.where(eq(runners.id, managedRunner))
				.limit(1);
			expect(managed?.id).toBe(managedRunner);

			await expect(
				resolveUnassignedRunnerJobOrg(getServiceDb(), activeOrg, legacyUser),
			).resolves.toBe(activeOrg);
			// Named explicitly, because it is the value the earlier reading produced.
			await expect(
				resolveUnassignedRunnerJobOrg(getServiceDb(), activeOrg, legacyUser),
			).resolves.not.toBe(legacyUser);
		} finally {
			await getServiceDb().delete(runners).where(eq(runners.id, legacyRunner));
		}
	});

	it("resolve: keeps the ACTIVE org when the caller has no self runner at all", async () => {
		// An empty fleet has nothing to satisfy, so the job keeps the forward-correct tenancy.
		// This is also the tenancy assertion: other tenants' runners exist right now — ORG_A's,
		// ORG_B's and USER_MULTI's pair — and a scan that widened past the caller's two admissible
		// orgs would return one of theirs instead. It runs with the managed pool EMPTIED so the
		// answer is the empty-fleet arm rather than the managed one arriving at the same value for
		// a different reason; a test that cannot tell two arms apart pins neither.
		const orphanOrg = randomUUID();
		await expect(
			resolveWithEmptyManagedPool(orphanOrg, randomUUID()),
		).resolves.toBe(orphanOrg);
	});

	it("resolve: answers without reading the fleet when the two orgs are the same value", async () => {
		// A community/personal caller: `orgId === personalOrgId`, so there is nothing to choose
		// between. ORG_A has a runner and ORG_B's exists too; neither can change this answer.
		await expect(
			resolveUnassignedRunnerJobOrg(getServiceDb(), ORG_A, ORG_A),
		).resolves.toBe(ORG_A);
	});
});
