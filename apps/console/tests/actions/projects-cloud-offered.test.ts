// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6811: the two console actions that make a NEW project, `createProject` and
// `duplicateProjectForProvider`, refuse a cloud account on a cloud this deployment does not offer,
// and write nothing. Neither action holds the rule: both create through
// insertProjectWithDefaultFabric (lib/queries/projects.ts), which reads the cloud from the stored
// account row. These tests drive the real actions and the real insert, so what they pin is that
// the refusal is reached from each action, before any insert.
//
// The offered set is fixed here by decision (2026-11-17): AWS, GCP, Azure and Hetzner are offered;
// Alibaba, DigitalOcean and Civo are not.
//
// The mocked boundary and the table-aware transaction are the ones tests/actions/projects.test.ts
// uses, repeated here because that suite is one file with one harness and no shared module.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => {
	const authorize = vi.fn();
	// `authorizeDeferred` answers what `authorize` answers (the same mocked outcome), but is its own
	// spy: create and delete record their allow AFTER the write (#6735), so the tests assert which.
	const authorizeDeferred = vi.fn((...args: Parameters<typeof authorize>) => authorize(...args));
	return { authorize, authorizeDeferred, authorizeRead: vi.fn(), currentActor: vi.fn() };
});
vi.mock("@/lib/authz/activity", () => ({
	recordAllowed: vi.fn(),
	recordActivity: vi.fn(),
	enforceDecision: vi.fn(),
}));
// The org binding reads the projects table on the service role; its own behaviour is integration-
// tested (tests/integration/console-project-bound.test.ts). Here it is a seam whose ORDER is asserted.
vi.mock("@/lib/promotions/org-binding", () => ({ assertProjectInActorOrg: vi.fn() }));
vi.mock("@/lib/db", () => ({
	withActorScope: vi.fn(),
	withScope: vi.fn(),
	getServiceDb: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
// `readDuplicateTargets` lives with the other projects reads in lib/rpc/procedures/projects.ts
// (#6131); that module also serves the import flow, whose git-account and model readers are not
// this file's subject and would otherwise load Better Auth and the AI SDK here.
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/jobs/visibility", () => ({ jobVisibleTo: vi.fn() }));
vi.mock("@/lib/scanner/infer", () => ({ inferStack: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
// `UsageLimitError` stays REAL: `refusalAsValue` decides by `instanceof`, so a stand-in class would
// prove only that the test agrees with itself.
vi.mock("@/lib/billing/usage-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/usage-guard")>()),
	assertUsageAllowed: vi.fn(),
}));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
// The live-tenant READ is mocked (its SQL is exercised against real Postgres in
// tests/integration/destroy-fabric-tenants.test.ts); the tree ordering and the refusal error stay
// REAL. Default: no tenants — every pre-#5249 destroy test is about an environment nobody shares.
vi.mock("@/lib/queries/destroy-tree", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/queries/destroy-tree")>();
	return { ...actual, readLiveFabricTenants: vi.fn(async () => []) };
});
// SPIED, not replaced. UNSUPPORTED_KINDS_BY_PROVIDER is EMPTY since #3228 — Hetzner was the last
// cloud refusing a kind, and nosql was its last entry — so `blocked.size > 0` is now false for
// every real provider and the fail-closed kind gate never executes in production. A gate with no
// live case is a gate nothing proves, and deleting its test would have retired the wiring silently.
// So the module stays REAL (importOriginal) and only the lookup is overridable, per test, which
// exercises the gate exactly as a future exclusion would.
vi.mock("@/lib/cloud-providers/unsupported-kinds", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/cloud-providers/unsupported-kinds")>();
	return { ...actual, unsupportedKindsFor: vi.fn(actual.unsupportedKindsFor) };
});

import {
	createProject,
	duplicateProjectForProvider,
	tryCreateProject,
	tryDuplicateProjectForProvider,
} from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { recordAllowed } from "@/lib/authz/activity";
import { authorize, authorizeRead, currentActor } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { CloudNotOfferedError, withHiddenClouds } from "@/lib/cloud-providers/availability";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	cloudIdentities,
	projectCaches,
	projectCluster,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectFabrics,
	projectNetwork,
	projectRepositories,
	projectSecrets,
	projects,
	runners,
} from "@/lib/db/schema";
import { assertProjectInActorOrg } from "@/lib/promotions/org-binding";
/**
 * Stubs getServiceDb so the defense-in-depth assigned-runner lookup
 * (assertRunnerInOrg → select org_id from runners) resolves to `runnerOrgId`.
 * Passing the caller's org (default "org-1") makes the runner in-org; a different
 * value simulates a cross-org assignment.
 */
function mockRunnerLookup(runnerOrgId: string | null = "org-1") {
	vi.mocked(getServiceDb).mockReturnValue({
		select: () => ({
			from: (t: unknown) => ({
				where: () => ({
					limit: () =>
						Promise.resolve(
							t === runners && runnerOrgId !== null
								? [{ org_id: runnerOrgId }]
								: [],
						),
				}),
			}),
		}),
	} as never);
}

type Rows = unknown[];
/** A function resolver receives the query's WHERE (when one was given), so a fixture that must
 *  answer differently per row asked for — the cascade's per-tenant snapshots — can. */
type RowsResolver = Rows | ((where?: unknown) => Rows);

/**
 * Builds a table-aware, thenable drizzle-ish tx and wires it through withActorScope.
 * Every builder returns the chain; awaiting a SELECT resolves to `cfg.select.get(table)`
 * and a returning INSERT to `cfg.insert.get(table)` (a function value is called fresh each
 * time, which lets a single table answer differently across sequential queries). Records the
 * `.values()` / `.set()` payloads keyed by their table plus insert/update/delete spies.
 */
function setupDb(cfg: {
	select?: Map<unknown, RowsResolver>;
	insert?: Map<unknown, RowsResolver>;
	/** Per-table result for `tx.update(...)`. A resolver that THROWS models a constraint violation
	 *  on the write — the only way to reach a catch branch that maps a driver error. */
	update?: Map<unknown, RowsResolver>;
	default?: Rows;
	/** Result of the env-status CAS RPC (set_env_status via tx.execute). true = env moved. */
	envCasUpdated?: boolean;
}) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const setSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const insertSpy = vi.fn<(table: unknown) => void>();
	const updateSpy = vi.fn<(table: unknown) => void>();
	const deleteSpy = vi.fn<(table: unknown) => void>();
	const executeSpy = vi.fn<(query: unknown) => void>();
	const envCasUpdated = cfg.envCasUpdated ?? true;
	const def = cfg.default ?? [];

	const resolve = (
		map: Map<unknown, RowsResolver> | undefined,
		table: unknown,
		where?: unknown,
	): Rows => {
		const v = map?.get(table);
		if (typeof v === "function") return v(where);
		// The design-identity check reads `cloud_identities` before a create or a design save. A test
		// that seeds no identity rows is about something else, so it gets a usable identity rather
		// than a refusal; a test about the identity seeds `[cloudIdentities]` itself.
		if (v === undefined && table === cloudIdentities && cfg.default === undefined) {
			return [{ id: "ci-1", provider: "aws" }];
		}
		return v ?? def;
	};

	function makeChain(
		op: "select" | "insert" | "update" | "delete",
		table?: unknown,
	) {
		let from = table;
		let whereArg: unknown;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			leftJoin: () => c,
			innerJoin: () => c,
			where: (w: unknown) => {
				whereArg = w;
				return c;
			},
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
							? resolve(cfg.select, from, whereArg)
							: op === "update"
								? resolve(cfg.update, from, whereArg)
								: def,
				),
		});
		return c;
	}

	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => {
			insertSpy(t);
			return makeChain("insert", t);
		},
		update: (t: unknown) => {
			updateSpy(t);
			return makeChain("update", t);
		},
		delete: (t: unknown) => {
			deleteSpy(t);
			return makeChain("delete", t);
		},
		// The enqueue paths route env→QUEUED through the set_env_status CAS (tx.execute).
		execute: (query: unknown) => {
			executeSpy(query);
			return Promise.resolve([{ updated: envCasUpdated }]);
		},
	};

	vi.mocked(withActorScope).mockImplementation(((
		_owner: string,
		cb: (tx: unknown) => unknown,
	) => cb(tx)) as never);
	// createProject scopes to the ACTIVE ORG via withScope({ownerId, orgId}); wire it the same way.
	vi.mocked(withScope).mockImplementation(((
		_scope: unknown,
		cb: (tx: unknown) => unknown,
	) => cb(tx)) as never);
	return { tx, valuesSpy, setSpy, insertSpy, updateSpy, deleteSpy, executeSpy };
}

/** Pulls the single `.values()` payload recorded against a given schema table. */
function valuesFor(
	spy: ReturnType<typeof vi.fn>,
	table: unknown,
): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
		credential: "session",
	} as never);
	vi.mocked(authorizeRead).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
		credential: "session",
	} as never);
	vi.mocked(assertProjectInActorOrg).mockResolvedValue(undefined);
	vi.mocked(currentActor).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
		credential: "session",
	} as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
	// Default: any client-supplied assigned runner belongs to the caller's org.
	mockRunnerLookup("org-1");
});

/** The aws source project "My App" and a target account on `target`, for one duplicate. */
function duplicateFixture(target: string) {
	const sourceName = "My App";
	let ciCall = 0;
	const ciSeq: Rows[] = [
		[{ provider: "aws" }],
		[{ provider: "aws" }],
		[{ provider: target }],
	];
	let projCall = 0;
	const projSeq: Rows[] = [
		[
			{
				id: "p1",
				org_id: "org-1",
				cloud_identity_id: "ci-src",
				region: "us-east-1",
				iac_version: "1.9.5",
				project_name: sourceName,
			},
		],
		[{ project_name: sourceName }],
		[{ slug: "src", project_name: sourceName }],
	];
	return setupDb({
		select: new Map<unknown, RowsResolver>([
			[projects, () => projSeq[projCall++] ?? []],
			[cloudIdentities, () => ciSeq[ciCall++] ?? [{ provider: target }]],
			[
				projectNetwork,
				[
					{
						provision_network: true,
						cidr_block: "10.0.0.0/16",
						single_nat_gateway: true,
					},
				],
			],
			[
				projectCluster,
				[
					{
						cluster_version: "1.31",
						instance_types: ["m5.large"],
						provider_config: {},
					},
				],
			],
			[projectDns, [{ enabled: false }]],
			[projectRepositories, [{ apps_destination_repo: "git@x" }]],
			[projectDatabases, []],
			[projectSecrets, []],
			[projectCaches, []],
			[
				projectEnvironments,
				[{ id: "env-1", name: "production", status: "DRAFT", is_default: true }],
			],
		]),
		insert: new Map<unknown, RowsResolver>([
			[projects, [{ id: "new-proj", slug: "new-proj", org_id: "org-1" }]],
			[projectFabrics, [{ id: "fabric-1" }]],
			[projectEnvironments, [{ id: "env-1" }, { id: "env-preview" }]],
		]),
	});
}

/** A minimal new-project design bound to the account `ci-1`. */
const newProject = {
	project: {
		project_name: "My App",
		environment_stage: "production",
		region: "us-east-1",
		cloud_identity_id: "ci-1",
		iac_version: "1.9.5",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: {
		cluster_version: "1.31",
		instance_types: ["m5.large"],
		node_min_size: 2,
		node_max_size: 5,
		node_desired_size: 2,
		cluster_admins: [],
		provider_config: {},
	},
	dns: { enabled: false },
	repositories: { apps_destination_repo: "git@x" },
	databases: [],
	secrets: [],
};

/** A transaction in which the account `ci-1` is on `cloud` and every insert succeeds. */
function createFixture(cloud: string) {
	return setupDb({
		select: new Map<unknown, RowsResolver>([
			[projects, []],
			[cloudIdentities, [{ id: "ci-1", provider: cloud }]],
		]),
		insert: new Map<unknown, RowsResolver>([
			[projects, [{ id: "p1", org_id: "org-1", slug: "my-app", user_id: "user-1" }]],
			[projectFabrics, [{ id: "fabric-1" }]],
			[projectEnvironments, [{ id: "env-1" }, { id: "env-preview" }]],
		]),
	});
}

const HIDDEN = ["alibaba", "digitalocean", "civo"] as const;

describe("createProject — the cloud of the account", () => {
	it.each(HIDDEN)("refuses an account on %s, writes nothing and records nothing", async (cloud) => {
		const { insertSpy } = createFixture(cloud);
		await expect(createProject(newProject as never)).rejects.toBeInstanceOf(CloudNotOfferedError);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(recordAllowed).not.toHaveBeenCalled();
	});

	it("creates the project for an account on an offered cloud", async () => {
		const { insertSpy } = createFixture("aws");
		const { project } = await createProject(newProject as never);
		expect(project.id).toBe("p1");
		expect(insertSpy).toHaveBeenCalledWith(projects);
	});

	it.each(HIDDEN)("creates it on %s once the operator setting names that cloud", async (cloud) => {
		const { insertSpy } = createFixture(cloud);
		const { project } = await withHiddenClouds([cloud], () => createProject(newProject as never));
		expect(project.id).toBe("p1");
		expect(insertSpy).toHaveBeenCalledWith(projects);
	});
});

describe("duplicateProjectForProvider — the cloud of the target account", () => {
	// alibaba is a provisioning cloud, so the design is converted for it first; civo is not, so
	// nothing is converted. The refusal is the same either way, because it is asked of the stored
	// account row at the insert and not of the conversion.
	it.each(["alibaba", "civo"] as const)(
		"refuses a clone onto an account on %s and writes nothing",
		async (cloud) => {
			const { insertSpy } = duplicateFixture(cloud);
			await expect(
				duplicateProjectForProvider("p1", "ci-target", "eu-central-1"),
			).rejects.toBeInstanceOf(CloudNotOfferedError);
			expect(insertSpy).not.toHaveBeenCalled();
		},
	);

	it("clones onto an account on an offered cloud", async () => {
		const { valuesSpy } = duplicateFixture("gcp");
		const clone = await duplicateProjectForProvider("p1", "ci-target", "europe-west1");
		expect(clone).toMatchObject({ newProjectId: "new-proj", newProjectSlug: "new-proj" });
		expect(valuesFor(valuesSpy, projects)).toMatchObject({ project_name: "My App (gcp)" });
	});

	it("clones onto alibaba once the operator setting names it", async () => {
		const { valuesSpy } = duplicateFixture("alibaba");
		const clone = await withHiddenClouds(["alibaba"], () =>
			duplicateProjectForProvider("p1", "ci-target", "cn-hangzhou"),
		);
		expect(clone).toMatchObject({ newProjectId: "new-proj" });
		expect(valuesFor(valuesSpy, projects)).toMatchObject({ project_name: "My App (alibaba)" });
	});
});

// #6964: the two console wrappers return the refusal as a value. A thrown one reaches a client
// component as a digest in a production build, so the person would never read which cloud.
describe("the refusal as the console reads it (#6964)", () => {
	it("tryCreateProject returns the sentence naming the cloud, and writes nothing", async () => {
		const { insertSpy } = createFixture("alibaba");
		await expect(tryCreateProject(newProject as never)).resolves.toEqual({
			ok: false,
			error: "Alibaba Cloud is not available in this release.",
		});
		expect(insertSpy).not.toHaveBeenCalled();
	});

	it("tryDuplicateProjectForProvider places it on the form, not beside the name field", async () => {
		const { insertSpy } = duplicateFixture("civo");
		await expect(
			tryDuplicateProjectForProvider("p1", "ci-target", "fra1"),
		).resolves.toEqual({
			ok: false,
			error: "Civo is not available in this release.",
			field: "form",
		});
		expect(insertSpy).not.toHaveBeenCalled();
	});
});
