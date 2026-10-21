// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6126): what the Evidence page's change triggers in lib/db/programmables.sql actually
// NOTIFY, against real Postgres — a drift posture and a security posture (`environment_drift`,
// `environment_security` → the `environments` topic) and a recorded waiver (`jobs.verify_override`
// → the `jobs` topic). A mocked database cannot answer this: the property is a trigger's WHEN clause
// meeting real UPSERTs, written the way the job-status route writes them.
//
// DETERMINISM, as in realtime-notify.test.ts: after each operation the test commits a sentinel NOTIFY
// and waits for it on a dedicated LISTEN connection; everything before the sentinel is exactly what
// the operation emitted. So a ZERO below is a real zero, and every zero has a control that emits one.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	environmentDrift,
	environmentSecurity,
	jobs,
	organization,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { describeIfDb, seedJob } from "./db";

const USER = randomUUID();
const ORG = randomUUID();

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
let projectId = "";
let envId = "";
let jobId = "";

/** Waits until the sentinel `n` has been heard, then returns (and forgets) every notice before it. */
async function drainUntil(n: string): Promise<Notice[]> {
	for (let i = 0; i < 200; i++) {
		const at = heard.findIndex((x) => x.t === "_sentinel" && x.n === n);
		if (at >= 0) return heard.splice(0, at + 1).slice(0, at);
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sentinel ${n} never arrived — the LISTEN connection is not hearing alethia_change`);
}

/** Runs `op` (committed), then returns exactly the notices it emitted. */
async function emitted(op: () => Promise<unknown>): Promise<Notice[]> {
	await op();
	const n = randomUUID();
	await db().execute(sql`select pg_notify('alethia_change', ${JSON.stringify({ t: "_sentinel", n })})`);
	return drainUntil(n);
}

/** Upserts the drift posture exactly as `recordDriftPosture` does (lib/drift/posture.ts). */
function recordDrift(inSync: boolean, drifted: number, scannedAt: Date) {
	return db()
		.insert(environmentDrift)
		.values({ project_id: projectId, environment_id: envId, in_sync: inSync, drifted, scanned_at: scannedAt })
		.onConflictDoUpdate({
			target: [environmentDrift.project_id, environmentDrift.environment_id],
			set: { in_sync: inSync, drifted, scanned_at: scannedAt, updated_at: new Date() },
		});
}

/** Upserts the security posture exactly as `recordSecurityPosture` does (lib/addons/inspection-persistence.ts). */
function recordSecurity(critical: number, scannedAt: Date) {
	const values = { critical, high: 0, medium: 0, low: 0, report_count: 1, scanned: true, scanned_at: scannedAt };
	return db()
		.insert(environmentSecurity)
		.values({ project_id: projectId, environment_id: envId, ...values })
		.onConflictDoUpdate({
			target: [environmentSecurity.project_id, environmentSecurity.environment_id],
			set: { ...values, updated_at: new Date() },
		});
}

/** The notice a posture write must emit: the ENVIRONMENT's id, routed by the parent project's org. */
const postureNotice = () => ({ t: "environments", id: envId, o: ORG, u: null, p: projectId });

describeIfDb("the Evidence page's change triggers (#6126) — what reaches alethia_change", () => {
	beforeAll(async () => {
		listener = postgres(process.env.ALETHIA_DATABASE_URL ?? "", { max: 1 });
		await listener.listen("alethia_change", (payload) => heard.push(JSON.parse(payload)));

		await db().insert(organization).values({ id: ORG, name: `it-6126-${ORG.slice(0, 8)}` });
		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				org_id: ORG,
				project_name: `it-6126-${ORG.slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;
		const [e] = await db()
			.insert(projectEnvironments)
			.values({ project_id: projectId, user_id: USER, org_id: ORG, name: "prod", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envId = e.id;
		jobId = await seedJob(USER, ORG, { project_id: projectId, environment_id: envId, job_type: "DEPLOY" });
		// Drain the setup's own notices, so each case hears only itself.
		await emitted(async () => {});
	});

	afterAll(async () => {
		await listener?.end({ timeout: 1 });
		if (jobId) await db().delete(jobs).where(eq(jobs.id, jobId));
		if (projectId) await db().delete(projects).where(eq(projects.id, projectId)); // cascades
		await db().delete(organization).where(eq(organization.id, ORG));
	});

	it("a drift scan is one `environments` notice naming the environment — first write and every change", async () => {
		const t0 = new Date("2026-10-01T00:00:00Z");
		expect(await emitted(() => recordDrift(true, 0, t0))).toEqual([postureNotice()]);
		expect(await emitted(() => recordDrift(false, 2, t0))).toEqual([postureNotice()]);
		// A re-scan that found the same posture still moves the Checked time the page shows.
		expect(await emitted(() => recordDrift(false, 2, new Date("2026-10-02T00:00:00Z")))).toEqual([postureNotice()]);
	});

	it("a drift write the page does not show (updated_at alone) emits nothing", async () => {
		expect(
			await emitted(() =>
				db().update(environmentDrift).set({ updated_at: new Date() }).where(eq(environmentDrift.environment_id, envId)),
			),
		).toEqual([]);
	});

	it("a security scan is one `environments` notice; a write that changes nothing shown emits none", async () => {
		const t0 = new Date("2026-10-01T00:00:00Z");
		expect(await emitted(() => recordSecurity(1, t0))).toEqual([postureNotice()]);
		expect(await emitted(() => recordSecurity(3, t0))).toEqual([postureNotice()]);
		expect(
			await emitted(() =>
				db()
					.update(environmentSecurity)
					.set({ updated_at: new Date() })
					.where(eq(environmentSecurity.environment_id, envId)),
			),
		).toEqual([]);
	});

	it("recording a waiver on a queued job is one `jobs` notice (verify_override is a column the UI shows)", async () => {
		const notices = await emitted(() =>
			db()
				.update(jobs)
				.set({
					verify_override: { controls: ["KEYLESS-001"], reason: "window", by: USER },
				})
				.where(eq(jobs.id, jobId)),
		);
		expect(notices).toEqual([{ t: "jobs", id: jobId, o: ORG, u: USER, p: projectId }]);
	});
});
