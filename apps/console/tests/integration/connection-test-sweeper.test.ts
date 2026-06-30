// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the connection-test reliability SQL against real Postgres — the
// `fail_unclaimed_connection_tests` / `gc_pending_identities` SECURITY DEFINER sweepers
// (lib/db/programmables.sql) and the `finalizeConnectionTest` finalizer
// (lib/cloud-providers/connections.ts). The two global sweepers would mutate unrelated
// dev-DB rows, so each runs inside a transaction that is ALWAYS rolled back; assertions
// read within that tx. `finalizeConnectionTest` opens its own getServiceDb() connection
// (so it can't see uncommitted rows) — its identity is committed and cleaned up in
// afterAll. Rows are aged by setting created_at/updated_at explicitly at insert time.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { finalizeConnectionTest } from "@/lib/cloud-providers/connections";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID();
/** Thrown to force a transaction rollback once assertions have run. */
const ROLLBACK = Symbol("rollback");
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** A pending/testing cloud_identity fixture (only the NOT-NULL cols + what we assert). */
function identity(over: {
	id: string;
	name: string;
	status: "pending" | "testing" | "failed";
	updated_at?: Date;
}) {
	return {
		user_id: ORG,
		org_id: ORG,
		provider: "aws" as const,
		credentials: {},
		is_verified: false,
		...over,
	};
}

describeIfDb("connection-test reliability SQL", () => {
	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.org_id, ORG));
		await db.delete(cloudIdentities).where(eq(cloudIdentities.org_id, ORG));
	});

	it("fail_unclaimed_connection_tests fails only aged QUEUED CONNECTION_TEST jobs + their identity", async () => {
		const I1 = randomUUID();
		const I2 = randomUUID();
		const J1 = randomUUID();
		const J2 = randomUUID();
		const J3 = randomUUID();
		try {
			await getServiceDb().transaction(async (tx) => {
				await tx.insert(cloudIdentities).values([
					identity({ id: I1, name: "it-fail-aged", status: "testing" }),
					identity({ id: I2, name: "it-fail-fresh", status: "testing" }),
				]);
				await tx.insert(jobs).values([
					// Aged, unclaimed CONNECTION_TEST → should fail.
					{
						id: J1,
						user_id: ORG,
						org_id: ORG,
						job_type: "CONNECTION_TEST",
						status: "QUEUED",
						config_snapshot: {},
						cloud_identity_id: I1,
						created_at: minsAgo(10),
					},
					// Fresh CONNECTION_TEST (within the 5m TTL) → should survive.
					{
						id: J2,
						user_id: ORG,
						org_id: ORG,
						job_type: "CONNECTION_TEST",
						status: "QUEUED",
						config_snapshot: {},
						cloud_identity_id: I2,
					},
					// Aged but NOT a CONNECTION_TEST → out of scope, should survive.
					{
						id: J3,
						user_id: ORG,
						org_id: ORG,
						job_type: "FETCH_RESOURCES",
						status: "QUEUED",
						config_snapshot: {},
						cloud_identity_id: I1,
						created_at: minsAgo(10),
					},
				]);

				await tx.execute(sql`select fail_unclaimed_connection_tests()`);

				const job = async (id: string) =>
					(await tx.select().from(jobs).where(eq(jobs.id, id)))[0];
				const ident = async (id: string) =>
					(
						await tx.select().from(cloudIdentities).where(eq(cloudIdentities.id, id))
					)[0];

				const j1 = await job(J1);
				expect(j1.status).toBe("FAILED");
				expect(j1.error_message).toMatch(/no runner available/i);

				const i1 = await ident(I1);
				expect(i1.status).toBe("failed");
				expect(i1.last_error).toBeTruthy();
				expect(i1.is_verified).toBe(false);
				expect(i1.last_tested_at).not.toBeNull();

				// Boundary: the fresh test (and its identity) are untouched.
				expect((await job(J2)).status).toBe("QUEUED");
				expect((await ident(I2)).status).toBe("testing");
				// Scope: the aged non-CONNECTION_TEST job is untouched.
				expect((await job(J3)).status).toBe("QUEUED");

				throw ROLLBACK;
			});
		} catch (e) {
			if (e !== ROLLBACK) throw e;
		}
	});

	it("finalizeConnectionTest records both outcomes and is idempotent", async () => {
		const ID = randomUUID();
		const db = getServiceDb();
		await db
			.insert(cloudIdentities)
			.values(identity({ id: ID, name: "it-finalize", status: "testing" }));

		const read = async () =>
			(await db.select().from(cloudIdentities).where(eq(cloudIdentities.id, ID)))[0];

		await finalizeConnectionTest(ID, true);
		let row = await read();
		expect(row.is_verified).toBe(true);
		expect(row.status).toBe("connected");
		expect(row.last_error).toBeNull();
		expect(row.last_tested_at).not.toBeNull();

		// Idempotent: a second success leaves it connected (single row, no error).
		await finalizeConnectionTest(ID, true);
		row = await read();
		expect(row.is_verified).toBe(true);
		expect(row.status).toBe("connected");

		// Failure path persists the error and flips status back to failed.
		await finalizeConnectionTest(ID, false, { errorMessage: "boom" });
		row = await read();
		expect(row.status).toBe("failed");
		expect(row.last_error).toBe("boom");
	});

	it("gc_pending_identities deletes only aged, job-less pending identities", async () => {
		const P_OLD = randomUUID();
		const P_RECENT = randomUUID();
		const P_FAILED = randomUUID();
		const P_JOB = randomUUID();
		const JG = randomUUID();
		try {
			await getServiceDb().transaction(async (tx) => {
				await tx.insert(cloudIdentities).values([
					identity({
						id: P_OLD,
						name: "it-gc-old",
						status: "pending",
						updated_at: minsAgo(2),
					}),
					identity({ id: P_RECENT, name: "it-gc-recent", status: "pending" }),
					identity({
						id: P_FAILED,
						name: "it-gc-failed",
						status: "failed",
						updated_at: minsAgo(2),
					}),
					identity({
						id: P_JOB,
						name: "it-gc-has-job",
						status: "pending",
						updated_at: minsAgo(2),
					}),
				]);
				// A job referencing P_JOB keeps it alive even though it's aged + pending.
				await tx.insert(jobs).values({
					id: JG,
					user_id: ORG,
					org_id: ORG,
					job_type: "CONNECTION_TEST",
					status: "FAILED",
					config_snapshot: {},
					cloud_identity_id: P_JOB,
				});

				await tx.execute(sql`select gc_pending_identities(make_interval(secs => 1))`);

				const exists = async (id: string) =>
					(
						await tx
							.select({ id: cloudIdentities.id })
							.from(cloudIdentities)
							.where(eq(cloudIdentities.id, id))
					).length > 0;

				expect(await exists(P_OLD)).toBe(false); // aged + pending + no job → deleted
				expect(await exists(P_RECENT)).toBe(true); // too recent
				expect(await exists(P_FAILED)).toBe(true); // not pending
				expect(await exists(P_JOB)).toBe(true); // has a job

				throw ROLLBACK;
			});
		} catch (e) {
			if (e !== ROLLBACK) throw e;
		}
	});
});
