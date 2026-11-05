// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6458): the claim is capability-aware. Against real Postgres, the real claim route
// and the real claim_next_job:
//
//   · a MIXED pool — a runner without `addon-byo-marker` leaves an OCI BYO DEPLOY QUEUED (and still
//     claims other work behind it), and a runner that advertises the capability claims it. Both the
//     self-runner and the managed-pool branch of claim_next_job are driven;
//   · the BOUND — a job no capable runner claimed within capability_wait_bound is handed to the
//     incapable runner, and refusalForRunner fails it through recordJobFailed with the "update the
//     runner" reason (job and environment FAILED, alert raised);
//   · a git-only BYO snapshot is claimable by a runner without the capability, served stripped;
//   · the SQL reading (job_required_capabilities) agrees with the TS one (refusalForRunner) over the
//     shared fixtures in packages/core/types/testdata/snapshot-capabilities and the edge shapes.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, jobs, projectEnvironments, projects, runners } from "@/lib/db/schema";
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

/** A runner in this file's org (self) or keyed to one cloud identity (managed), with its token. */
async function seedRunner(kind: "self" | "managed", cloudIdentityId: string | null = null): Promise<SeededRunner> {
	const token = `it-cap-skip-${randomUUID()}`;
	const [r] = await getServiceDb()
		.insert(runners)
		.values(
			kind === "self"
				? {
						user_id: USER,
						org_id: ORG,
						name: `it-cap-skip-${token.slice(-12)}`,
						operator: "self",
						provisioning: "registered",
						token_hash: hashRunnerToken(token),
						status: "ONLINE",
					}
				: {
						name: `it-cap-skip-${token.slice(-12)}`,
						operator: "managed",
						token_hash: hashRunnerToken(token),
						status: "ONLINE",
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

/**
 * One unassigned QUEUED job. `queuedMinutesAgo` back-dates `updated_at` — at INSERT, because the
 * BEFORE UPDATE trigger would overwrite it on an UPDATE.
 */
async function seedQueued(opts: {
	jobType: "DEPLOY" | "PLAN";
	snapshot: Record<string, unknown>;
	cloudIdentityId?: string;
	queuedMinutesAgo?: number;
}): Promise<{ jobId: string; envId: string }> {
	const { projectId, envId } = await seedEnvironment();
	const at = new Date(Date.now() - (opts.queuedMinutesAgo ?? 0) * 60_000);
	const [row] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: ORG,
			project_id: projectId,
			environment_id: envId,
			job_type: opts.jobType,
			status: "QUEUED",
			config_snapshot: opts.snapshot,
			cloud_identity_id: opts.cloudIdentityId ?? null,
			requires_self_runner: false,
			created_at: at,
			updated_at: at,
		})
		.returning({ id: jobs.id });
	return { jobId: row.id, envId };
}

const ClaimBody = z.object({
	job: z.object({ id: z.string(), config_snapshot: z.record(z.string(), z.unknown()) }).nullable().optional(),
	error: z.string().optional(),
});

/** Claims as `runner`, advertising `capabilities` in the header (none: a runner built before it). */
async function claim(runner: SeededRunner, capabilities?: string) {
	const headers: Record<string, string> = { "X-Runner-ID": runner.id, "X-Runner-Token": runner.token };
	if (capabilities !== undefined) headers["X-Runner-Capabilities"] = capabilities;
	const res = await claimPost(new Request("https://console.local/api/jobs/claim", { method: "POST", headers }));
	return { status: res.status, body: ClaimBody.parse(await res.json()) };
}

/** The job row's status, runner and error. */
async function jobRow(jobId: string) {
	const [row] = await getServiceDb()
		.select({ status: jobs.status, runner_id: jobs.runner_id, error: jobs.error_message })
		.from(jobs)
		.where(eq(jobs.id, jobId));
	return row;
}

/** Settles every job this file left in flight, so one case's leftovers never feed the next claim. */
async function settleAll() {
	await getServiceDb()
		.update(jobs)
		.set({ status: "CANCELLED", completed_at: new Date() })
		.where(eq(jobs.user_id, USER));
}

describeIfDb("claim_next_job skips a job the runner lacks the capability for", () => {
	let oldSelf: SeededRunner;
	let newSelf: SeededRunner;

	beforeAll(async () => {
		oldSelf = await seedRunner("self");
		newSelf = await seedRunner("self");
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(eq(jobs.user_id, USER));
		if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
		if (runnerIds.length) await db.delete(runners).where(inArray(runners.id, runnerIds));
		if (cloudIds.length) await db.delete(cloudIdentities).where(inArray(cloudIdentities.id, cloudIds));
	});

	beforeEach(async () => {
		emitAlertEventSafe.mockClear();
		await settleAll();
	});

	it("mixed self pool: the old runner skips the OCI BYO DEPLOY (and takes the plain DEPLOY queued behind it); the new runner claims the BYO one", async () => {
		// Same job type, so the same priority: the BYO DEPLOY is first in line by age, and only the
		// capability skip lets the old runner reach the plain one behind it.
		const deploy = await seedQueued({ jobType: "DEPLOY", snapshot: OCI_BYO_SNAPSHOT, queuedMinutesAgo: 1 });
		const plain = await seedQueued({ jobType: "DEPLOY", snapshot: { project_name: "acme" } });

		const first = await claim(oldSelf);
		expect(first.status).toBe(200);
		expect(first.body.job?.id).toBe(plain.jobId);
		expect((await jobRow(deploy.jobId)).status).toBe("QUEUED");

		const again = await claim(oldSelf);
		expect(again.status).toBe(200);
		expect(again.body.job ?? null).toBeNull();
		const still = await jobRow(deploy.jobId);
		expect(still.status).toBe("QUEUED");
		expect(still.runner_id).toBeNull();

		const capable = await claim(newSelf, RUNNER_CAPABILITY_ADDON_BYO_MARKER);
		expect(capable.status).toBe(200);
		expect(capable.body.job?.id).toBe(deploy.jobId);
		// Served whole: the capable runner reads the marker.
		expect(capable.body.job?.config_snapshot).toEqual(OCI_BYO_SNAPSHOT);
		const claimed = await jobRow(deploy.jobId);
		expect(claimed.status).toBe("CLAIMED");
		expect(claimed.runner_id).toBe(newSelf.id);
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("mixed managed pool: the same skip in the shared-pool branch", async () => {
		const cloudId = await seedIdentity();
		const oldManaged = await seedRunner("managed", cloudId);
		const newManaged = await seedRunner("managed", cloudId);
		const deploy = await seedQueued({ jobType: "DEPLOY", snapshot: OCI_BYO_SNAPSHOT, cloudIdentityId: cloudId });

		const skipped = await claim(oldManaged, "some-other-capability");
		expect(skipped.status).toBe(200);
		expect(skipped.body.job ?? null).toBeNull();
		expect((await jobRow(deploy.jobId)).status).toBe("QUEUED");

		const capable = await claim(newManaged, `other, ${RUNNER_CAPABILITY_ADDON_BYO_MARKER}`);
		expect(capable.status).toBe(200);
		expect(capable.body.job?.id).toBe(deploy.jobId);
		expect((await jobRow(deploy.jobId)).runner_id).toBe(newManaged.id);
	});

	it("no capable runner: within the bound the job waits; past it the old runner is handed it and it FAILS with the update-the-runner reason", async () => {
		const fresh = await seedQueued({ jobType: "DEPLOY", snapshot: OCI_BYO_SNAPSHOT, queuedMinutesAgo: 14 });
		const waiting = await claim(oldSelf);
		expect(waiting.body.job ?? null).toBeNull();
		expect((await jobRow(fresh.jobId)).status).toBe("QUEUED");
		await settleAll();

		const stale = await seedQueued({ jobType: "DEPLOY", snapshot: OCI_BYO_SNAPSHOT, queuedMinutesAgo: 16 });
		const refused = await claim(oldSelf);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/Update the runner/);

		const row = await jobRow(stale.jobId);
		expect(row.status).toBe("FAILED");
		expect(row.error).toMatch(/bring-your-own OCI chart/);
		expect(row.error).toMatch(/Update the runner/);
		const [env] = await getServiceDb()
			.select({ status: projectEnvironments.status })
			.from(projectEnvironments)
			.where(eq(projectEnvironments.id, stale.envId));
		expect(env.status).toBe("FAILED");
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			ORG,
			"system.job.failed",
			expect.objectContaining({ job_id: stale.jobId, job_type: "DEPLOY" }),
		);
	});

	it("a git-only BYO DEPLOY is claimable by a runner without the capability, served without the marker", async () => {
		const deploy = await seedQueued({ jobType: "DEPLOY", snapshot: GIT_BYO_SNAPSHOT });
		const res = await claim(oldSelf);
		expect(res.status).toBe(200);
		expect(res.body.job?.id).toBe(deploy.jobId);
		const addons = z.array(z.record(z.string(), z.unknown())).parse(res.body.job?.config_snapshot.addons);
		expect(addons[0]).not.toHaveProperty("byo");
		expect(addons[0]?.source).toBe("git");
		expect((await jobRow(deploy.jobId)).runner_id).toBe(oldSelf.id);
	});

	it("job_required_capabilities agrees with refusalForRunner over the shared fixtures and the edge shapes", async () => {
		const cases: Array<[string, "DEPLOY" | "PLAN" | "DESTROY", Record<string, unknown>]> = [
			["fixture with the marker", "DEPLOY", fixture("with-byo-marker.json")],
			["fixture without the marker", "DEPLOY", fixture("without-byo-marker.json")],
			["fixture with the marker, PLAN", "PLAN", fixture("with-byo-marker.json")],
			["fixture with the marker, DESTROY", "DESTROY", fixture("with-byo-marker.json")],
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
			// And with the capability, neither side holds the job back.
			expect(refusalForRunner(jobType, snapshot, new Set([RUNNER_CAPABILITY_ADDON_BYO_MARKER]))).toBeNull();
		}
	});
});
