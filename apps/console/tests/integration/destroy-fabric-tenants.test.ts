// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#5249): a `dedicated` environment owns its Fabric — the cluster every namespace/vcluster
// environment placed on that Fabric runs in. Its DESTROY must not START while any of those tenants is
// still live, or the tenants are orphaned and their per-namespace cloud identities leak.
//
// The order of a cascade (tenants first, owner last) is enforced HERE, at claim time, by
// `destroy_waits_on_tenants` inside `claim_next_job` — not by queue position or timing. That is a
// plpgsql behaviour, so a mocked db cannot test it; this suite drives the real RPC as a real self
// runner, the same way job-state-serialization.test.ts tests state_object_busy.
//
// It also pins that the app-side read (readLiveFabricTenants — what the user is told, and what a
// cascade queues) agrees with the SQL predicate (what a runner may start) on what "live" means, and
// that the fleet's dispatchable backlog does not count an owner DESTROY no runner may claim.

import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import {
	jobs,
	projectEnvironments,
	projectFabrics,
	projects,
	runners,
} from "@/lib/db/schema";
import type { ProjectStatus } from "@/lib/db/schema/enums";
import { dispatchableBacklogByProvider } from "@/lib/fleet/queue";
import {
	type DestroyTreeSubject,
	readLiveFabricTenants,
} from "@/lib/queries/destroy-tree";
import { describeIfDb } from "./db";

const USER = randomUUID();
const RUNNER_TOKEN = randomUUID();
const TOKEN_HASH = createHash("sha256").update(RUNNER_TOKEN).digest("hex");
// No other integration suite queues on this provider, so a dispatchable-count DELTA is ours alone.
const PROVIDER = "digitalocean";

let runnerId: string;
let projectId: string;
let fabricId: string;
let ownerId: string; // prod — dedicated, owns the Fabric
let nsId: string; // dev-1 — namespace on prod's Fabric
let vcId: string; // staging — vcluster on prod's Fabric
let otherOwnerId: string; // a second dedicated env on its OWN Fabric — never a tenant of prod

const db = () => getServiceDb();

/** Queues a job on `env` (QUEUED, unassigned) and returns its id. */
async function queue(
	env: string,
	type: "DEPLOY" | "DESTROY" = "DESTROY",
): Promise<string> {
	const [row] = await db()
		.insert(jobs)
		.values({
			user_id: USER,
			org_id: USER,
			job_type: type,
			status: "QUEUED",
			project_id: projectId,
			environment_id: env,
			config_snapshot: {},
			requires_self_runner: false,
			provider: PROVIDER,
		})
		.returning({ id: jobs.id });
	return row.id;
}

/** Runs the real claim RPC as our seeded self runner. Returns the claimed job id, or null. */
async function claim(): Promise<string | null> {
	const rows = await db().execute<{ id: string }>(
		sql`select id from claim_next_job(${runnerId}::uuid, ${TOKEN_HASH}, NULL)`,
	);
	return rows[0]?.id ?? null;
}

/** Sets an environment's status directly (the runner callbacks are not under test here). */
async function setStatus(env: string, status: ProjectStatus): Promise<void> {
	await db()
		.update(projectEnvironments)
		.set({ status })
		.where(eq(projectEnvironments.id, env));
}

/** The SQL predicate itself, for a DESTROY of `env`. */
async function waits(env: string, type: "DEPLOY" | "DESTROY" = "DESTROY"): Promise<boolean> {
	const [row] = await db().execute<{ w: boolean }>(
		sql`select public.destroy_waits_on_tenants(${type}::provision_job_type, ${env}::uuid) as w`,
	);
	return row?.w === true;
}

/** Reads an environment as the destroy-tree module sees it. */
async function subject(env: string): Promise<DestroyTreeSubject> {
	const [row] = await db()
		.select({
			id: projectEnvironments.id,
			name: projectEnvironments.name,
			project_id: projectEnvironments.project_id,
			fabric_id: projectEnvironments.fabric_id,
			placement_mode: projectEnvironments.placement_mode,
			status: projectEnvironments.status,
		})
		.from(projectEnvironments)
		.where(eq(projectEnvironments.id, env));
	return row;
}

async function jobStatus(id: string) {
	const [row] = await db().select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id));
	return row?.status;
}

describeIfDb("destroy_waits_on_tenants — an owner's DESTROY waits for its Fabric's tenants", () => {
	beforeAll(async () => {
		// A SELF runner: its claim branch is uncapped, so nothing but the guards bounds what it takes.
		const [r] = await db()
			.insert(runners)
			.values({
				user_id: USER,
				org_id: USER,
				name: `it-fabric-tenants-${randomUUID().slice(0, 8)}`,
				operator: "self",
				provisioning: "registered",
				status: "ONLINE",
				token_hash: TOKEN_HASH,
			})
			.returning({ id: runners.id });
		runnerId = r.id;

		const [p] = await db()
			.insert(projects)
			.values({
				user_id: USER,
				project_name: `fabric-tenants-${randomUUID().slice(0, 8)}`,
				region: "eu-central-1",
				iac_version: "1.9.5",
			})
			.returning({ id: projects.id });
		projectId = p.id;

		const [f] = await db()
			.insert(projectFabrics)
			.values({ project_id: projectId, user_id: USER, name: "prod" })
			.returning({ id: projectFabrics.id });
		fabricId = f.id;
		const [f2] = await db()
			.insert(projectFabrics)
			.values({ project_id: projectId, user_id: USER, name: "qa" })
			.returning({ id: projectFabrics.id });

		const env = (
			name: string,
			placement: "dedicated" | "namespace" | "vcluster",
			fabric: string,
			isDefault: boolean,
		) => ({
			project_id: projectId,
			user_id: USER,
			name,
			status: "ACTIVE" as const,
			is_default: isDefault,
			fabric_id: fabric,
			placement_mode: placement,
		});
		const rows = await db()
			.insert(projectEnvironments)
			.values([
				env("prod", "dedicated", fabricId, true),
				env("dev-1", "namespace", fabricId, false),
				env("staging", "vcluster", fabricId, false),
				env("qa", "dedicated", f2.id, false),
			])
			.returning({ id: projectEnvironments.id, name: projectEnvironments.name });
		const byName = new Map(rows.map((x) => [x.name, x.id]));
		ownerId = byName.get("prod") ?? "";
		nsId = byName.get("dev-1") ?? "";
		vcId = byName.get("staging") ?? "";
		otherOwnerId = byName.get("qa") ?? "";
	});

	beforeEach(async () => {
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
		await db()
			.update(projectEnvironments)
			.set({ status: "ACTIVE" })
			.where(eq(projectEnvironments.project_id, projectId));
	});

	afterAll(async () => {
		await db().delete(jobs).where(eq(jobs.project_id, projectId));
		await db().delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
		await db().delete(projectFabrics).where(eq(projectFabrics.project_id, projectId));
		await db().delete(projects).where(eq(projects.id, projectId));
		await db().delete(runners).where(eq(runners.id, runnerId));
	});

	// ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
	it("does NOT claim the owner's DESTROY while a tenant is live, and leaves it QUEUED", async () => {
		const owner = await queue(ownerId);
		expect(await claim()).toBeNull();
		expect(await jobStatus(owner)).toBe("QUEUED");
	});

	// ── AND IT IS RELEASED, NOT STRANDED ────────────────────────────────────────────────────────────
	it("claims the owner's DESTROY once every tenant is DESTROYED (or DRAFT)", async () => {
		const owner = await queue(ownerId);
		await setStatus(nsId, "DESTROYED");
		expect(await claim()).toBeNull(); // staging is still live
		await setStatus(vcId, "DRAFT"); // never applied — nothing in the cluster to orphan
		expect(await claim()).toBe(owner);
	});

	// ── THE CASCADE ORDER ───────────────────────────────────────────────────────────────────────────
	// The owner's job is the OLDEST and so would be first in line on every ordering the queue has —
	// which is exactly why the order cannot be left to queue position. The tenants go first anyway.
	it("runs a cascade tenants-first even though the owner's job was queued first", async () => {
		const owner = await queue(ownerId);
		const ns = await queue(nsId);
		const vc = await queue(vcId);

		const first = await claim();
		const second = await claim();
		expect(new Set([first, second])).toEqual(new Set([ns, vc]));
		expect(await claim()).toBeNull(); // both tenants are mid-destroy — still live

		// The runner callbacks move a tenant DESTROYING → DESTROYED; only then does the owner go.
		await setStatus(nsId, "DESTROYING");
		await setStatus(vcId, "DESTROYED");
		expect(await claim()).toBeNull(); // DESTROYING still counts as live
		await setStatus(nsId, "DESTROYED");
		expect(await claim()).toBe(owner);
	});

	// ── A FAILED TENANT HOLDS THE OWNER (visibly — see the destroy tree's waiting_on) ───────────────
	it("keeps holding the owner while a tenant's destroy has FAILED", async () => {
		const owner = await queue(ownerId);
		await setStatus(nsId, "FAILED");
		await setStatus(vcId, "DESTROYED");
		expect(await claim()).toBeNull();
		expect(await jobStatus(owner)).toBe("QUEUED");
	});

	// ── THE RACE THE ENQUEUE-TIME REFUSAL CANNOT SEE ────────────────────────────────────────────────
	// The owner's DESTROY was accepted when no tenant was live; a tenant deploy was queued after it.
	// The claim reads the tenant's status at claim time, so the owner waits for it.
	it("holds an owner DESTROY that was queued before a tenant became live", async () => {
		await setStatus(nsId, "DRAFT");
		await setStatus(vcId, "DESTROYED");
		const owner = await queue(ownerId);
		await setStatus(nsId, "QUEUED"); // enqueueDeploy moves the tenant DRAFT → QUEUED
		const deploy = await queue(nsId, "DEPLOY");
		expect(await claim()).toBe(deploy);
		expect(await claim()).toBeNull();
		expect(await jobStatus(owner)).toBe("QUEUED");
	});

	// ── AND IT MUST NOT OVER-BLOCK ──────────────────────────────────────────────────────────────────
	it("never holds a non-DESTROY job on the owner, a tenant's own DESTROY, or another Fabric's owner", async () => {
		expect(await waits(ownerId, "DEPLOY")).toBe(false);
		expect(await waits(nsId)).toBe(false);
		expect(await waits(vcId)).toBe(false);
		expect(await waits(otherOwnerId)).toBe(false);
		expect(await waits(ownerId)).toBe(true);

		const deploy = await queue(ownerId, "DEPLOY");
		expect(await claim()).toBe(deploy);
		const qa = await queue(otherOwnerId);
		expect(await claim()).toBe(qa);
	});

	// ── THE TWO HALVES AGREE ON "LIVE" ──────────────────────────────────────────────────────────────
	it("readLiveFabricTenants returns exactly the tenants the claim predicate waits on", async () => {
		const statuses: ProjectStatus[] = [
			"DRAFT",
			"QUEUED",
			"PROVISIONING",
			"ACTIVE",
			"FAILED",
			"DESTROYING",
			"DESTROYED",
		];
		for (const st of statuses) {
			await setStatus(nsId, st);
			await setStatus(vcId, "DESTROYED");
			const tenants = await readLiveFabricTenants(db(), await subject(ownerId));
			const live = st !== "DRAFT" && st !== "DESTROYED";
			expect(tenants.map((t) => t.id), `dev-1 ${st}`).toEqual(live ? [nsId] : []);
			expect(await waits(ownerId), `dev-1 ${st}`).toBe(live);
		}
		// A tenant has no tenants; nor does a dedicated env on a different Fabric.
		expect(await readLiveFabricTenants(db(), await subject(nsId))).toEqual([]);
		expect(await readLiveFabricTenants(db(), await subject(otherOwnerId))).toEqual([]);
	});

	// ── THE FLEET DOES NOT SIZE FOR A JOB NO RUNNER MAY START ───────────────────────────────────────
	it("does not count a held owner DESTROY as dispatchable demand", async () => {
		const before = (await dispatchableBacklogByProvider()).get(PROVIDER) ?? 0;
		const owner = await queue(ownerId);
		expect((await dispatchableBacklogByProvider()).get(PROVIDER) ?? 0).toBe(before);
		await db()
			.update(projectEnvironments)
			.set({ status: "DESTROYED" })
			.where(inArray(projectEnvironments.id, [nsId, vcId]));
		expect((await dispatchableBacklogByProvider()).get(PROVIDER) ?? 0).toBe(before + 1);
		await db().delete(jobs).where(eq(jobs.id, owner));
	});
});
