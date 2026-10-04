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

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	// Real: the pure credential → "is userId the caller" mapping the DESTROY_RUNNER branch reads.
	userIdIsTheCaller: (await importOriginal<typeof import("@/lib/authz/guard")>())
		.userIdIsTheCaller,
	authorize: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
	// The service-token arm asks this one instead (#4298) — "is the MINTER still a member".
	// Stubbed here rather than left off the factory: without it the token tests below would
	// exercise `undefined(...)`, which throws where the route expects a 403-or-null.
	assertMintingProfileStillMember: vi.fn(),
}));
// The PDP the DESTROY_RUNNER branch asks directly (#5479). Partial: the server actions this suite
// runs for real import the rest of the module.
const pdpCan = vi.fn();
vi.mock("@/lib/authz", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz")>()),
	getPdp: () => ({ can: pdpCan }),
}));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), withScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));

import { POST } from "@/app/api/jobs/route";
import { getActiveScope } from "@/lib/auth/scope";
import {
	assertMintingProfileStillMember,
	authorize,
	ensureCliOrgAccess,
} from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectEnvironments,
	projects,
	runners,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";
import { makeJob } from "../../fixtures/jobs";

type Rows = unknown[];
type RowsResolver = Rows | (() => Rows);

/**
 * Builds a table-aware, thenable drizzle-ish tx and wires it through withActorScope —
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
	const executeSpy = vi.fn();
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
		// The enqueue actions route env→QUEUED through the set_env_status CAS (tx.execute); a
		// truthy `updated` lets the transition succeed so the enqueue commits.
		execute: (query: unknown) => {
			executeSpy(query);
			return Promise.resolve([{ updated: true }]);
		},
	};

	vi.mocked(withActorScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(withScope).mockImplementation(
		((_scope: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { valuesSpy, setSpy, executeSpy };
}

/** Pulls the single `.values()` payload recorded against a given schema table. */
function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

/**
 * Stubs getServiceDb for the route's own queries: the post-action job fetch
 * (select→limit), the configuration_hash write (update→returning), the
 * DESTROY_RUNNER legacy insert (insert→returning), and the defense-in-depth
 * assigned-runner lookup (select from runners → org_id).
 *
 * The runner lookup has THREE outcomes, and they are distinct because the route now reads
 * the org back rather than only asserting it (#3874): `runnerOrgId` (default "org-1", the
 * caller's org) is the org the runners row holds — a different value is a cross-tenant self
 * runner, and `null` is a MANAGED runner, which is a real row with no tenant, not a missing
 * one. `runnerMissing` is the missing one.
 */
function mockServiceDb(rows: {
	selectRows?: Rows;
	updateRows?: Rows;
	insertRows?: Rows;
	runnerOrgId?: string | null;
	runnerMissing?: boolean;
	/** What the DESTROY_RUNNER identity lookup (id AND the actor's tenancy) finds. Default: one row. */
	identityRows?: Rows;
	/**
	 * Runner rows BY ID, for the DESTROY_RUNNER branch, which reads two runners — the target and the
	 * executor — through the same chain. When set it replaces `runnerOrgId`/`runnerMissing`; an id
	 * absent from the map is a missing row.
	 */
	runnersById?: Record<string, RunnerRow>;
}) {
	const insertValuesSpy = vi.fn();
	const updateSetSpy = vi.fn();
	const runnerOrgId = rows.runnerOrgId === undefined ? "org-1" : rows.runnerOrgId;
	const runnerRows = (cond: unknown): Rows => {
		if (rows.runnersById) {
			const id = idIn(cond, Object.keys(rows.runnersById));
			const row = id ? rows.runnersById[id] : undefined;
			return row ? [row] : [];
		}
		return rows.runnerMissing ? [] : [{ org_id: runnerOrgId }];
	};
	const db = {
		select: () => ({
			from: (t: unknown) => ({
				where: (cond: unknown) => ({
					limit: () =>
						Promise.resolve(
							t === runners
								? runnerRows(cond)
								: t === cloudIdentities
									? (rows.identityRows ?? [{ id: IDENTITY_ID }])
									: (rows.selectRows ?? []),
						),
				}),
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

/** A `runners` row as the DESTROY_RUNNER branch's service-db reads see it. */
interface RunnerRow {
	org_id: string | null;
	user_id?: string | null;
	cloud_identity_id?: string | null;
}

/** Recovers which of `known` ids a drizzle `eq(runners.id, <id>)` condition names. */
function idIn(cond: unknown, known: string[]): string | null {
	const seen = new Set<unknown>();
	const walk = (n: unknown): string | null => {
		if (typeof n === "string") return known.includes(n) ? n : null;
		if (!n || typeof n !== "object" || seen.has(n)) return null;
		seen.add(n);
		for (const v of Object.values(n)) {
			const hit = walk(v);
			if (hit) return hit;
		}
		return null;
	};
	return walk(cond);
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
const IDENTITY_ID = "55555555-5555-4555-8555-555555555555";
/** The runner a DESTROY_RUNNER tears down. */
const TARGET_ID = "66666666-6666-4666-8666-666666666666";
/** The runner that executes the teardown. */
const EXECUTOR_ID = "77777777-7777-4777-8777-777777777777";
/** A plan id and an identity id the CLIENT sends, which the route must not persist. */
const CLIENT_PLAN_ID = "88888888-8888-4888-8888-888888888888";
const CLIENT_IDENTITY_ID = "99999999-9999-4999-8999-999999999999";

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
	vi.mocked(assertMintingProfileStillMember).mockResolvedValue(null);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
	vi.mocked(assertJobQuotaAllowed).mockResolvedValue(undefined);
	pdpCan.mockResolvedValue({ allowed: true });
});

describe("POST /api/jobs (CLI queue)", () => {
	it("PLAN freezes the NESTED console snapshot (provider/environment_stage/cluster/dns), not the flat project_full row", async () => {
		const { valuesSpy, executeSpy } = setupTx({
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
		// Env flipped to QUEUED via the set_env_status CAS (tx.execute), not a bare .set().
		expect(executeSpy).toHaveBeenCalled();
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

	// ── THE CREDENTIAL KIND IS A TYPE, NOT A STRING'S TRUTHINESS (#4468) ──
	//
	// This route resolves its own scope, so it inherited none of the `switch`es #4298 put in
	// `lib/authz/guard.ts`. It read `service_token_org_id` and asked whether the string was
	// non-empty, three times: which org to scope to, which membership question to ask, and
	// which personal-runner arm to admit. `credentialOf` derives the closed union once.

	it("REFUSES a payload that claims a service-token pin but leaves it blank", async () => {
		setupTx({ select: snapshotSelect() });
		mockServiceDb({});
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "user-1", service_token_org_id: "" },
			error: null,
		});

		const res = await post({ job_type: "PLAN", configuration_id: "p1" });

		expect(res.status).toBe(401);
		// The assertion that makes this a fail-CLOSED test rather than a status-code test.
		// Before #4468, `"" ?? header` did not fall back (`??` catches null and undefined only)
		// and `getActiveScope(userId, "" || undefined)` resolved the MINTER'S DEFAULT ORG, with
		// both membership branches skipped — the pin, the org check and the runner arm all wrong
		// at once. Nothing may be resolved for a credential whose org is unreadable.
		expect(getActiveScope).not.toHaveBeenCalled();
		expect(assertMintingProfileStillMember).not.toHaveBeenCalled();
		expect(ensureCliOrgAccess).not.toHaveBeenCalled();
	});

	it("a service token asks the MINTER's membership, and never the header question", async () => {
		setupTx({ select: snapshotSelect() });
		mockServiceDb({});
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "user-1", service_token_org_id: "org-pinned" },
			error: null,
		});

		// Denied, so the route returns before it reaches the server actions — what is under test
		// is WHICH question was asked and with what, not what planProject does afterwards.
		vi.mocked(assertMintingProfileStillMember).mockResolvedValue(
			new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		);

		const res = await post({ job_type: "PLAN", configuration_id: "p1" });

		expect(res.status).toBe(403);
		// Scoped to the PIN, and the pin is what the offboarding check is asked about.
		expect(getActiveScope).toHaveBeenCalledWith("user-1", "org-pinned");
		expect(assertMintingProfileStillMember).toHaveBeenCalledWith(
			expect.anything(),
			"org-pinned",
		);
		// `ensureCliOrgAccess` would compare the pin to itself and pass vacuously; it is the
		// session arm's question and a token must never reach it.
		expect(ensureCliOrgAccess).not.toHaveBeenCalled();
	});

	it("a service token's pin wins over a header naming another org", async () => {
		setupTx({ select: snapshotSelect() });
		mockServiceDb({});
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "user-1", service_token_org_id: "org-pinned" },
			error: null,
		});

		vi.mocked(assertMintingProfileStillMember).mockResolvedValue(
			new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
		);

		await post(
			{ job_type: "PLAN", configuration_id: "p1" },
			{ "X-Alethia-Org": "org-other" },
		);

		// `verifyCliToken` refuses a CONFLICTING header at the chokepoint; it is stubbed here, so
		// what this pins is the half this route owns — the header is not consulted on this arm.
		expect(getActiveScope).not.toHaveBeenCalledWith("user-1", "org-other");
	});

	// #5484: a minter SUSPENDED in the pinned org passes the offboarding check (stubbed to pass here)
	// and the scope resolver, which skips suspended rows, lands on another of their orgs ("org-1").
	// Every verb would then authorize and file its job there. The route refuses instead.
	it("403s a service token whose pinned scope resolved to a different org, for every verb", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "user-1", service_token_org_id: "org-pinned" },
			error: null,
		});
		for (const body of [
			{ job_type: "PLAN", configuration_id: "p1" },
			{ job_type: "DEPLOY", configuration_id: "p1" },
			{ job_type: "DESTROY", configuration_id: "p1" },
			{ job_type: "DESTROY_RUNNER", config_snapshot: { runner_id: TARGET_ID } },
		]) {
			setupTx({ select: snapshotSelect() });
			const { insertValuesSpy } = mockServiceDb({});
			const res = await post(body);
			expect({ verb: body.job_type, status: res.status }).toEqual({ verb: body.job_type, status: 403 });
			expect(getActiveScope).toHaveBeenCalledWith("user-1", "org-pinned");
			expect(authorize).not.toHaveBeenCalled();
			expect(pdpCan).not.toHaveBeenCalled();
			expect(insertValuesSpy).not.toHaveBeenCalled();
			expect(assertJobQuotaAllowed).not.toHaveBeenCalled();
		}
	});

	it("403s a session whose --org scope resolved to a different org", async () => {
		setupTx({ select: snapshotSelect() });
		mockServiceDb({});
		// ensureCliOrgAccess passes (stubbed); the resolver still answered "org-1", not the header.
		const res = await post(
			{ job_type: "PLAN", configuration_id: "p1" },
			{ "X-Alethia-Org": "org-named" },
		);
		expect(res.status).toBe(403);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("404s (defense-in-depth) when a delegated PLAN names a runner in another org", async () => {
		const { valuesSpy } = setupTx({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		// Assigned runner resolves to a DIFFERENT org than the caller (org-1).
		mockServiceDb({ selectRows: [wireJob()], runnerOrgId: "org-other" });

		const res = await post({
			job_type: "PLAN",
			configuration_id: "p1",
			assigned_runner_id: "runner-x",
		});

		expect(res.status).toBe(404);
		// Fail closed BEFORE the job insert — no orphaned/unclaimable row.
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	// ── DESTROY_RUNNER: everything but the runner's id comes from the runner's row (#5481) ───────
	//
	// The branch runs the console's `destroyRunner` action under the CLI actor, so the job row is
	// written through `withActorScope` (setupTx), and the descriptor is the action's, built from the
	// runner's `metadata.deploy_config`. The route's own reads — the target, the executor, the
	// identity — go through getServiceDb (mockServiceDb). The real org stamp is proven against
	// Postgres in tests/integration/cli-enqueue-org.test.ts.

	/** The target runner as the action's RLS-scoped read sees it. */
	function destroyTx(over: { cloud_identity_id?: string | null } = {}) {
		return setupTx({
			select: new Map<unknown, RowsResolver>([
				[
					runners,
					[
						{
							id: TARGET_ID,
							name: "r-target",
							cloud_identity_id:
								over.cloud_identity_id === undefined ? IDENTITY_ID : over.cloud_identity_id,
							metadata: {
								deploy_config: {
									region: "eu-west-1",
									cloud_provider: "aws",
									image_tag: "v1.2.3",
								},
							},
						},
					],
				],
				[cloudIdentities, [{ provider: "aws" }]],
				// assertNoActiveLifecycleJob: nothing in flight.
				[jobs, []],
			]),
			insert: new Map([[jobs, [{ id: JOB_ID }]]]),
		});
	}

	/** Service-db rows for a DESTROY_RUNNER: the target in org-1 unless overridden, plus the job read. */
	function destroyDb(runnersById: Record<string, RunnerRow> = {}, identityRows?: Rows) {
		return mockServiceDb({
			selectRows: [wireJob({ job_type: "DESTROY_RUNNER", project_id: null })],
			runnersById: {
				[TARGET_ID]: { org_id: "org-1", user_id: "user-2", cloud_identity_id: IDENTITY_ID },
				...runnersById,
			},
			identityRows,
		});
	}

	it("DESTROY_RUNNER builds the descriptor, identity and plan from the runner row, not the body", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb();

		const res = await post({
			job_type: "DESTROY_RUNNER",
			cloud_identity_id: CLIENT_IDENTITY_ID,
			plan_job_id: CLIENT_PLAN_ID,
			config_snapshot: {
				runner_id: TARGET_ID,
				runner_name: "client-name",
				region: "client-region",
				cloud_provider: "gcp",
			},
		});

		expect(res.status).toBe(201);
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({
			job_type: "DESTROY_RUNNER",
			org_id: "org-1",
			user_id: "user-1",
			cloud_identity_id: IDENTITY_ID,
		});
		expect(jobVals.plan_job_id ?? null).toBeNull();
		expect(jobVals.config_snapshot).toMatchObject({
			runner_id: TARGET_ID,
			runner_name: "r-target",
			region: "eu-west-1",
			cloud_provider: "aws",
		});
		expect(JSON.stringify(jobVals)).not.toContain("client-");
		expect(authorize).toHaveBeenCalledWith("destroy", { type: "runner", id: TARGET_ID });
		expect(assertJobQuotaAllowed).toHaveBeenCalledWith("org-1");
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("400s a DESTROY_RUNNER whose config_snapshot names no runner", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb();

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_name: "r1" },
		});

		expect(res.status).toBe(400);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	it("404s a DESTROY_RUNNER whose target runner is in another org", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({ [TARGET_ID]: { org_id: "org-other", user_id: "user-9" } });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("404s a DESTROY_RUNNER whose target is a managed runner (no org)", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({ [TARGET_ID]: { org_id: null, user_id: null } });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	it("404s a DESTROY_RUNNER whose runner's identity is not one the caller may use", async () => {
		const { valuesSpy } = destroyTx();
		// The lookup is by id AND (this org's `org` identity, or the caller's own `personal` one).
		destroyDb({}, []);

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	it("404s a team-org runner's teardown assigned to the caller's PERSONAL-org runner", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({ [EXECUTOR_ID]: { org_id: "user-1", user_id: "user-1" } });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
			assigned_runner_id: EXECUTOR_ID,
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	it("queues a legacy personal-org runner's teardown on the caller's personal-org runner, in the active org", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({
			[TARGET_ID]: { org_id: "user-1", user_id: "user-1", cloud_identity_id: IDENTITY_ID },
			[EXECUTOR_ID]: { org_id: "user-1", user_id: "user-1" },
		});

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
			assigned_runner_id: EXECUTOR_ID,
		});

		expect(res.status).toBe(201);
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({
			org_id: "org-1",
			assigned_runner_id: EXECUTOR_ID,
		});
	});

	it("404s a service token naming its minter's personal-org runner as the target", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "user-1", service_token_org_id: "org-1", service_token_id: "st-1" },
			error: null,
		});
		const { valuesSpy } = destroyTx();
		destroyDb({ [TARGET_ID]: { org_id: "user-1", user_id: "user-1" } });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	it("DESTROY_RUNNER resolves its org from the header and queues on an executor in that org", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({ [EXECUTOR_ID]: { org_id: "org-1", user_id: "user-2" } });

		const res = await post(
			{
				job_type: "DESTROY_RUNNER",
				config_snapshot: { runner_id: TARGET_ID },
				assigned_runner_id: EXECUTOR_ID,
			},
			{ "X-Alethia-Org": "org-1" },
		);

		expect(res.status).toBe(201);
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ org_id: "org-1", user_id: "user-1" });
		// The scope resolution was HOISTED above this branch (#3874).
		expect(getActiveScope).toHaveBeenCalledWith("user-1", "org-1");
		expect(ensureCliOrgAccess).toHaveBeenCalled();
	});

	it("DESTROY_RUNNER may be executed by a MANAGED runner (org_id NULL)", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({ [EXECUTOR_ID]: { org_id: null, user_id: null } });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
			assigned_runner_id: EXECUTOR_ID,
		});

		expect(res.status).toBe(201);
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ org_id: "org-1" });
	});

	it("404s (defense-in-depth) when DESTROY_RUNNER assigns an executor in another org", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb({ [EXECUTOR_ID]: { org_id: "org-other", user_id: "user-9" } });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
			assigned_runner_id: EXECUTOR_ID,
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	it("404s a NON-EXISTENT executor with the same response as a cross-org one (no disclosure)", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb();

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
			assigned_runner_id: EXECUTOR_ID,
		});

		expect(res.status).toBe(404);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});

	// ── #5479: DESTROY_RUNNER asks the console's `destroyRunner` permission ──────────────────────
	it("403s DESTROY_RUNNER when the actor lacks runner:destroy in the resolved org (a viewer)", async () => {
		const { valuesSpy } = destroyTx();
		destroyDb();
		pdpCan.mockResolvedValue({ allowed: false, reason: "viewer" });

		const res = await post(
			{ job_type: "DESTROY_RUNNER", config_snapshot: { runner_id: TARGET_ID } },
			{ "X-Alethia-Org": "org-1" },
		);

		expect(res.status).toBe(403);
		expect(pdpCan).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", orgId: "org-1" }),
			"destroy",
			{ type: "runner" },
		);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("403s DESTROY_RUNNER from a service token whose actor lacks runner:destroy", async () => {
		vi.mocked(verifyCliToken).mockResolvedValue({
			payload: { sub: "user-1", service_token_org_id: "org-1", service_token_id: "st-1" },
			error: null,
		});
		const { valuesSpy } = destroyTx();
		destroyDb();
		pdpCan.mockResolvedValue({ allowed: false, reason: "viewer" });

		const res = await post({
			job_type: "DESTROY_RUNNER",
			config_snapshot: { runner_id: TARGET_ID },
		});

		expect(res.status).toBe(403);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
	});
});
