// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6458): the claim is capability-aware. Against real Postgres, the real claim and
// heartbeat routes, and the real claim_next_job / runner_heartbeat:
//
//   · a MIXED pool — a runner without `addon-byo-marker` leaves an OCI BYO DEPLOY QUEUED (and still
//     claims other work behind it) while a LIVE runner in the job's pool advertises the capability,
//     and that runner claims it. Self-runner and managed-pool branches both;
//   · the skip is bounded by PRESENCE, not time — a job held by state_object_busy for far longer than
//     any time window is still skipped by the old runner while a capable runner is live;
//   · when NO live runner in the pool advertises it (none registered, the capable one gone stale, or
//     DRAINING), the old runner is handed the job and refusalForRunner fails it through
//     recordJobFailed with the "update the runner" reason (job and environment FAILED, alert raised);
//   · an ASSIGNED OCI BYO DEPLOY fails at once even with a capable runner live;
//   · a git-only BYO snapshot is claimable by a runner without the capability, served stripped;
//   · jobs.required_capabilities is derived by the trigger, whatever an INSERT writes;
//   · the SQL reading (job_required_capabilities) agrees with the TS one (refusalForRunner) over the
//     shared fixtures in packages/core/types/testdata/snapshot-capabilities and the edge shapes.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

const emitAlertEventSafe = vi.fn();
vi.mock("@/lib/alerts/emit", () => ({
	emitAlertEventSafe: (...args: unknown[]) => emitAlertEventSafe(...args),
}));
// The signature check is real crypto with a key the suite may not configure; it is held open here so
// every claim reaches the capability logic. Everything after it is real.
vi.mock("@/lib/runners/snapshot-sig", () => ({
	verifySnapshot: () => true,
}));

import { POST as claimPost } from "@/app/api/jobs/claim/route";
import { POST as heartbeatPost } from "@/app/api/runners/heartbeat/route";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
	runners,
	tofuStateLocks,
} from "@/lib/db/schema";
import { hashRunnerToken } from "@/lib/runners/auth";
import {
	RUNNER_CAPABILITY_ADDON_BYO_MARKER,
	refusalForRunner,
} from "@/lib/runners/snapshot-capabilities";

const USER = randomUUID();
const ORG = randomUUID();
const projectIds: string[] = [];
const cloudIds: string[] = [];
const runnerIds: string[] = [];
const lockKeys: string[] = [];

const FIXTURES = resolve(__dirname, "../../../../packages/core/types/testdata/snapshot-capabilities");

/** One shared fixture, parsed as the open record a config_snapshot is. */
function fixture(name: string): Record<string, unknown> {
	return z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")));
}

/** A DEPLOY snapshot carrying one OCI bring-your-own chart. */
const OCI_BYO_SNAPSHOT = {
	project_name: "acme",
	addons: [
		{ id: "payments", source: "helm", byo: true, chartRepo: "oci://ghcr.io/acme", chart: "payments", namespace: "byo-payments" },
	],
};

/** A DEPLOY snapshot whose only BYO chart comes from git. */
const GIT_BYO_SNAPSHOT = {
	project_name: "acme",
	addons: [
		{ id: "api", source: "git", byo: true, chartRepo: "https://github.com/acme/charts", path: "charts/api", namespace: "byo-api" },
	],
};

interface SeededRunner {
	id: string;
	token: string;
}

/**
 * A runner in this file's org (self) or keyed to one cloud identity (managed), with its token. It
 * starts OFFLINE with no capabilities: it becomes live — and known capable — only through the real
 * heartbeat or claim route.
 */
async function seedRunner(
	kind: "self" | "managed",
	cloudIdentityId: string | null = null,
	org: string = ORG,
): Promise<SeededRunner> {
	const token = `it-cap-skip-${randomUUID()}`;
	const [r] = await getServiceDb()
		.insert(runners)
		.values(
			kind === "self"
				? {
						user_id: USER,
						org_id: org,
						name: `it-cap-skip-${token.slice(-12)}`,
						operator: "self",
						provisioning: "registered",
						token_hash: hashRunnerToken(token),
						status: "OFFLINE",
					}
				: {
						name: `it-cap-skip-${token.slice(-12)}`,
						operator: "managed",
						token_hash: hashRunnerToken(token),
						status: "OFFLINE",
						cloud_identity_id: cloudIdentityId,
					},
		)
		.returning({ id: runners.id });
	runnerIds.push(r.id);
	return { id: r.id, token };
}

/** A managed cloud identity — the managed claim is narrowed to its jobs, isolating this file. */
async function seedIdentity(): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({ user_id: USER, org_id: ORG, provider: "hetzner", name: `it-cap-skip-${randomUUID().slice(0, 8)}` })
		.returning({ id: cloudIdentities.id });
	cloudIds.push(row.id);
	return row.id;
}

/** A project and its QUEUED environment, the shape a DEPLOY's failure path writes through. */
async function seedEnvironment(): Promise<{ projectId: string; envId: string }> {
	const db = getServiceDb();
	const [p] = await db
		.insert(projects)
		.values({ user_id: USER, org_id: ORG, project_name: `it-cap-skip-${randomUUID().slice(0, 8)}`, region: "us-east-1", iac_version: "1.9.5" })
		.returning({ id: projects.id });
	projectIds.push(p.id);
	const [env] = await db
		.insert(projectEnvironments)
		.values({ project_id: p.id, user_id: USER, name: "dev", status: "QUEUED", is_default: true })
		.returning({ id: projectEnvironments.id });
	return { projectId: p.id, envId: env.id };
}

/** One QUEUED job, on a fresh environment unless `on` names one. `queuedMinutesAgo` back-dates it. */
async function seedQueued(opts: {
	jobType?: "DEPLOY" | "PLAN";
	snapshot: Record<string, unknown>;
	cloudIdentityId?: string;
	assignedRunnerId?: string;
	queuedMinutesAgo?: number;
	on?: { projectId: string; envId: string };
}): Promise<{ jobId: string; projectId: string; envId: string }> {
	const { projectId, envId } = opts.on ?? (await seedEnvironment());
	const at = new Date(Date.now() - (opts.queuedMinutesAgo ?? 0) * 60_000);
	const [row] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: ORG,
			project_id: projectId,
			environment_id: envId,
			job_type: opts.jobType ?? "DEPLOY",
			status: "QUEUED",
			config_snapshot: opts.snapshot,
			cloud_identity_id: opts.cloudIdentityId ?? null,
			assigned_runner_id: opts.assignedRunnerId ?? null,
			requires_self_runner: false,
			created_at: at,
			updated_at: at,
		})
		.returning({ id: jobs.id });
	return { jobId: row.id, projectId, envId };
}

const ClaimBody = z.object({
	job: z.object({ id: z.string(), config_snapshot: z.record(z.string(), z.unknown()) }).nullable().optional(),
	error: z.string().optional(),
});

/** The headers a runner sends; no `capabilities` = a runner built before the header existed. */
function runnerHeaders(runner: SeededRunner, capabilities?: string): Record<string, string> {
	const headers: Record<string, string> = { "X-Runner-ID": runner.id, "X-Runner-Token": runner.token };
	if (capabilities !== undefined) headers["X-Runner-Capabilities"] = capabilities;
	return headers;
}

/** Claims as `runner` through the real claim route. */
async function claim(runner: SeededRunner, capabilities?: string) {
	const res = await claimPost(
		new Request("https://console.local/api/jobs/claim", { method: "POST", headers: runnerHeaders(runner, capabilities) }),
	);
	return { status: res.status, body: ClaimBody.parse(await res.json()) };
}

/** Heartbeats as `runner` through the real heartbeat route — what makes it live and stamps its capabilities. */
async function heartbeat(runner: SeededRunner, capabilities?: string) {
	const res = await heartbeatPost(
		new Request("https://console.local/api/runners/heartbeat", {
			method: "POST",
			headers: { ...runnerHeaders(runner, capabilities), "Content-Type": "application/json" },
			body: JSON.stringify({}),
		}),
	);
	expect(res.status).toBe(200);
}

/**
 * Makes `runner` a LIVE runner in its pool, as a running one is: a heartbeat (stamping its
 * capabilities) and one claim poll (stamping last_claim_at). Called before the case's jobs are
 * seeded, so the poll finds nothing.
 */
async function goLive(runner: SeededRunner, capabilities?: string) {
	await heartbeat(runner, capabilities);
	const poll = await claim(runner, capabilities);
	expect(poll.status).toBe(200);
	expect(poll.body.job ?? null).toBeNull();
}

/** Claims through the 3-argument claim_next_job an old console pod calls (p_capabilities NULL). */
async function claimAsOldPod(runner: SeededRunner): Promise<string | null> {
	const rows = await getServiceDb().execute<{ id: string }>(
		sql`select id from claim_next_job(${runner.id}::uuid, ${hashRunnerToken(runner.token)}, null::uuid)`,
	);
	return rows[0]?.id ?? null;
}

/** The job row's status, runner and error. */
async function jobRow(jobId: string) {
	const [row] = await getServiceDb()
		.select({ status: jobs.status, runner_id: jobs.runner_id, error: jobs.error_message })
		.from(jobs)
		.where(eq(jobs.id, jobId));
	return row;
}

/** Holds (project, env)'s state file with a live writer, so state_object_busy keeps its jobs QUEUED. */
async function holdState(on: { projectId: string; envId: string }): Promise<string> {
	const db = getServiceDb();
	const [holder] = await db
		.insert(jobs)
		.values({ user_id: USER, org_id: ORG, project_id: on.projectId, environment_id: on.envId, job_type: "DEPLOY", status: "PROCESSING" })
		.returning({ id: jobs.id });
	const key = `projects/${on.projectId}/${on.envId}/tofu.tfstate`;
	lockKeys.push(key);
	await db.insert(tofuStateLocks).values({
		state_key: key,
		lock_id: randomUUID(),
		job_id: holder.id,
		info: {},
		expires_at: new Date(Date.now() + 3 * 3600_000),
	});
	return key;
}

/** The refusal's end state: job FAILED with the update-the-runner reason, its environment FAILED, the alert raised. */
async function expectFailedWithUpdateReason(seeded: { jobId: string; envId: string }) {
	const row = await jobRow(seeded.jobId);
	expect(row.status).toBe("FAILED");
	expect(row.error).toMatch(/bring-your-own OCI chart/);
	expect(row.error).toMatch(/Update the runner/);
	const [env] = await getServiceDb()
		.select({ status: projectEnvironments.status })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, seeded.envId));
	expect(env.status).toBe("FAILED");
	expect(emitAlertEventSafe).toHaveBeenCalledWith(
		ORG,
		"system.job.failed",
		expect.objectContaining({ job_id: seeded.jobId, job_type: "DEPLOY" }),
	);
}

describeIfDb("claim_next_job skips a job the runner lacks the capability for, while a capable runner is live", () => {
	afterAll(async () => {
		const db = getServiceDb();
		if (lockKeys.length) await db.delete(tofuStateLocks).where(inArray(tofuStateLocks.state_key, lockKeys));
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
		if (runnerIds.length) await db.delete(runners).where(inArray(runners.id, runnerIds));
		if (cloudIds.length) await db.delete(cloudIdentities).where(inArray(cloudIdentities.id, cloudIds));
	});

	beforeEach(async () => {
		emitAlertEventSafe.mockClear();
		const db = getServiceDb();
		// Every case starts from nothing in flight and no runner of this file live: one case's
		// leftovers never feed the next claim, and no earlier capable runner counts as present.
		await db.update(jobs).set({ status: "CANCELLED", completed_at: new Date() }).where(eq(jobs.user_id, USER));
		if (runnerIds.length) {
			await db
				.update(runners)
				.set({ status: "OFFLINE", last_heartbeat: new Date(Date.now() - 3600_000), last_claim_at: null, capabilities: [] })
				.where(inArray(runners.id, runnerIds));
		}
	});

	it("mixed self pool: the old runner (no header) skips the OCI BYO DEPLOY and takes the plain one behind it; the live capable runner claims it", async () => {
		const oldSelf = await seedRunner("self");
		const newSelf = await seedRunner("self");
		await goLive(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		// Same job type, so the same priority: the BYO DEPLOY is first in line by age, and only the
		// capability skip lets the old runner reach the plain one behind it.
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT, queuedMinutesAgo: 1 });
		const plain = await seedQueued({ snapshot: { project_name: "acme" } });

		const first = await claim(oldSelf);
		expect(first.status).toBe(200);
		expect(first.body.job?.id).toBe(plain.jobId);

		const again = await claim(oldSelf);
		expect(again.status).toBe(200);
		expect(again.body.job ?? null).toBeNull();
		const still = await jobRow(deploy.jobId);
		expect(still.status).toBe("QUEUED");
		expect(still.runner_id).toBeNull();

		const capable = await claim(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		expect(capable.status).toBe(200);
		expect(capable.body.job?.id).toBe(deploy.jobId);
		expect(capable.body.job?.config_snapshot).toEqual(OCI_BYO_SNAPSHOT);
		expect((await jobRow(deploy.jobId)).runner_id).toBe(newSelf.id);
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("presence, not time: a BYO DEPLOY held by state_object_busy for hours is still skipped by the old runner while a capable runner is live", async () => {
		const oldSelf = await seedRunner("self");
		const newSelf = await seedRunner("self");
		await goLive(oldSelf);
		await goLive(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const on = await seedEnvironment();
		const key = await holdState(on);
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT, queuedMinutesAgo: 180, on });

		// Held by the state lock: nobody may take it.
		expect((await claim(oldSelf)).body.job ?? null).toBeNull();
		expect((await claim(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER)).body.job ?? null).toBeNull();

		// The apply ends: the lock is released and the whole pool is woken. The old runner's claim lands
		// first and still skips it, three hours after enqueue, because a capable runner is live.
		await getServiceDb().delete(tofuStateLocks).where(eq(tofuStateLocks.state_key, key));
		const oldRace = await claim(oldSelf);
		expect(oldRace.status).toBe(200);
		expect(oldRace.body.job ?? null).toBeNull();
		expect((await jobRow(deploy.jobId)).status).toBe("QUEUED");

		const capable = await claim(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		expect(capable.body.job?.id).toBe(deploy.jobId);
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("no live capable runner (none ever, one gone stale, one DRAINING): the old runner is handed it and it FAILS with the update-the-runner reason", async () => {
		const oldSelf = await seedRunner("self");
		const none = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT });
		const refused = await claim(oldSelf);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/Update the runner/);
		await expectFailedWithUpdateReason(none);

		// A capable runner that WAS live: once its heartbeat is outside the liveness window it no longer counts.
		emitAlertEventSafe.mockClear();
		const staleCapable = await seedRunner("self");
		await goLive(staleCapable, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		await getServiceDb()
			.update(runners)
			.set({ last_heartbeat: new Date(Date.now() - 10 * 60_000) })
			.where(eq(runners.id, staleCapable.id));
		const stale = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT });
		expect((await claim(oldSelf)).status).toBe(409);
		await expectFailedWithUpdateReason(stale);

		// A DRAINING capable runner is being retired and claims nothing, so it does not count either.
		emitAlertEventSafe.mockClear();
		const drainingCapable = await seedRunner("self");
		await goLive(drainingCapable, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		await getServiceDb().update(runners).set({ status: "DRAINING" }).where(eq(runners.id, drainingCapable.id));
		const draining = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT });
		expect((await claim(oldSelf)).status).toBe(409);
		await expectFailedWithUpdateReason(draining);
	});

	it("mixed managed pool: the old runner (no header) skips while a capable managed runner is live, and the capable one claims", async () => {
		const cloudId = await seedIdentity();
		const oldManaged = await seedRunner("managed", cloudId);
		const newManaged = await seedRunner("managed", cloudId);
		await goLive(newManaged, `other, ${RUNNER_CAPABILITY_ADDON_BYO_MARKER}`);
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT, cloudIdentityId: cloudId, queuedMinutesAgo: 120 });

		const skipped = await claim(oldManaged);
		expect(skipped.status).toBe(200);
		expect(skipped.body.job ?? null).toBeNull();
		expect((await jobRow(deploy.jobId)).status).toBe("QUEUED");

		const capable = await claim(newManaged, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		expect(capable.body.job?.id).toBe(deploy.jobId);
		expect((await jobRow(deploy.jobId)).runner_id).toBe(newManaged.id);
	});

	it("managed pool with no live capable runner: the old managed runner (no header) is handed it and it FAILS with the reason", async () => {
		const cloudId = await seedIdentity();
		const oldManaged = await seedRunner("managed", cloudId);
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT, cloudIdentityId: cloudId });
		const refused = await claim(oldManaged);
		expect(refused.status).toBe(409);
		await expectFailedWithUpdateReason(deploy);
	});

	it("an ASSIGNED OCI BYO DEPLOY fails at once on its runner, even with a capable runner live (no other runner may take it)", async () => {
		const oldSelf = await seedRunner("self");
		const newSelf = await seedRunner("self");
		await goLive(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT, assignedRunnerId: oldSelf.id });
		const refused = await claim(oldSelf);
		expect(refused.status).toBe(409);
		await expectFailedWithUpdateReason(deploy);
	});

	it("a git-only BYO DEPLOY is claimable by a runner without the capability, served without the marker", async () => {
		const oldSelf = await seedRunner("self");
		const newSelf = await seedRunner("self");
		await goLive(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const deploy = await seedQueued({ snapshot: GIT_BYO_SNAPSHOT });
		const res = await claim(oldSelf);
		expect(res.status).toBe(200);
		expect(res.body.job?.id).toBe(deploy.jobId);
		const addons = z.array(z.record(z.string(), z.unknown())).parse(res.body.job?.config_snapshot.addons);
		expect(addons[0]).not.toHaveProperty("byo");
		expect(addons[0]?.source).toBe("git");
		expect((await jobRow(deploy.jobId)).runner_id).toBe(oldSelf.id);
	});

	it("an old console pod (3-argument claim, NULL capabilities) gets no capability gate: a stamped capable runner claiming through it is handed the job", async () => {
		const newSelf = await seedRunner("self");
		await goLive(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT });
		// The stamp survives the NULL call (COALESCE), and the NULL call is not read as "no capabilities".
		expect(await claimAsOldPod(newSelf)).toBe(deploy.jobId);
		const [r] = await getServiceDb().select({ caps: runners.capabilities }).from(runners).where(eq(runners.id, newSelf.id));
		expect(r.caps).toEqual([RUNNER_CAPABILITY_ADDON_BYO_MARKER]);
	});

	it("after a console rollback (every claim and heartbeat NULL), a once-capable live runner never wedges the job: it is still claimed", async () => {
		const oldSelf = await seedRunner("self");
		const newSelf = await seedRunner("self");
		await goLive(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT });
		// The rolled-back console: 4-argument heartbeats and 3-argument claims only.
		await getServiceDb().execute(sql`select runner_heartbeat(${newSelf.id}::uuid, ${hashRunnerToken(newSelf.token)}, null, null)`);
		expect(await claimAsOldPod(oldSelf)).toBe(deploy.jobId);
		expect((await jobRow(deploy.jobId)).status).toBe("CLAIMED");
	});

	it("a capable runner that only heartbeats (claim loop wedged) stops holding the job; a busy one holding an in-flight job keeps holding it", async () => {
		const oldSelf = await seedRunner("self");
		const capable = await seedRunner("self");
		await goLive(capable, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const db = getServiceDb();
		await db.update(runners).set({ last_claim_at: new Date(Date.now() - 10 * 60_000) }).where(eq(runners.id, capable.id));
		await heartbeat(capable, RUNNER_CAPABILITY_ADDON_BYO_MARKER);

		// Busy: it holds a PROCESSING job, so its silent claim loop is accounted for.
		const busy = await seedQueued({ snapshot: { project_name: "acme" } });
		await db.update(jobs).set({ status: "PROCESSING", runner_id: capable.id }).where(eq(jobs.id, busy.jobId));
		const held = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT });
		expect((await claim(oldSelf)).body.job ?? null).toBeNull();
		expect((await jobRow(held.jobId)).status).toBe("QUEUED");

		// Its job finishes but it never claims again: after the window it no longer holds the job.
		await db.update(jobs).set({ status: "SUCCESS", completed_at: new Date() }).where(eq(jobs.id, busy.jobId));
		const refused = await claim(oldSelf);
		expect(refused.status).toBe(409);
		await expectFailedWithUpdateReason(held);
	});

	it("a capable runner OUTSIDE the job's pool holds nothing: another org, another cloud identity, another provider", async () => {
		const cloudId = await seedIdentity();
		const otherCloudId = await seedIdentity();
		const oldManaged = await seedRunner("managed", cloudId);

		const otherOrg = await seedRunner("self", null, randomUUID());
		await goLive(otherOrg, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const otherIdentity = await seedRunner("managed", otherCloudId);
		await goLive(otherIdentity, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		const otherProvider = await seedRunner("managed", cloudId);
		await goLive(otherProvider, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		await getServiceDb().update(runners).set({ supported_providers: ["aws"] }).where(eq(runners.id, otherProvider.id));

		// The job is the managed pool's, keyed to cloudId (provider hetzner) — none of the three may take it.
		const deploy = await seedQueued({ snapshot: OCI_BYO_SNAPSHOT, cloudIdentityId: cloudId });
		const refused = await claim(oldManaged);
		expect(refused.status).toBe(409);
		await expectFailedWithUpdateReason(deploy);
	});

	it("live_runner_has_capabilities is not executable by the app role (no cross-tenant oracle)", async () => {
		const [row] = await getServiceDb().execute<{ can: boolean }>(
			sql`select has_function_privilege('alethia_app', 'public.live_runner_has_capabilities(text[], uuid, boolean, uuid, public.cloud_provider)', 'EXECUTE') as can`,
		);
		expect(row.can).toBe(false);
	});

	it("jobs.required_capabilities is derived by the trigger, whatever the INSERT wrote", async () => {
		const db = getServiceDb();
		const { projectId, envId } = await seedEnvironment();
		const [oci] = await db
			.insert(jobs)
			.values({ user_id: USER, org_id: ORG, project_id: projectId, environment_id: envId, job_type: "DEPLOY", status: "QUEUED", config_snapshot: OCI_BYO_SNAPSHOT, required_capabilities: [] })
			.returning({ caps: jobs.required_capabilities, id: jobs.id });
		expect(oci.caps).toEqual([RUNNER_CAPABILITY_ADDON_BYO_MARKER]);
		const [git] = await db
			.insert(jobs)
			.values({ user_id: USER, org_id: ORG, project_id: projectId, environment_id: envId, job_type: "DEPLOY", status: "QUEUED", config_snapshot: GIT_BYO_SNAPSHOT, required_capabilities: ["forged"] })
			.returning({ caps: jobs.required_capabilities });
		expect(git.caps).toEqual([]);
		// A rewritten snapshot re-derives it.
		const [rewritten] = await db
			.update(jobs)
			.set({ config_snapshot: GIT_BYO_SNAPSHOT })
			.where(eq(jobs.id, oci.id))
			.returning({ caps: jobs.required_capabilities });
		expect(rewritten.caps).toEqual([]);
		// A direct write of the column itself is re-derived too.
		const [direct] = await db
			.update(jobs)
			.set({ required_capabilities: [RUNNER_CAPABILITY_ADDON_BYO_MARKER, "forged"] })
			.where(eq(jobs.id, oci.id))
			.returning({ caps: jobs.required_capabilities });
		expect(direct.caps).toEqual([]);
	});

	it("job_required_capabilities agrees with refusalForRunner over the shared fixtures and the edge shapes", async () => {
		const cases: Array<[string, "DEPLOY" | "PLAN" | "DESTROY", Record<string, unknown>]> = [
			["fixture with the marker", "DEPLOY", fixture("with-byo-marker.json")],
			["fixture without the marker", "DEPLOY", fixture("without-byo-marker.json")],
			["fixture with the marker, PLAN", "PLAN", fixture("with-byo-marker.json")],
			["fixture with the marker, DESTROY", "DESTROY", fixture("with-byo-marker.json")],
			// #6494: the preview prefix is stripped, never required — no runner is ever refused for it.
			["fixture with the preview prefix", "DEPLOY", fixture("with-preview-namespace-prefix.json")],
			// #6541: byo_admission is stripped, never required, as above.
			["fixture with byo_admission", "DEPLOY", fixture("with-byo-admission.json")],
			["OCI BYO", "DEPLOY", OCI_BYO_SNAPSHOT],
			["git-only BYO", "DEPLOY", GIT_BYO_SNAPSHOT],
			["byo with no source", "DEPLOY", { addons: [{ id: "x", byo: true }] }],
			["byo false", "DEPLOY", { addons: [{ id: "x", source: "helm", byo: false }] }],
			["byo as a string", "DEPLOY", { addons: [{ id: "x", source: "helm", byo: "true" }] }],
			["non-object entries", "DEPLOY", { addons: [null, 3, "s", { id: "x", source: "helm", byo: true }] }],
			["addons not an array", "DEPLOY", { addons: { id: "x", byo: true } }],
			["no addons", "DEPLOY", {}],
		];
		for (const [name, jobType, snapshot] of cases) {
			const [row] = await getServiceDb().execute<{ caps: string }>(
				sql`select array_to_string(public.job_required_capabilities(${jobType}::provision_job_type, ${JSON.stringify(snapshot)}::jsonb), ',') as caps`,
			);
			const sqlNeedsMarker = row.caps === RUNNER_CAPABILITY_ADDON_BYO_MARKER;
			const tsRefuses = refusalForRunner(jobType, snapshot, new Set()) !== null;
			expect({ name, sqlNeedsMarker }).toEqual({ name, sqlNeedsMarker: tsRefuses });
			expect(refusalForRunner(jobType, snapshot, new Set([RUNNER_CAPABILITY_ADDON_BYO_MARKER]))).toBeNull();
		}
	});
});
