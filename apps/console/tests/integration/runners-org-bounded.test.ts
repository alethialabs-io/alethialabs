// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runner reads and writes are bounded to the addressed organization.
//
// The `runners` RLS policies admit a row when its `org_id` is the addressed org or the caller's
// personal org. This drives that through the real runner server actions on the RLS-enforced app
// role, with the real PDP:
//
//   * U acts in org A and in a personal org; W acts in org B. Org B holds a self runner with U's id
//     in `user_id`. Scoped to A or to U's personal org, it is outside the addressed organization: it
//     is not listed, counted, offered for selection, renamed or removed. Scoped to B, W reaches it.
//   * A self runner in U's personal org (org_id = user_id) is listed from every scope of U's.
//   * A managed (platform-fleet) runner has no owner and no org: no tenant scope sees it, and the
//     runner-token claim RPC — which does not run on the app role — serves the org's own runner.

import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": "/" }),
	cookies: async () => ({ get: () => undefined }),
}));

import {
	getAvailableRunners,
	getOnlineRunnerCount,
	getRunnersWithReleases,
	registerRunner,
	removeRunner,
	setDefaultRunner,
} from "@/app/server/actions/runners";
import { runWithActor } from "@/lib/authz/actor-context";
import { readRunnersData, readRunnersPage } from "@/lib/rpc/procedures/runners";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import { grants, jobs, member, organization, runners, user } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const U = randomUUID();
const W = randomUUID();
const A = randomUUID();
const B = randomUUID();
const TOKEN_B = `token-${randomUUID()}`;

const inA: Actor = { credential: "session", userId: U, orgId: A };
const inPersonal: Actor = { credential: "session", userId: U, orgId: U };
const asW: Actor = { credential: "session", userId: W, orgId: B };

let runnerA = ""; // self, org A, U
let runnerB = ""; // self, org B, U's id
let runnerPersonal = ""; // self, U's personal org
let runnerManaged = ""; // managed: no owner, no org
const registered: string[] = [];

/** Runs `fn` as `actor`, the way the server actions bind one. */
const as = <T>(actor: Actor, fn: () => Promise<T>) => runWithActor(actor, fn);

/** The SHA-256 the runner auth path stores for a runner token. */
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Grants `role` on the whole of `org` to `who`. */
async function grant(org: string, who: string, role: string) {
	await getServiceDb().insert(grants).values({
		org_id: org,
		principal_type: "user",
		principal_id: who,
		effect: "allow",
		role_id: role,
		resource_type: "org",
		resource_id: null,
	});
}

/** Ids of the runners `actor` sees through each listing action. */
async function seen(actor: Actor) {
	const listed = await as(actor, () => getRunnersWithReleases());
	const available = await as(actor, () => getAvailableRunners());
	return { listed: listed.map((r) => r.id), available: available.map((r) => r.id) };
}

describeIfDb("runner reads and writes are bounded to the addressed organization", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: U, email: `ru-${U}@example.test` },
			{ id: W, email: `rw-${W}@example.test` },
		]);
		await db.insert(organization).values([
			{ id: A, name: `ra-${A.slice(0, 8)}`, slug: `ra-${A.slice(0, 8)}` },
			{ id: B, name: `rb-${B.slice(0, 8)}`, slug: `rb-${B.slice(0, 8)}` },
			{ id: U, name: `ru-personal-${U.slice(0, 8)}` },
		]);
		await db.insert(member).values([
			{ organizationId: A, userId: U, role: "owner" },
			{ organizationId: B, userId: W, role: "owner" },
		]);
		await grant(A, U, BUILTIN_ROLE_IDS.owner);
		await grant(U, U, BUILTIN_ROLE_IDS.owner);
		await grant(B, W, BUILTIN_ROLE_IDS.owner);

		const rows = await db
			.insert(runners)
			.values([
				{ user_id: U, org_id: A, name: `ra-${A.slice(0, 6)}`, operator: "self", provisioning: "registered", token_hash: hashToken(randomUUID()), status: "ONLINE" },
				{ user_id: U, org_id: B, name: `rb-${B.slice(0, 6)}`, operator: "self", provisioning: "registered", token_hash: hashToken(TOKEN_B), status: "ONLINE" },
				{ user_id: U, org_id: U, name: `rp-${U.slice(0, 6)}`, operator: "self", provisioning: "registered", token_hash: hashToken(randomUUID()), status: "ONLINE" },
				{ name: `rm-${U.slice(0, 6)}`, operator: "managed", token_hash: hashToken(randomUUID()), status: "ONLINE" },
			])
			.returning({ id: runners.id });
		[runnerA, runnerB, runnerPersonal, runnerManaged] = rows.map((r) => r.id);
	});

	afterAll(async () => {
		const db = getServiceDb();
		const ids = [runnerA, runnerB, runnerPersonal, runnerManaged, ...registered].filter(Boolean);
		await db.delete(jobs).where(inArray(jobs.org_id, [A, B, U]));
		await db.delete(runners).where(inArray(runners.id, ids));
		await db.delete(grants).where(inArray(grants.org_id, [A, B, U]));
		await db.delete(member).where(inArray(member.organizationId, [A, B]));
	});

	it("org A lists its runners and the caller's personal runner, nothing outside it", async () => {
		const { listed, available } = await seen(inA);
		for (const ids of [listed, available]) {
			expect(ids).toContain(runnerA);
			expect(ids).toContain(runnerPersonal);
			expect(ids).not.toContain(runnerB);
			expect(ids).not.toContain(runnerManaged);
		}
		expect(await as(inA, () => getOnlineRunnerCount())).toBe(2);
	});

	it("the personal scope lists the personal runner, nothing outside it", async () => {
		const { listed, available } = await seen(inPersonal);
		for (const ids of [listed, available]) {
			expect(ids).toContain(runnerPersonal);
			expect(ids).not.toContain(runnerA);
			expect(ids).not.toContain(runnerB);
			expect(ids).not.toContain(runnerManaged);
		}
	});

	it("scoped to org B, B's runner is reachable", async () => {
		const { listed } = await seen(asW);
		expect(listed).toContain(runnerB);
		expect(listed).not.toContain(runnerA);
		expect(listed).not.toContain(runnerPersonal);
		expect(listed).not.toContain(runnerManaged);
	});

	it("a runner outside the addressed organization is unaffected by update and remove", async () => {
		for (const actor of [inA, inPersonal]) {
			const renamed = await withActorScope(actor, (tx) =>
				tx.update(runners).set({ name: "renamed" }).where(eq(runners.id, runnerB)).returning({ id: runners.id }),
			);
			expect(renamed).toHaveLength(0);
			await expect(as(actor, () => removeRunner(runnerB))).rejects.toThrow("Runner not found");
		}
		const [row] = await getServiceDb()
			.select({ name: runners.name })
			.from(runners)
			.where(eq(runners.id, runnerB));
		expect(row?.name).toBe(`rb-${B.slice(0, 6)}`);
	});

	it("a runner is registered into the addressed org, or the personal org from the personal scope", async () => {
		const inOrg = await as(inA, () => registerRunner(`reg-a-${randomUUID().slice(0, 6)}`));
		const personal = await as(inPersonal, () => registerRunner(`reg-p-${randomUUID().slice(0, 6)}`));
		registered.push(inOrg.runner.id, personal.runner.id);
		const rows = await getServiceDb()
			.select({ id: runners.id, org_id: runners.org_id })
			.from(runners)
			.where(inArray(runners.id, [inOrg.runner.id, personal.runner.id]));
		const org = new Map(rows.map((r) => [r.id, r.org_id]));
		expect(org.get(inOrg.runner.id)).toBe(A);
		expect(org.get(personal.runner.id)).toBe(U);

		// And it is removable from where it was registered.
		await as(inPersonal, () => removeRunner(personal.runner.id));
		const left = await getServiceDb()
			.select({ id: runners.id })
			.from(runners)
			.where(eq(runners.id, personal.runner.id));
		expect(left).toHaveLength(0);
	});

	it("a default runner is chosen within the addressed organization", async () => {
		const isDefault = async () => {
			const rows = await getServiceDb()
				.select({ id: runners.id, is_default: runners.is_default })
				.from(runners)
				.where(inArray(runners.id, [runnerA, runnerB, runnerPersonal]));
			return new Map(rows.map((r) => [r.id, r.is_default]));
		};

		await as(inA, () => setDefaultRunner(runnerA));
		await as(inPersonal, () => setDefaultRunner(runnerPersonal));
		let d = await isDefault();
		// One default per org: choosing the personal one leaves org A's in place.
		expect(d.get(runnerA)).toBe(true);
		expect(d.get(runnerPersonal)).toBe(true);

		// The lists read "default" as the addressed org's: org A's list stars only A's runner, and
		// marks the personal runner as one whose default is chosen in the personal workspace.
		const listed = await as(inA, () => getRunnersWithReleases());
		expect(listed.filter((r) => r.is_default).map((r) => r.id)).toEqual([runnerA]);
		expect(listed[0]?.id).toBe(runnerA);
		const personalRow = listed.find((r) => r.id === runnerPersonal);
		expect(personalRow?.is_default).toBe(false);
		expect(personalRow?.personal_elsewhere).toBe(true);
		expect(listed.find((r) => r.id === runnerA)?.personal_elsewhere).toBe(false);
		const available = await as(inA, () => getAvailableRunners());
		expect(available.filter((r) => r.is_default).map((r) => r.id)).toEqual([runnerA]);
		// From the personal workspace, its own default is the starred one.
		const fromPersonal = await as(inPersonal, () => getRunnersWithReleases());
		expect(fromPersonal.filter((r) => r.is_default).map((r) => r.id)).toEqual([runnerPersonal]);
		expect(fromPersonal.every((r) => !r.personal_elsewhere)).toBe(true);

		// A runner outside the addressed organization cannot be chosen, and nothing changes.
		await expect(as(inA, () => setDefaultRunner(runnerB))).rejects.toMatchObject({
			cause: { message: "Runner not found in this organization" },
		});
		d = await isDefault();
		expect(d.get(runnerB)).toBe(false);
		expect(d.get(runnerA)).toBe(true);

		// Clearing applies to the addressed org alone.
		await as(inA, () => setDefaultRunner(null));
		d = await isDefault();
		expect(d.get(runnerA)).toBe(false);
		expect(d.get(runnerPersonal)).toBe(true);
	});

	it("a managed runner is visible to no tenant scope and is untouched", async () => {
		for (const actor of [inA, inPersonal, asW]) {
			const rows = await withActorScope(actor, (tx) =>
				tx.select({ id: runners.id }).from(runners).where(eq(runners.id, runnerManaged)),
			);
			expect(rows).toHaveLength(0);
		}
		const [row] = await getServiceDb()
			.select({ operator: runners.operator, org_id: runners.org_id, user_id: runners.user_id })
			.from(runners)
			.where(eq(runners.id, runnerManaged));
		expect(row).toEqual({ operator: "managed", org_id: null, user_id: null });
	});

	it("the runner-token claim serves the org's own runner (it does not run on the app role)", async () => {
		const db = getServiceDb();
		const [job] = await db
			.insert(jobs)
			.values({
				user_id: W,
				org_id: B,
				job_type: "DEPLOY_RUNNER",
				status: "QUEUED",
				config_snapshot: {},
				assigned_runner_id: runnerB,
			})
			.returning({ id: jobs.id });
		const claimed = await db.execute<{ id: string }>(
			sql`select id from claim_next_job(${runnerB}::uuid, ${hashToken(TOKEN_B)}, null::uuid)`,
		);
		expect(claimed.map((r) => r.id)).toEqual([job.id]);
	});

	it("the runners page's reads (#6123) are org-bounded and carry no runner credential", async () => {
		const hashes = (
			await getServiceDb()
				.select({ hash: runners.token_hash })
				.from(runners)
				.where(inArray(runners.id, [runnerA, runnerB, runnerPersonal, runnerManaged]))
		).map((r) => r.hash);
		expect(hashes).toHaveLength(4);

		const data = await as(inA, () => readRunnersData());
		const page = await as(inA, () => readRunnersPage({}));
		const ids = data.runners.map((r) => r.id);
		expect(ids).toContain(runnerA);
		expect(ids).toContain(runnerPersonal);
		expect(ids).not.toContain(runnerB);
		expect(page.rows.map((r) => r.id)).not.toContain(runnerB);

		// Not one byte of any runner's stored credential hash — the org's own, another org's, the
		// managed fleet's (listed on a self-managed deployment) — is in either answer.
		const wire = JSON.stringify([data, page]);
		for (const hash of hashes) expect(wire).not.toContain(hash);
		expect(wire).not.toContain("token_hash");
	});
});
