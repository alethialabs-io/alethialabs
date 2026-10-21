// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Job and project reads are bounded to the addressed organization.
//
// The `owner_all` RLS policy on `projects`, `jobs`, `agent_context` and `org_signing_key` admits a
// row when its `org_id` is the request's org or the caller's personal org — and nothing else. Who
// wrote the row (`user_id`) is not an arm of it: a row is reachable from the org it belongs to. This
// drives that through the real server actions on the RLS-enforced app role, with the real PDP:
//
//   * U acts in org A and in a personal org; W acts in org B. Org B holds a project, its
//     environment and jobs, an agent-context row and a signing key, with U's id in `user_id`.
//   * Scoped to A or to U's personal org, B's rows are outside the addressed organization: they are
//     not listed, opened, cancelled, re-run, revoked or streamed. Scoped to B, W reaches all of them.
//   * Rows of A that another member wrote, and rows of U's personal org, stay reachable from A.
//   * The project child tables and job_logs, whose policies read `projects`/`jobs` through a
//     sub-select, inherit the bound.
//   * A legacy job with no org is backfilled into its author's personal org before the policy runs.
//
// The community (single-tenant) half is tests/integration/jobs-org-bounded-reads-community.test.ts.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ owner: "", scope: { userId: "", orgId: "" } }));

vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": "/" }),
	cookies: async () => ({ get: () => undefined }),
}));
// The SSE route resolves its caller from the session; these stand in for that lookup.
vi.mock("@/lib/auth/owner", async (orig) => ({
	...(await orig<object>()),
	getOwner: async () => h.owner,
}));
vi.mock("@/lib/auth/scope", async (orig) => ({
	...(await orig<object>()),
	getActiveScope: async () => ({ ...h.scope }),
}));
vi.mock("@/lib/realtime", () => ({
	getRealtimeTransport: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/lib/http/hold-request", () => ({ holdRequest: () => {} }));

import { GET as streamJobLogs } from "@/app/api/stream/jobs/[id]/route";
import {
	cancelJob,
	getJob,
	getJobStatus,
	getJobs,
	getJobsPage,
	getPlanResult,
	rerunJob,
} from "@/app/server/actions/jobs";
import {
	getProject,
	getProjectsList,
	tryDestroyProject,
	tryPlanProject,
	tryProvisionProject,
} from "@/app/server/actions/projects";
import { promoteEnvironment } from "@/app/server/actions/promotions";
import { getOrgSigningKeys, revokeOrgSigningKey } from "@/app/server/actions/signing";
import { buildProjectKnowledge, readAgentContext } from "@/lib/ai/project-knowledge";
import { runWithActor } from "@/lib/authz/actor-context";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withActorScope } from "@/lib/db";
import {
	agentContext,
	grants,
	jobLogs,
	jobs,
	member,
	orgSigningKey,
	organization,
	projectEnvironments,
	projects,
	user,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const U = randomUUID(); // member of A; has a personal org; their id is on rows of B
const W = randomUUID(); // member of B
const X = randomUUID(); // member of A
const A = randomUUID();
const B = randomUUID();
const MARK_B = `B-DESIGN-${randomUUID()}`;
const LOG_B = `B-LOG-${randomUUID()}`;
const LOG_PERSONAL = `PERSONAL-LOG-${randomUUID()}`;
const CONTEXT_B = `B-CONTEXT-${randomUUID()}`;
const CONTEXT_PERSONAL = `PERSONAL-CONTEXT-${randomUUID()}`;

let projectB = "";
let envB = "";
let projectA = "";
let projectAByU = ""; // org A, created by U
let projectPersonal = ""; // U's personal org
let envPersonalDev = "";
let envPersonalProd = "";
let jobB = ""; // org B, user_id U
let jobBByW = ""; // org B, user_id W
let jobA = ""; // org A, user_id X
let jobPersonal = ""; // U's personal org, no project
let keyB = "";

const inA: Actor = { credential: "session", userId: U, orgId: A };
const inPersonal: Actor = { credential: "session", userId: U, orgId: U };
const asW: Actor = { credential: "session", userId: W, orgId: B };

/** Runs `fn` as `actor`, the way the oRPC read router and server actions bind one. */
const as = <T>(actor: Actor, fn: () => Promise<T>) => runWithActor(actor, fn);

/** Puts an environment variable back the way it was, unset included. */
function restoreEnv(name: string, was: string | undefined) {
	if (was === undefined) delete process.env[name];
	else process.env[name] = was;
}

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

/** Opens the SSE log stream for `jobId` as the session `actor`; returns the status and first frame. */
async function openStream(actor: Actor, jobId: string) {
	h.owner = actor.userId;
	h.scope = { userId: actor.userId, orgId: actor.orgId };
	const ac = new AbortController();
	const res = await streamJobLogs(
		new Request(`http://console.test/api/stream/jobs/${jobId}`, { signal: ac.signal }),
		{ params: Promise.resolve({ id: jobId }) },
	);
	let first = "";
	if (res.status === 200 && res.body) {
		const reader = res.body.getReader();
		const chunk = await reader.read();
		first = new TextDecoder().decode(chunk.value);
		ac.abort();
		await reader.cancel();
	}
	return { status: res.status, first };
}

describeIfDb("job and project reads are bounded to the addressed organization", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: U, email: `u-${U}@example.test` },
			{ id: W, email: `w-${W}@example.test` },
			{ id: X, email: `x-${X}@example.test` },
		]);
		await db.insert(organization).values([
			{ id: A, name: `a-${A.slice(0, 8)}`, slug: `a-${A.slice(0, 8)}` },
			{ id: B, name: `b-${B.slice(0, 8)}`, slug: `b-${B.slice(0, 8)}` },
			{ id: U, name: `u-personal-${U.slice(0, 8)}` },
		]);
		await db.insert(member).values([
			{ organizationId: A, userId: U, role: "owner" },
			{ organizationId: A, userId: X, role: "owner" },
			{ organizationId: B, userId: W, role: "owner" },
		]);
		await grant(A, U, BUILTIN_ROLE_IDS.owner);
		await grant(A, X, BUILTIN_ROLE_IDS.owner);
		await grant(U, U, BUILTIN_ROLE_IDS.owner);
		await grant(B, W, BUILTIN_ROLE_IDS.owner);

		// Org B: a project, environment and jobs that carry U's id.
		const [pb] = await db
			.insert(projects)
			.values({
				user_id: U,
				org_id: B,
				project_name: `pb-${B.slice(0, 6)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectB = pb.id;
		const [eb] = await db
			.insert(projectEnvironments)
			.values({
				project_id: projectB,
				user_id: U,
				name: "prod",
				status: "ACTIVE",
				is_default: true,
				stage: "production",
			})
			.returning({ id: projectEnvironments.id });
		envB = eb.id;
		const [jb, jbw] = await db
			.insert(jobs)
			.values([
				{
					user_id: U,
					org_id: B,
					project_id: projectB,
					environment_id: envB,
					job_type: "DEPLOY",
					status: "QUEUED",
					config_snapshot: { mark: MARK_B },
				},
				{
					user_id: W,
					org_id: B,
					project_id: projectB,
					environment_id: envB,
					job_type: "DETECT_DRIFT",
					status: "SUCCESS",
					config_snapshot: { mark: MARK_B },
				},
			])
			.returning({ id: jobs.id });
		jobB = jb.id;
		jobBByW = jbw.id;

		// Org A: a teammate's project and job.
		const [pa] = await db
			.insert(projects)
			.values({
				user_id: X,
				org_id: A,
				project_name: `pa-${A.slice(0, 6)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectA = pa.id;
		const [pau] = await db
			.insert(projects)
			.values({
				user_id: U,
				org_id: A,
				project_name: `pau-${A.slice(0, 6)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectAByU = pau.id;
		const [pp] = await db
			.insert(projects)
			.values({
				user_id: U,
				org_id: U,
				project_name: `pp-${U.slice(0, 6)}`,
				region: "us-east-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectPersonal = pp.id;
		const [ed, ep] = await db
			.insert(projectEnvironments)
			.values([
				{ project_id: projectPersonal, user_id: U, name: "dev", status: "ACTIVE", is_default: true, stage: "development" },
				{ project_id: projectPersonal, user_id: U, name: "prod", status: "ACTIVE", is_default: false, stage: "production" },
			])
			.returning({ id: projectEnvironments.id });
		envPersonalDev = ed.id;
		envPersonalProd = ep.id;
		const [ja] = await db
			.insert(jobs)
			.values({
				user_id: X,
				org_id: A,
				project_id: projectA,
				job_type: "DETECT_DRIFT",
				status: "SUCCESS",
				config_snapshot: {},
			})
			.returning({ id: jobs.id });
		jobA = ja.id;

		// U's personal org: a project-less runner job, as pre-#3942 enqueue paths stamped them.
		const [jp] = await db
			.insert(jobs)
			.values({
				user_id: U,
				org_id: U,
				job_type: "DEPLOY_RUNNER",
				status: "SUCCESS",
				config_snapshot: {},
			})
			.returning({ id: jobs.id });
		jobPersonal = jp.id;

		await db.insert(jobLogs).values([
			{ job_id: jobB, log_chunk: LOG_B },
			{ job_id: jobPersonal, log_chunk: LOG_PERSONAL },
		]);

		// Org B: an agent-context row and a signing key that carry U's id.
		await db.insert(agentContext).values([
			{ user_id: U, org_id: B, project_id: null, instructions: CONTEXT_B },
			// The per-user row the flag-OFF path writes: org_id = user_id.
			{ user_id: U, org_id: U, project_id: null, instructions: CONTEXT_PERSONAL },
		]);
		const [kb] = await db
			.insert(orgSigningKey)
			.values({
				user_id: U,
				org_id: B,
				provider: "aws",
				backend: "kms",
				key_ref: `arn:aws:kms:us-east-1:000000000000:key/${randomUUID()}`,
				public_key: `pk-${randomUUID()}`,
				key_id: `kid-${randomUUID()}`,
			})
			.returning({ id: orgSigningKey.id });
		keyB = kb.id;
	});

	afterAll(async () => {
		const db = getServiceDb();
		const orgs = [A, B, U];
		const jobIds = await db
			.select({ id: jobs.id })
			.from(jobs)
			.where(inArray(jobs.org_id, orgs));
		if (jobIds.length > 0) {
			await db.delete(jobLogs).where(
				inArray(
					jobLogs.job_id,
					jobIds.map((j) => j.id),
				),
			);
		}
		await db.delete(jobs).where(inArray(jobs.org_id, orgs));
		await db.delete(agentContext).where(inArray(agentContext.org_id, orgs));
		await db.delete(orgSigningKey).where(inArray(orgSigningKey.org_id, orgs));
		await db.delete(projects).where(inArray(projects.org_id, orgs));
		await db.delete(grants).where(inArray(grants.org_id, orgs));
		await db.delete(member).where(inArray(member.organizationId, orgs));
	});

	for (const [label, actor] of [
		["org A", inA],
		["the personal scope", inPersonal],
	] as const) {
		it(`the jobs list is bounded to the addressed organization (${label})`, async () => {
			const page = await as(actor, () => getJobsPage({}));
			const ids = page.rows.map((r) => r.id);
			expect(ids).not.toContain(jobB);
			expect(ids).not.toContain(jobBByW);
			expect(page.rows.every((r) => r.org_id !== B)).toBe(true);
			expect(ids).toContain(jobPersonal);

			const all = await as(actor, () => getJobs());
			expect(all.some((r) => r.id === jobB)).toBe(false);
		});

		it(`a job outside the addressed organization is not found (${label})`, async () => {
			expect(await as(actor, () => getJob(jobB))).toBeNull();
			await expect(as(actor, () => getJobStatus(jobB))).rejects.toThrow("Failed to get job status");
			await expect(as(actor, () => getPlanResult(jobB))).rejects.toThrow("Failed to get plan result");
		});

		it(`a project outside the addressed organization is not listed or found (${label})`, async () => {
			const list = await as(actor, () => getProjectsList());
			expect(list.projects.some((p) => p.id === projectB)).toBe(false);
			// notFound(): the project is not visible in this scope.
			await expect(as(actor, () => getProject(projectB))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
		});

		it(`the log stream of a job outside the addressed organization is not found (${label})`, async () => {
			const res = await openStream(actor, jobB);
			expect(res.status).toBe(404);
		});
	}

	it("org A lists its members' jobs and the caller's personal-org job", async () => {
		const page = await as(inA, () => getJobsPage({}));
		const ids = page.rows.map((r) => r.id);
		expect(ids).toContain(jobA);
		expect(ids).toContain(jobPersonal);
		const list = await as(inA, () => getProjectsList());
		expect(list.projects.some((p) => p.id === projectA)).toBe(true);
	});

	it("org A streams the caller's personal-org job log", async () => {
		const res = await openStream(inA, jobPersonal);
		expect(res.status).toBe(200);
		expect(res.first).toContain(LOG_PERSONAL);
	});

	it("scoped to org B, B's jobs, projects and logs are reachable", async () => {
		const page = await as(asW, () => getJobsPage({}));
		const ids = page.rows.map((r) => r.id);
		expect(ids).toContain(jobB);
		expect(ids).toContain(jobBByW);
		const j = await as(asW, () => getJob(jobB));
		expect(JSON.stringify(j?.config_snapshot)).toContain(MARK_B);
		const list = await as(asW, () => getProjectsList());
		expect(list.projects.some((p) => p.id === projectB)).toBe(true);
		const res = await openStream(asW, jobB);
		expect(res.status).toBe(200);
		expect(res.first).toContain(LOG_B);
	});

	it("project child rows and job logs inherit the bound through their parent", async () => {
		const read = (actor: Actor) =>
			withActorScope(actor, async (tx) => ({
				envs: await tx
					.select({ id: projectEnvironments.id })
					.from(projectEnvironments)
					.where(eq(projectEnvironments.project_id, projectB)),
				logs: await tx
					.select({ id: jobLogs.id })
					.from(jobLogs)
					.where(eq(jobLogs.job_id, jobB)),
			}));
		const fromA = await read(inA);
		expect(fromA.envs).toHaveLength(0);
		expect(fromA.logs).toHaveLength(0);
		const fromB = await read(asW);
		expect(fromB.envs.map((e) => e.id)).toContain(envB);
		expect(fromB.logs).toHaveLength(1);
	});

	it("jobs outside the addressed organization are unaffected by cancel", async () => {
		await expect(as(inA, () => cancelJob(jobB))).rejects.toThrow("Job not found");
		const [row] = await getServiceDb()
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.id, jobB));
		expect(row.status).toBe("QUEUED");
	});

	it("jobs outside the addressed organization are unaffected by re-run", async () => {
		await expect(as(inA, () => rerunJob(jobB))).rejects.toThrow("Original job not found");
		const fresh = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.org_id, A))
			.then((rows) => rows.filter((r) => r.id !== jobA));
		expect(fresh).toHaveLength(0);
	});

	it("a re-run takes its org from the project and stays within the addressed organization", async () => {
		// A personal-org job is visible from A, but re-running it there would move it into A.
		await expect(as(inA, () => rerunJob(jobPersonal))).rejects.toThrow(
			"This job belongs to your personal workspace — switch to it to run this.",
		);

		const created = await as(inA, () => rerunJob(jobA));
		const [row] = await getServiceDb()
			.select({ org_id: jobs.org_id, project_id: jobs.project_id, user_id: jobs.user_id })
			.from(jobs)
			.where(eq(jobs.id, created.id));
		expect(row).toEqual({ org_id: A, project_id: projectA, user_id: U });

		const onB = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.project_id, projectB));
		expect(onB.map((r) => r.id).sort()).toEqual([jobB, jobBByW].sort());
	});

	it("a project-bearing job carries its project's org: a disagreeing org_id is refused", async () => {
		const db = getServiceDb();
		// On insert, by the service role (no RLS in the way): the trigger is the constraint.
		await expect(
			db.insert(jobs).values({
				user_id: U,
				org_id: A,
				project_id: projectB,
				job_type: "DETECT_DRIFT",
				status: "QUEUED",
				config_snapshot: {},
			}),
		).rejects.toMatchObject({
			// The text names no value: the project's org is read with definer rights.
			cause: { code: "23514", message: "jobs.org_id does not match the org of its project" },
		});
		// On update of either column.
		await expect(db.update(jobs).set({ org_id: A }).where(eq(jobs.id, jobB))).rejects.toMatchObject({
			cause: { code: "23514" },
		});
		await expect(
			db.update(jobs).set({ project_id: projectA }).where(eq(jobs.id, jobB)),
		).rejects.toMatchObject({ cause: { code: "23514" } });
		// Left NULL, it takes the project's org.
		const [derived] = await db
			.insert(jobs)
			.values({ user_id: U, project_id: projectB, job_type: "DETECT_DRIFT", status: "SUCCESS", config_snapshot: {} })
			.returning({ id: jobs.id, org_id: jobs.org_id });
		expect(derived.org_id).toBe(B);
		await db.delete(jobs).where(eq(jobs.id, derived.id));
	});

	it("migrate realigns a job whose org disagrees with its project's, and reports a count", async () => {
		const file = readFileSync(
			fileURLToPath(new URL("../../lib/db/programmables.sql", import.meta.url)),
			"utf8",
		);
		const start = file.indexOf("DO $$\nDECLARE n BIGINT;\nBEGIN\n  UPDATE public.jobs j");
		expect(start).toBeGreaterThan(-1);
		const realign = file.slice(start, file.indexOf("END $$;", start) + "END $$;".length);

		// Its own connection, to hear the NOTICE; one transaction, rolled back, so nothing persists.
		const notices: string[] = [];
		const pg = postgres(process.env.ALETHIA_DATABASE_URL ?? "", {
			max: 1,
			onnotice: (n) => notices.push(n.message),
		});
		let badId = "";
		let orgAfter: string | null = null;
		try {
			await pg
				.begin(async (tx) => {
					// Triggers off for the one write: the disagreeing shape a restore or replica load leaves.
					await tx`set local session_replication_role = replica`;
					const [bad] = await tx<{ id: string }[]>`
						insert into jobs (user_id, org_id, project_id, job_type, status, config_snapshot)
						values (${U}, ${A}, ${projectB}, 'DETECT_DRIFT', 'SUCCESS', '{}'::jsonb)
						returning id`;
					badId = bad.id;
					await tx`set local session_replication_role = origin`;
					await tx.unsafe(realign);
					const [row] = await tx<{ org_id: string | null }[]>`
						select org_id from jobs where id = ${bad.id}`;
					orgAfter = row?.org_id ?? null;
					throw new Error("rollback");
				})
				.catch((e: unknown) => {
					if (!(e instanceof Error) || e.message !== "rollback") throw e;
				});
		} finally {
			await pg.end({ timeout: 1 });
		}
		// Moved to the project's org, the migrate did not fail, and the notice carries a count only.
		expect(orgAfter).toBe(B);
		const notice = notices.find((m) => m.startsWith("jobs realigned to their project's org:"));
		expect(notice).toMatch(/^jobs realigned to their project's org: \d+$/);
		expect(notice).not.toContain(badId);
	});

	it("work on a personal-workspace project is refused from a team org, with a sentence", async () => {
		const personal = "This project belongs to your personal workspace — switch to it to run this.";
		const before = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.project_id, projectPersonal));

		expect(await as(inA, () => tryPlanProject(projectPersonal, undefined, envPersonalDev))).toEqual({
			ok: false,
			error: personal,
		});
		expect(await as(inA, () => tryProvisionProject(projectPersonal, undefined, undefined, envPersonalDev))).toEqual({
			ok: false,
			error: personal,
		});
		expect(await as(inA, () => tryDestroyProject(projectPersonal, envPersonalDev))).toEqual({
			ok: false,
			error: personal,
		});
		expect(
			await as(inA, () => promoteEnvironment(projectPersonal, envPersonalDev, envPersonalProd)),
		).toEqual({ ok: false, error: personal });

		const after = await getServiceDb()
			.select({ id: jobs.id })
			.from(jobs)
			.where(eq(jobs.project_id, projectPersonal));
		expect(after).toHaveLength(before.length);

		// From the personal workspace itself the org check passes; the next gate is the project's own.
		const fromPersonal = await as(inPersonal, () => tryPlanProject(projectPersonal, undefined, envPersonalDev));
		expect(fromPersonal).toEqual({
			ok: false,
			error: "No cloud account linked to this project. Go to Connectors to connect.",
		});
	});

	it("signing keys are listed and revoked within the addressed organization", async () => {
		const keys = await as(inA, () => getOrgSigningKeys());
		expect(keys.some((k) => k.id === keyB)).toBe(false);
		await as(inA, () => revokeOrgSigningKey(keyB));
		const [row] = await getServiceDb()
			.select({ status: orgSigningKey.status })
			.from(orgSigningKey)
			.where(eq(orgSigningKey.id, keyB));
		expect(row.status).toBe("pending_verification");
		const fromB = await as(asW, () => getOrgSigningKeys());
		expect(fromB.some((k) => k.id === keyB)).toBe(true);
	});

	it("agent context is read within the addressed organization (flag ON)", async () => {
		const was = process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED;
		process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED = "true";
		try {
			const fromA = await readAgentContext(inA, null);
			// No row of org A: the caller's personal row is the fallback, never another org's.
			expect(fromA?.instructions).toBe(CONTEXT_PERSONAL);
			const fromB = await readAgentContext(asW, null);
			expect(fromB?.instructions).toBe(CONTEXT_B);
		} finally {
			restoreEnv("ALETHIA_ORG_AGENT_CONTEXT_ENABLED", was);
		}
	});

	it("agent context is read within the personal scope (flag OFF, the default)", async () => {
		const was = process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED;
		delete process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED;
		try {
			for (const actor of [inA, inPersonal]) {
				const row = await readAgentContext(actor, null);
				expect(row?.instructions).toBe(CONTEXT_PERSONAL);
			}
		} finally {
			restoreEnv("ALETHIA_ORG_AGENT_CONTEXT_ENABLED", was);
		}
	});

	it("the assistant's project knowledge resolves only projects of the active or personal org", async () => {
		const was = process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED;
		try {
			// Flag OFF, the per-user default: the caller's own project of the addressed org resolves;
			// a teammate's does not, and a project outside the addressed org does not.
			delete process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED;
			expect(await buildProjectKnowledge(inA, projectAByU)).not.toBe("");
			expect(await buildProjectKnowledge(inA, projectA)).toBe("");
			expect(await buildProjectKnowledge(inA, projectB)).toBe("");
			expect(await buildProjectKnowledge(inPersonal, projectB)).toBe("");
			// Flag ON, org-shared: every project of the active org, still none of another org.
			process.env.ALETHIA_ORG_AGENT_CONTEXT_ENABLED = "true";
			expect(await buildProjectKnowledge(inA, projectA)).not.toBe("");
			expect(await buildProjectKnowledge(inA, projectB)).toBe("");
		} finally {
			restoreEnv("ALETHIA_ORG_AGENT_CONTEXT_ENABLED", was);
		}
	});

	it("a job with no org is backfilled into its author's personal org before the policy", async () => {
		const db = getServiceDb();
		const [legacy] = await db
			.insert(jobs)
			.values({ user_id: U, org_id: U, job_type: "DEPLOY_RUNNER", status: "SUCCESS", config_snapshot: {} })
			.returning({ id: jobs.id });
		// Triggers off for this one write: the jobs_set_org_id trigger fills an org on every write, so
		// a NULL org is only reachable as history (or a replica-mode load).
		await db.transaction(async (tx) => {
			await tx.execute(sql`set local session_replication_role = replica`);
			await tx.update(jobs).set({ org_id: null }).where(eq(jobs.id, legacy.id));
		});
		expect(await as(inPersonal, () => getJob(legacy.id))).toBeNull();

		// The statement programmables.sql runs on every migrate, taken from the file itself, and it
		// must run BEFORE the jobs policy is created.
		const file = readFileSync(
			fileURLToPath(new URL("../../lib/db/programmables.sql", import.meta.url)),
			"utf8",
		);
		const backfill = "UPDATE public.jobs\n   SET org_id = user_id\n WHERE org_id IS NULL;";
		const at = file.indexOf(backfill);
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(
			file.indexOf("FOR tbl IN SELECT unnest(ARRAY['projects', 'jobs', 'agent_context', 'org_signing_key'])"),
		);
		await db.execute(sql.raw(backfill));

		const row = await as(inPersonal, () => getJob(legacy.id));
		expect(row?.org_id).toBe(U);
	});
});

