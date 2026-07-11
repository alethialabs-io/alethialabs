// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the CLI job-queue route (POST /api/jobs) to the console's provisioning path:
// PLAN/DEPLOY/DESTROY must delegate to the REAL server actions (planProject /
// provisionProject / destroyProject) so a CLI-queued job freezes the same NESTED
// buildConfigSnapshot (provider, environment_stage, cluster, dns, addons) the Go
// runner deserializes into ProjectConfig — not the flat project_full view row the
// route used to store (which unmarshalled into a near-empty ProjectConfig). Only
// the seams are stubbed (CLI auth, scope, PDP guard, db chains, scaler, alerts);
// the actions module is real, so the snapshot assertions exercise the true shape.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));

import { POST } from "@/app/api/jobs/route";
import { getActiveScope } from "@/lib/auth/scope";
import { authorize, ensureCliOrgAccess } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { makeJob } from "../../fixtures/jobs";

type Rows = unknown[];
type RowsResolver = Rows | (() => Rows);

/**
 * Builds a table-aware, thenable drizzle-ish tx and wires it through withOwnerScope —
 * the same harness the projects-actions tests use, so the REAL buildConfigSnapshot
 * runs against it. Records `.values()` / `.set()` payloads keyed by table.
 */
function setupTx(cfg: {
	select?: Map<unknown, RowsResolver>;
	insert?: Map<unknown, RowsResolver>;
	default?: Rows;
}) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const setSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const def = cfg.default ?? [];

	const resolve = (map: Map<unknown, RowsResolver> | undefined, table: unknown): Rows => {
		const v = map?.get(table);
		if (typeof v === "function") return v();
		return v ?? def;
	};

	function makeChain(op: "select" | "insert" | "update" | "delete", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			leftJoin: () => c,
			innerJoin: () => c,
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			onConflictDoNothing: () => c,
			returning: () => c,
			values: (payload: unknown) => {
				valuesSpy(from, payload);
				return c;
			},
			set: (payload: unknown) => {
				setSpy(from, payload);
				return c;
			},
			then: (res: (v: Rows) => void) =>
				res(
					op === "insert"
						? resolve(cfg.insert, from)
						: op === "select"
							? resolve(cfg.select, from)
							: def,
				),
		});
		return c;
	}

	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: (t: unknown) => makeChain("update", t),
		delete: (t: unknown) => makeChain("delete", t),
	};

	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { valuesSpy, setSpy };
}

/** Pulls the single `.values()` payload recorded against a given schema table. */
function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

/**
 * Stubs getServiceDb for the route's own queries: the post-action job fetch
 * (select→limit), the configuration_hash write (update→returning), and the
 * DESTROY_RUNNER legacy insert (insert→returning).
 */
function mockServiceDb(rows: {
	selectRows?: Rows;
	updateRows?: Rows;
	insertRows?: Rows;
}) {
	const insertValuesSpy = vi.fn();
	const updateSetSpy = vi.fn();
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({ limit: () => Promise.resolve(rows.selectRows ?? []) }),
			}),
		}),
		update: () => ({
			set: (p: unknown) => {
				updateSetSpy(p);
				return {
					where: () => ({ returning: () => Promise.resolve(rows.updateRows ?? []) }),
				};
			},
		}),
		insert: () => ({
			values: (p: unknown) => {
				insertValuesSpy(p);
				return { returning: () => Promise.resolve(rows.insertRows ?? []) };
			},
		}),
	};
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { insertValuesSpy, updateSetSpy };
}

/** Select map sufficient for the real buildConfigSnapshot to freeze an aws snapshot. */
function snapshotSelect(overrides?: Map<unknown, RowsResolver>) {
	const m = new Map<unknown, RowsResolver>([
		[projects, [{ id: "p1", org_id: "org-1", cloud_identity_id: "ci-1", region: "us-east-1" }]],
		[
			projectEnvironments,
			[{ id: "env-1", name: "production", status: "DRAFT", is_default: true, region: null }],
		],
		[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
	]);
	if (overrides) for (const [k, v] of overrides) m.set(k, v);
	return m;
}

// jobWire validates uuid columns, so the rows the route returns must carry real UUIDs.
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

/** A full jobs row that passes the CLI wire contract (uuid ids). */
function wireJob(overrides: Parameters<typeof makeJob>[0] = {}) {
	return makeJob({
		id: JOB_ID,
		user_id: USER_ID,
		project_id: PROJECT_ID,
		...overrides,
	});
}

function post(body: Record<string, unknown>, headers?: Record<string, string>) {
	return POST(
		new Request("https://console.local/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(verifyCliToken).mockResolvedValue({
		payload: { sub: "user-1" },
		error: null,
	} as never);
	vi.mocked(getActiveScope).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
});

describe("POST /api/jobs (CLI queue)", () => {
	it("PLAN freezes the NESTED console snapshot (provider/environment_stage/cluster/dns), not the flat project_full row", async () => {
		const { valuesSpy, setSpy } = setupTx({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const { updateSetSpy } = mockServiceDb({
			selectRows: [wireJob({ job_type: "PLAN" })],
			updateRows: [wireJob({ job_type: "PLAN", configuration_hash: "h" })],
		});

		const res = await post({
			job_type: "PLAN",
			configuration_id: "p1",
			assigned_runner_id: "runner-9",
		});

		expect(res.status).toBe(201);
		expect((await res.json()).job).toMatchObject({ id: JOB_ID });

		// Delegated to the console action's PDP verb, not an ad-hoc user_id filter.
		expect(authorize).toHaveBeenCalledWith("plan", { type: "project", id: "p1" });

		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({
			user_id: "user-1",
			project_id: "p1",
			environment_id: "env-1",
			cloud_identity_id: "ci-1",
			job_type: "PLAN",
			status: "QUEUED",
			assigned_runner_id: "runner-9",
		});
		// THE bug being pinned: the snapshot must be the runner's nested ProjectConfig
		// shape, not a flat view row (which has no `provider`/`cluster`/`dns` keys).
		const snapshot = jobVals.config_snapshot as Record<string, unknown>;
		expect(snapshot).toMatchObject({
			provider: "aws",
			environment_stage: "production",
			region: "us-east-1",
		});
		expect(snapshot.cluster).toMatchObject({
			cloud_provider: "aws",
			cloud_identity_id: "ci-1",
			node_min_size: 2,
		});
		expect(snapshot.dns).toMatchObject({ enabled: false });
		expect(Array.isArray(snapshot.addons)).toBe(true);

		// Env flipped to QUEUED by the action, scaler notified, plan→apply hash kept.
		expect(setSpy).toHaveBeenCalledWith(projectEnvironments, { status: "QUEUED" });
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(updateSetSpy).toHaveBeenCalledWith({
			configuration_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
	});

	it("DEPLOY delegates to provisionProject (plan chaining + PROVISIONED audit)", async () => {
		const { valuesSpy } = setupTx({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-7" }]]]),
		});
		mockServiceDb({
			selectRows: [wireJob()],
			updateRows: [wireJob({ configuration_hash: "h" })],
		});

		const res = await post({
			job_type: "DEPLOY",
			configuration_id: "p1",
			plan_job_id: "plan-3",
			assigned_runner_id: "runner-2",
		});

		expect(res.status).toBe(201);
		expect(authorize).toHaveBeenCalledWith("deploy", { type: "project", id: "p1" });
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({
			job_type: "DEPLOY",
			plan_job_id: "plan-3",
			assigned_runner_id: "runner-2",
		});
		expect(valuesFor(valuesSpy, jobs).config_snapshot).toMatchObject({
			provider: "aws",
			environment_stage: "production",
		});
		expect(valuesFor(valuesSpy, auditLog)).toMatchObject({ action: "PROVISIONED" });
	});

	it("DESTROY delegates to destroyProject and emits the teardown ops alert", async () => {
		const { valuesSpy } = setupTx({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-9" }]]]),
		});
		mockServiceDb({
			selectRows: [wireJob({ job_type: "DESTROY" })],
			updateRows: [
				wireJob({ job_type: "DESTROY", org_id: ORG_ID, configuration_hash: "h" }),
			],
		});

		const res = await post({ job_type: "DESTROY", configuration_id: "p1" });

		expect(res.status).toBe(201);
		expect(authorize).toHaveBeenCalledWith("destroy", { type: "project", id: "p1" });
		expect(valuesFor(valuesSpy, jobs).config_snapshot).toMatchObject({ provider: "aws" });
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			ORG_ID,
			"system.job.destroy_requested",
			expect.objectContaining({ job_id: JOB_ID, project_id: "p1" }),
		);
	});

	it("404s (CLI contract) when the PDP denies — unknown or unauthorized project", async () => {
		setupTx({ select: snapshotSelect() });
		mockServiceDb({});
		vi.mocked(authorize).mockRejectedValueOnce(
			new ForbiddenError("plan", { type: "project", id: "p1" }),
		);

		const res = await post({ job_type: "PLAN", configuration_id: "p1" });
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({
			error: "Configuration not found or unauthorized",
		});
	});

	it("403s when X-Alethia-Org names an org the caller cannot access", async () => {
		setupTx({ select: snapshotSelect() });
		mockServiceDb({});
		vi.mocked(ensureCliOrgAccess).mockResolvedValue(
			new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		);

		const res = await post(
			{ job_type: "PLAN", configuration_id: "p1" },
			{ "X-Alethia-Org": "org-other" },
		);
		expect(res.status).toBe(403);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("DESTROY_RUNNER keeps the legacy passthrough insert (client-provided snapshot)", async () => {
		setupTx({});
		const { insertValuesSpy } = mockServiceDb({
			insertRows: [wireJob({ job_type: "DESTROY_RUNNER", project_id: null })],
		});

		const res = await post({
			job_type: "DESTROY_RUNNER",
			cloud_identity_id: "ci-1",
			config_snapshot: { runner_name: "r1" },
		});

		expect(res.status).toBe(201);
		expect(insertValuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				job_type: "DESTROY_RUNNER",
				cloud_identity_id: "ci-1",
				config_snapshot: { runner_name: "r1" },
				project_id: null,
			}),
		);
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});
});
