// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6115, ADR 0005 §10 R5/R6): what the jobs change triggers in lib/db/programmables.sql
// actually NOTIFY, driven through the REAL runner RPCs against real Postgres. A mocked database cannot
// answer this: the property is a trigger's WHEN clause meeting plpgsql that SETs columns to the values
// they already hold.
//
// DETERMINISM. NOTIFY is delivered at commit, in commit order. After each operation the test commits a
// sentinel NOTIFY of its own and waits for it on a dedicated LISTEN connection; everything that arrived
// before the sentinel is exactly what the operation emitted. So a ZERO below is a real zero — not "did
// not arrive in time" — and every zero case has a control in the same file that emits one.
//
// The high-frequency writers that must stay silent (R5): an empty claim, a runner heartbeat, a runner's
// presence ping, a log flush (and the progress_at stamp it makes), a PROCESSING re-post with no
// metadata. The changes that must emit exactly one: insert, a real claim, a stage's metadata, the
// terminal status, a project deleted out from under its job, a delete.

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, organization, projects, runners } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const USER = randomUUID(); // the self runner's owner (personal org = USER)
const ORG = randomUUID(); // a hosted org, for the project job
const TOKEN = randomUUID();
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

interface Notice {
	t: string;
	id: string | null;
	o: string | null;
	u: string | null;
	p: string | null;
	n?: string;
}

const db = () => getServiceDb();
let listener: ReturnType<typeof postgres>;
const heard: Notice[] = [];
const jobLogNotices: string[] = [];
let runnerId: string;
let projectId: string;
const created: string[] = [];

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every jobs notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) {
			const before = heard.splice(0, at + 1).slice(0, at);
			return before.filter((x) => x.t === "jobs");
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the jobs notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(
		sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`,
	);
	return drainUntil(n);
}

/** A job row (QUEUED by default). Returns its id. */
async function insertJob(values: Partial<typeof jobs.$inferInsert> = {}): Promise<string> {
	const [row] = await db()
		.insert(jobs)
		.values({
			user_id: USER,
			job_type: "PLAN",
			status: "QUEUED",
			config_snapshot: {},
			...values,
		})
		.returning({ id: jobs.id });
	created.push(row.id);
	return row.id;
}

/** The runner RPCs, as the runner calls them. */
const rpc = {
	claim: () =>
		db().execute<{ id: string }>(
			sql`select id from claim_next_job(${runnerId}::uuid, ${TOKEN_HASH}, NULL)`,
		),
	heartbeat: () =>
		db().execute(sql`select runner_heartbeat(${runnerId}::uuid, ${TOKEN_HASH}, NULL, NULL)`),
	present: () => db().execute(sql`select runner_present(${runnerId}::uuid)`),
	log: (job: string) =>
		db().execute(
			sql`select insert_job_log(${runnerId}::uuid, ${TOKEN_HASH}, ${job}::uuid, 'a log line')`,
		),
	status: (job: string, status: string, metadata: string | null = null) =>
		db().execute(
			sql`select update_job_status(${runnerId}::uuid, ${TOKEN_HASH}, ${job}::uuid, ${status}, NULL, ${metadata}::jsonb)`,
		),
};

describeIfDb("jobs change triggers — what reaches alethia_change", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));
		await listener.listen("job_logs", (payload) => jobLogNotices.push(payload));

		// A SELF runner in USER's personal org: its claim takes ONLY that org's jobs, so the empty claim
		// below is empty by construction, whatever other suites left queued.
		const [r] = await db()
			.insert(runners)
			.values({
				user_id: USER,
				org_id: USER,
				name: `it-6115-${USER.slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				status: "ONLINE",
				token_hash: TOKEN_HASH,
			})
			.returning({ id: runners.id });
		runnerId = r.id;

		await db()
			.insert(organization)
			.values({ id: ORG, name: `it-6115-${ORG.slice(0, 8)}` });
		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: `it-6115-${ORG.slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		if (created.length) {
			for (const id of created) await db().delete(jobs).where(eq(jobs.id, id));
		}
		if (runnerId) await db().delete(runners).where(eq(runners.id, runnerId));
		if (projectId) await db().delete(projects).where(eq(projects.id, projectId));
		await db().delete(organization).where(eq(organization.id, ORG));
	});

	it("an empty claim, a heartbeat and a presence ping emit nothing (they write runners, not jobs)", async () => {
		expect(await emitted(async () => expect(await rpc.claim()).toHaveLength(0))).toEqual([]);
		expect(await emitted(rpc.heartbeat)).toEqual([]);
		expect(await emitted(rpc.present)).toEqual([]);
	});

	it("a project-less service insert emits one notice, stamped org_id = user_id (R6)", async () => {
		let id = "";
		// Terminal, so the self runner's claims below never pick it up.
		const notices = await emitted(async () => {
			id = await insertJob({ status: "CANCELLED" });
		});
		expect(notices).toEqual([{ t: "jobs", id, o: USER, u: USER, p: null }]);
	});

	it("follows one job through the runner's life: one notice per change the UI shows, none otherwise", async () => {
		const job = await insertJob();
		await emitted(async () => {}); // drain the insert's notice

		// A real claim: QUEUED → CLAIMED, runner_id set. Exactly one.
		const claim = await emitted(async () => expect((await rpc.claim())[0]?.id).toBe(job));
		expect(claim).toEqual([{ t: "jobs", id: job, o: USER, u: USER, p: null }]);

		// The claim refreshed the runner too, and an empty follow-up claim touches no job row.
		expect(await emitted(async () => expect(await rpc.claim()).toHaveLength(0))).toEqual([]);

		// CLAIMED → PROCESSING (status + started_at): one.
		expect(await emitted(() => rpc.status(job, "PROCESSING"))).toHaveLength(1);

		// The runner re-posts PROCESSING with no metadata: nothing the UI shows changed.
		expect(await emitted(() => rpc.status(job, "PROCESSING"))).toEqual([]);

		// A log flush notifies job_logs and — once its 55 s throttle allows — stamps progress_at.
		// Age progress_at first (itself a write of an unlisted column: silent), so the stamp really runs.
		expect(
			await emitted(() =>
				db().execute(
					sql`update jobs set progress_at = now() - interval '10 minutes' where id = ${job}::uuid`,
				),
			),
		).toEqual([]);
		const logsBefore = jobLogNotices.length;
		expect(await emitted(() => rpc.log(job))).toEqual([]);
		expect(jobLogNotices.length).toBe(logsBefore + 1); // it ran
		const [after] = await db()
			.select({ progress_at: jobs.progress_at })
			.from(jobs)
			.where(eq(jobs.id, job));
		expect(Date.now() - (after.progress_at?.getTime() ?? 0)).toBeLessThan(60_000); // and it stamped

		// A stage posting its metadata: one per post.
		expect(await emitted(() => rpc.status(job, "PROCESSING", '{"stage":"plan"}'))).toHaveLength(1);

		// PROCESSING → SUCCESS (status + completed_at): one.
		expect(await emitted(() => rpc.status(job, "SUCCESS"))).toEqual([
			{ t: "jobs", id: job, o: USER, u: USER, p: null },
		]);

		// A same-status terminal re-post IS a change the UI shows: update_job_status re-stamps
		// completed_at (the duration column moves). One hint — measured, not assumed: the first draft
		// of this test expected zero and the database said otherwise.
		expect(await emitted(() => rpc.status(job, "SUCCESS"))).toHaveLength(1);
		// A DIFFERENT terminal status is refused by the terminal guard, which then records the late
		// report in execution_metadata (a listed column): one hint for the evidence that landed.
		expect(await emitted(() => rpc.status(job, "FAILED"))).toHaveLength(1);
		const [final] = await db().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job));
		expect(final.status).toBe("SUCCESS");
	});

	it("a rolled-back change emits nothing (NOTIFY is transactional)", async () => {
		const job = await insertJob({ status: "SUCCESS" });
		await emitted(async () => {});
		const notices = await emitted(async () => {
			await db()
				.transaction(async (tx) => {
					await tx.update(jobs).set({ error_message: "never" }).where(eq(jobs.id, job));
					throw new Error("rollback");
				})
				.catch(() => {});
		});
		expect(notices).toEqual([]);
		// The control: the same write, committed, emits one.
		expect(
			await emitted(() =>
				db().update(jobs).set({ error_message: "committed" }).where(eq(jobs.id, job)),
			),
		).toHaveLength(1);
	});

	it("a project job carries its org and project; deleting the project keeps OLD.project_id", async () => {
		const job = await insertJob({ project_id: projectId });
		await emitted(async () => {});
		const [row] = await db().select({ org_id: jobs.org_id }).from(jobs).where(eq(jobs.id, job));
		expect(row.org_id).toBe(ORG); // set_org_id_from_project stamped the project's org

		const notices = await emitted(() => db().delete(projects).where(eq(projects.id, projectId)));
		// ON DELETE SET NULL updated the job; the notice still names the project it was under.
		expect(notices).toEqual([{ t: "jobs", id: job, o: ORG, u: USER, p: projectId }]);
	});

	it("deleting a job emits one notice from the OLD row", async () => {
		const job = await insertJob();
		await emitted(async () => {});
		expect(await emitted(() => db().delete(jobs).where(eq(jobs.id, job)))).toEqual([
			{ t: "jobs", id: job, o: USER, u: USER, p: null },
		]);
	});

	it("a payload is identifiers only, far under NOTIFY's 8000-byte cap", async () => {
		const notices = await emitted(() => insertJob({ status: "FAILED", error_message: "x".repeat(7000) }));
		expect(notices).toHaveLength(1);
		expect(JSON.stringify(notices[0]).length).toBeLessThan(300);
	});
});
