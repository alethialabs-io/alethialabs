// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: attaching a host BYO chart and creating a namespace placement into the SAME namespace,
// run concurrently, store at most one of the two (#6575), against real Postgres.
//
// Each writer checks the other's table: attachByoChart reads the placements on the Fabric, and
// `POST /api/cli/projects/:id/environments` reads the host's chart namespaces. Without a shared lock
// both read before either inserts, and both commit. Both now take the project's namespace lock
// (lib/projects/preview-namespace-lock.ts) in the transaction that reads and inserts.
//
// WHY THIS IS AN INTEGRATION TEST. The guarantee is Postgres blocking one transaction on an advisory
// lock another holds, and the waiter's READ COMMITTED read then seeing the row the first committed. A
// mocked db cannot show either. So both writers run for real; only the PDP, the project resolver, the
// BYO flag, the environment resolver, the scan's job quota and the scaler are stubbed.
//
// THE INTERLEAVING IS FORCED, not hoped for, and it is the one that loses without the lock: the
// first writer is paused INSIDE its transaction, after its check and before its insert. The second
// writer then starts. With the lock, the paused first writer holds it, so Postgres shows the second
// queued on it; the test then lets the first insert and commit, and the second's check reads that row
// and refuses. Without the lock on either side, the second writer's check runs while the first is
// paused, finds nothing, and both rows are stored — the "second is refused" assertion fails on the
// real defect rather than on a timeout. The pause sits at the end of the read both writers make last
// (placementNamespacesOnFabric), wrapped around the real query.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorize: vi.fn(),
	authorizeCli: vi.fn(),
}));
vi.mock("@/lib/cli/project-access", () => ({ resolveCliProjectAuthorized: vi.fn() }));
vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => true }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId: vi.fn() }));
// The attach queues a best-effort scan after it commits; refusing it here keeps the test to the attach.
vi.mock("@/lib/billing/job-quota", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/job-quota")>()),
	assertJobQuotaAllowed: vi.fn(async () => {
		throw new Error("scan not under test");
	}),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

const gate = vi.hoisted(() => ({
	/** Set to pause the next writer at the end of its last read. */
	armed: false,
	/** Resolves when the armed writer has paused. */
	paused: Promise.resolve(),
	markPaused: () => {},
	/** Releases the paused writer. */
	release: () => {},
	/** Completed placementNamespacesOnFabric reads since the gate was armed. */
	reads: 0,
}));
vi.mock("@/lib/queries/placement-host-namespaces", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/queries/placement-host-namespaces")>();
	return {
		...real,
		placementNamespacesOnFabric: async (...args: Parameters<typeof real.placementNamespacesOnFabric>) => {
			const rows = await real.placementNamespacesOnFabric(...args);
			gate.reads++;
			if (gate.armed) {
				gate.armed = false;
				const released = new Promise<void>((resolve) => {
					gate.release = resolve;
				});
				gate.markPaused();
				await released;
			}
			return rows;
		},
	};
});

import { attachByoChart } from "@/app/server/actions/byo-charts";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { POST } from "@/app/api/cli/projects/[id]/environments/route";
import { FieldRefusal } from "@/lib/actions/result";
import { authorize, authorizeCli } from "@/lib/authz/guard";
import { resolveCliProjectAuthorized } from "@/lib/cli/project-access";
import { getServiceDb } from "@/lib/db";
import { projectAddons, projectEnvironments, projectFabrics, projects } from "@/lib/db/schema";

const ORG = randomUUID();
const USER = randomUUID();
const NS = "team-web";

let projectId = "";
let hostEnvId = "";

/** The advisory-lock key every writer of `projectId` takes (lockProjectPreviewNamespaces). */
const lockKey = () => `byo-preview-ns:${projectId}`;

/** Seeds a project whose default environment is a `dedicated` host on its own Fabric. */
async function seedProject(): Promise<void> {
	const db = getServiceDb();
	const [project] = await db
		.insert(projects)
		.values({
			org_id: ORG,
			user_id: USER,
			project_name: `lock-${randomUUID().slice(0, 8)}`,
			region: "eu-central",
			iac_version: "1.0",
		})
		.returning({ id: projects.id });
	projectId = project.id;
	const [fabric] = await db
		.insert(projectFabrics)
		.values({ project_id: projectId, user_id: USER, org_id: ORG, name: "production", region: "eu-central" })
		.returning({ id: projectFabrics.id });
	const [host] = await db
		.insert(projectEnvironments)
		.values({
			project_id: projectId,
			user_id: USER,
			org_id: ORG,
			name: "production",
			stage: "production",
			is_default: true,
			fabric_id: fabric.id,
			placement_mode: "dedicated",
		})
		.returning({ id: projectEnvironments.id });
	hostEnvId = host.id;
}

/** Removes the project's rows. */
async function dropProject(): Promise<void> {
	if (!projectId) return;
	const db = getServiceDb();
	await db.delete(projectAddons).where(eq(projectAddons.project_id, projectId));
	await db.delete(projectEnvironments).where(eq(projectEnvironments.project_id, projectId));
	await db.delete(projectFabrics).where(eq(projectFabrics.project_id, projectId));
	await db.delete(projects).where(eq(projects.id, projectId));
	projectId = "";
}

/** Attaches host chart `api` into NS. */
function attach(): Promise<unknown> {
	return attachByoChart({ projectId, id: "api", repoUrl: "oci://ghcr.io/acme/api", namespace: NS });
}

/** Creates namespace placement `team` into NS through the CLI route; resolves to status and body. */
async function createPlacement(): Promise<{ status: number; error: string }> {
	const res = await POST(
		new Request(`https://console.test/api/cli/projects/${projectId}/environments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "team", placement_mode: "namespace", namespace: NS }),
		}),
		{ params: Promise.resolve({ id: projectId }) },
	);
	const body: unknown = await res.json();
	const error = typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";
	return { status: res.status, error };
}

/** How many backends are queued, ungranted, on the project's lock. */
async function waiters(): Promise<number> {
	const [row] = await getServiceDb().execute<{ n: number }>(sql`
		select count(*)::int as n from pg_locks
		 where locktype = 'advisory' and not granted and objsubid = 1
		   and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${lockKey()}, 0)`);
	return row?.n ?? 0;
}

/** Polls `done` every 25 ms until it holds; throws after 10 s naming `what`. */
async function until(what: string, done: () => Promise<boolean> | boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/**
 * Runs `first` until it has made its check and paused inside its transaction, then starts `second`
 * and waits until `second` is either queued on the project's lock or has made its own check without
 * one; then lets `first` finish. Returns both outcomes.
 */
async function interleave<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
	gate.reads = 0;
	gate.paused = new Promise<void>((resolve) => {
		gate.markPaused = resolve;
	});
	gate.armed = true;
	const a = first();
	a.catch(() => undefined);
	await Promise.race([gate.paused, a.then(() => undefined, () => undefined)]);
	if (gate.armed) throw new Error("the first writer finished without reaching its check");
	const b = second();
	b.catch(() => undefined);
	await until("the second writer to queue on the lock or to check without it", async () => gate.reads >= 2 || (await waiters()) >= 1);
	gate.release();
	return Promise.allSettled([a, b]);
}

/** The project's stored namespace placements in NS. */
async function storedPlacements(): Promise<number> {
	const rows = await getServiceDb()
		.select({ id: projectEnvironments.id })
		.from(projectEnvironments)
		.where(and(eq(projectEnvironments.project_id, projectId), eq(projectEnvironments.namespace, NS)));
	return rows.length;
}

/** The project's stored BYO charts in NS. */
async function storedCharts(): Promise<number> {
	const rows = await getServiceDb()
		.select({ id: projectAddons.id })
		.from(projectAddons)
		.where(and(eq(projectAddons.project_id, projectId), eq(projectAddons.namespace, NS)));
	return rows.length;
}

describeIfDb("a host chart attach and a namespace-placement create share one lock (#6575)", () => {
	beforeAll(() => {
		vi.mocked(authorize).mockResolvedValue({ credential: "session", userId: USER, orgId: ORG });
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { credential: "session", userId: USER, orgId: ORG },
			credential: "session",
			orgScope: [ORG],
		});
	});

	beforeEach(async () => {
		await dropProject();
		await seedProject();
		vi.mocked(resolveActiveEnvironmentId).mockResolvedValue(hostEnvId);
		// The project row, as the resolver returns it; the PDP decision behind it is not the subject.
		vi.mocked(resolveCliProjectAuthorized).mockImplementation(async () => {
			const [row] = await getServiceDb().select().from(projects).where(eq(projects.id, projectId));
			return row ?? null;
		});
	});

	afterAll(dropProject);

	it("attach first: the placement create that queued behind it is refused, and only the chart is stored", async () => {
		const [attached, created] = await interleave(attach, createPlacement);
		expect(attached.status).toBe("fulfilled");
		if (created.status !== "fulfilled") throw new Error(`the create threw: ${String(created.reason)}`);
		expect(created.value.status).toBe(400);
		expect(created.value.error).toContain(`“${NS}” is reserved on the host cluster`);
		expect(created.value.error).toContain("a bring-your-own chart of the environment that owns this cluster");
		expect(await storedCharts()).toBe(1);
		expect(await storedPlacements()).toBe(0);
	});

	it("create first: the attach that queued behind it is refused, naming the placement, and only the placement is stored", async () => {
		const [created, attached] = await interleave(createPlacement, attach);
		if (created.status !== "fulfilled") throw new Error(`the create threw: ${String(created.reason)}`);
		expect(created.value.status).toBe(201);
		if (attached.status !== "rejected") throw new Error("the attach must be refused");
		const refusal: unknown = attached.reason;
		if (!(refusal instanceof FieldRefusal)) throw new Error(`want a FieldRefusal, got ${String(refusal)}`);
		expect(refusal.fields.namespace?.[0]).toContain(`“${NS}” is used by the namespace-placed environment “team”`);
		expect(await storedPlacements()).toBe(1);
		expect(await storedCharts()).toBe(0);
	});
});
