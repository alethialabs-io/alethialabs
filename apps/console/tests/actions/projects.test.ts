// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the project CRUD/provision actions. We stub ONLY the seams:
// the PDP guard (authorize), the owner resolver (requireOwner), the usage gate, the scaler
// notifier, the authz hierarchy mirror, and a table-aware thenable drizzle chain wired through
// withOwnerScope. The pure helpers stay REAL — routing (slugify/pickFreeSlug + reserved slugs)
// and the cloud-provider converter (convertProjectConfig) — so the slug-collision logic and the
// provider-mapping warnings are genuinely exercised, not re-implemented here. Each test asserts
// the persisted .values()/.set() payloads, derived return shapes, and the branch outcomes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));

import {
	addEnvironment,
	createProject,
	deleteEnvironment,
	deleteProject,
	destroyProject,
	duplicateProjectForProvider,
	getProject,
	getProjectAsFormData,
	getProjectEnvironments,
	getProjects,
	getProjectsList,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { mirrorHierarchyEdge } from "@/lib/authz/tuple-sync";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	auditLog,
	cloudIdentities,
	jobs,
	projectCaches,
	projectCluster,
	projectContainerRegistries,
	projectDatabases,
	projectDns,
	projectEnvironments,
	projectIacSources,
	projectNetwork,
	projectNosqlTables,
	projectQueues,
	projectRepositories,
	projectSecrets,
	projectStorageBuckets,
	projectTopics,
	projects,
	resourceHierarchy,
	runners,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

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
							t === runners && runnerOrgId !== null ? [{ org_id: runnerOrgId }] : [],
						),
				}),
			}),
		}),
	} as never);
}

type Rows = unknown[];
type RowsResolver = Rows | (() => Rows);

/**
 * Builds a table-aware, thenable drizzle-ish tx and wires it through withOwnerScope.
 * Every builder returns the chain; awaiting a SELECT resolves to `cfg.select.get(table)`
 * and a returning INSERT to `cfg.insert.get(table)` (a function value is called fresh each
 * time, which lets a single table answer differently across sequential queries). Records the
 * `.values()` / `.set()` payloads keyed by their table plus insert/update/delete spies.
 */
function setupDb(cfg: {
	select?: Map<unknown, RowsResolver>;
	insert?: Map<unknown, RowsResolver>;
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

	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { tx, valuesSpy, setSpy, insertSpy, updateSpy, deleteSpy, executeSpy };
}

/** Pulls the single `.values()` payload recorded against a given schema table. */
function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
	// Default: any client-supplied assigned runner belongs to the caller's org.
	mockRunnerLookup("org-1");
});

// ============================================================
// createProject
// ============================================================

describe("createProject", () => {
	const baseInput = {
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
		databases: [{ name: "db1", engine: "postgres" }],
		secrets: [{ name: "s1" }],
	};

	it("derives a collision-free slug, seeds the default env + hierarchy edge, persists components, and audits", async () => {
		const { valuesSpy, insertSpy } = setupDb({
			select: new Map([[projects, [{ slug: "my-app" }]]]), // an existing project already owns "my-app"
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "p1", org_id: "org-1", slug: "my-app-2", user_id: "user-1" }]],
				[projectEnvironments, [{ id: "env-1" }]],
			]),
		});

		const r = await createProject(baseInput as never);

		expect(authorize).toHaveBeenCalledWith("create", { type: "project" });

		// pickFreeSlug bumped the collision to "my-app-2"; environment_stage is destructured OUT
		// of the projects row (it seeds the env, it is not a project column).
		const projVals = valuesFor(valuesSpy, projects);
		expect(projVals).toMatchObject({
			slug: "my-app-2",
			user_id: "user-1",
			region: "us-east-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.9.5",
		});
		expect(projVals).not.toHaveProperty("environment_stage");

		// default environment seeded from environment_stage
		expect(valuesFor(valuesSpy, projectEnvironments)).toEqual({
			project_id: "p1",
			user_id: "user-1",
			org_id: "org-1",
			name: "production",
			stage: "production",
			status: "DRAFT",
			is_default: true,
			region: "us-east-1",
		});

		// authz hierarchy edge project → org (both the DB row and the FGA mirror)
		expect(valuesFor(valuesSpy, resourceHierarchy)).toEqual({
			child_type: "project",
			child_id: "p1",
			parent_type: "org",
			parent_id: "user-1",
		});
		expect(mirrorHierarchyEdge).toHaveBeenCalledWith("project", "p1", "org", "user-1");

		// singleton + collection components are scoped to the new project id
		expect(valuesFor(valuesSpy, projectNetwork)).toMatchObject({
			project_id: "p1",
			provision_network: true,
		});
		expect(valuesFor(valuesSpy, projectDatabases)).toEqual([
			{ project_id: "p1", environment_id: "env-1", name: "db1", engine: "postgres" },
		]);
		expect(valuesFor(valuesSpy, projectSecrets)).toEqual([
			{ project_id: "p1", environment_id: "env-1", name: "s1" },
		]);

		expect(valuesFor(valuesSpy, auditLog)).toMatchObject({
			project_id: "p1",
			user_id: "user-1",
			action: "CREATED",
			changes: { project_name: "My App", environment: "production" },
		});

		expect(insertSpy).toHaveBeenCalledWith(projects);
		expect(r).toEqual({
			project: { id: "p1", org_id: "org-1", slug: "my-app-2", user_id: "user-1" },
		});
	});

	it("skips reserved project-child slugs (settings → settings-2)", async () => {
		const { valuesSpy } = setupDb({
			select: new Map([[projects, []]]), // no existing projects, the reservation alone collides
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "p2", org_id: "org-1" }]],
				[projectEnvironments, [{ id: "env-1" }]],
			]),
		});

		await createProject({
			...baseInput,
			project: { ...baseInput.project, project_name: "Settings" },
			databases: [],
			secrets: [],
		} as never);

		expect(valuesFor(valuesSpy, projects).slug).toBe("settings-2");
	});

	it("throws when the project insert returns nothing", async () => {
		setupDb({ select: new Map([[projects, []]]), insert: new Map([[projects, []]]) });
		await expect(createProject(baseInput as never)).rejects.toThrow(/Failed to create project/);
	});

	it("propagates the guard rejection without touching the db", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("forbidden"));
		setupDb({});
		await expect(createProject(baseInput as never)).rejects.toThrow(/forbidden/);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});
});

// ============================================================
// getProjectsList
// ============================================================

describe("getProjectsList", () => {
	it("surfaces each project's default-env name/status, defaulting when the env join is null", async () => {
		setupDb({
			select: new Map([
				[
					projects,
					[
						{
							project: { id: "p1", project_name: "A" },
							env_name: "prod",
							env_status: "DEPLOYED",
						},
						{ project: { id: "p2", project_name: "B" }, env_name: null, env_status: null },
					],
				],
			]),
		});

		const r = await getProjectsList();
		expect(authorize).toHaveBeenCalledWith("view", { type: "project" });
		expect(r.projects).toEqual([
			{ id: "p1", project_name: "A", environment_stage: "prod", status: "DEPLOYED" },
			{ id: "p2", project_name: "B", environment_stage: "development", status: "DRAFT" },
		]);
	});
});

// ============================================================
// getProject
// ============================================================

describe("getProject", () => {
	const fullSelect = () =>
		new Map<unknown, RowsResolver>([
			[
				projects,
				[
					{
						id: "p1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						region: "us-east-1",
						iac_version: "1.9.5",
						project_name: "My App",
						slug: "my-app",
					},
				],
			],
			[projectNetwork, [{ provision_network: true, cidr_block: "10.0.0.0/16" }]],
			[projectCluster, [{ cluster_version: "1.31", instance_types: ["m5.large"] }]],
			[projectDns, [{ enabled: false }]],
			[projectRepositories, [{ apps_destination_repo: "git@x" }]],
			[projectDatabases, [{ name: "db1", engine: "postgres" }]],
			[projectSecrets, [{ name: "s1", generate: true, length: 32, special_chars: true }]],
			[
				projectEnvironments,
				[{ id: "env-1", name: "production", status: "DEPLOYED", is_default: true }],
			],
			[cloudIdentities, [{ provider: "gcp" }]],
		]);

	it("assembles the project + components and resolves the cloud provider from the identity", async () => {
		setupDb({ select: fullSelect() });
		const r = await getProject("p1");

		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "p1" });
		expect(r.project.environment_stage).toBe("production");
		expect(r.project.status).toBe("DEPLOYED");
		expect(r.project.default_environment_id).toBe("env-1");
		expect(r.cloudProvider).toBe("gcp");
		expect(r.components.databases).toEqual([{ name: "db1", engine: "postgres" }]);
		expect(r.components.network).toMatchObject({ provision_network: true });
		expect(r.environments).toHaveLength(1);
	});

	it("throws when the project row is missing", async () => {
		setupDb({ select: new Map([[projects, []]]) });
		await expect(getProject("missing")).rejects.toThrow(/Project not found/);
	});

	it("defaults the cloud provider to aws when no identity is linked (no identity query)", async () => {
		const m = fullSelect();
		m.set(projects, [
			{ id: "p1", org_id: "org-1", cloud_identity_id: null, region: "x", iac_version: "1" },
		]);
		m.set(cloudIdentities, () => {
			throw new Error("cloud identity must NOT be queried when none is linked");
		});
		setupDb({ select: m });
		const r = await getProject("p1");
		expect(r.cloudProvider).toBe("aws");
	});
});

// ============================================================
// planProject / provisionProject (exercise buildConfigSnapshot)
// ============================================================

/** A select map sufficient for buildConfigSnapshot to succeed against a verified aws identity. */
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

describe("planProject", () => {
	it("freezes a config snapshot, queues a PLAN job, flips the env to QUEUED, and notifies the scaler", async () => {
		const { valuesSpy, executeSpy } = setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		const r = await planProject("p1", "runner-9");

		expect(authorize).toHaveBeenCalledWith("plan", { type: "project", id: "p1" });
		expect(assertUsageAllowed).toHaveBeenCalledWith("org-1");

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
		// the snapshot carries the resolved provider + the env name as the frozen wire key
		expect(jobVals.config_snapshot).toMatchObject({
			provider: "aws",
			environment_stage: "production",
			region: "us-east-1",
		});
		// A fresh W3C traceparent is minted at enqueue (the correlation-trace root).
		expect(jobVals.traceparent).toMatch(
			/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
		);

		// The env→QUEUED write now routes through the set_env_status CAS (tx.execute).
		expect(executeSpy).toHaveBeenCalled();
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ jobId: "job-1" });
	});

	it("rejects (defense-in-depth) a client-supplied runner owned by another org", async () => {
		const { valuesSpy, insertSpy } = setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		mockRunnerLookup("org-OTHER"); // runner-9 belongs to a different org than actor (org-1)

		await expect(planProject("p1", "runner-9")).rejects.toThrow(/Forbidden/);
		// Fail closed BEFORE the job is inserted — no orphaned/unclaimable row.
		expect(insertSpy).not.toHaveBeenCalledWith(jobs);
		expect(() => valuesFor(valuesSpy, jobs)).toThrow();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects (defense-in-depth) a non-existent client-supplied runner id", async () => {
		setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		mockRunnerLookup(null); // no such runner → same rejection, no disclosure

		await expect(planProject("p1", "runner-nope")).rejects.toThrow(/Forbidden/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("emits storage_buckets and container_registries in the snapshot with resolved placement", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[
						projectStorageBuckets,
						[
							{
								name: "assets",
								versioning: true,
								encryption_enabled: true,
								public_access: false,
								cloud_identity_id: null,
								region: null,
							},
						],
					],
					[
						projectContainerRegistries,
						[{ name: "apps", provider: null, cloud_identity_id: null, region: null }],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		await planProject("p1");

		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<string, unknown>;
		// Buckets ride the snapshot (they were previously never selected — the known gap).
		expect(snapshot.storage_buckets).toEqual([
			expect.objectContaining({
				name: "assets",
				versioning: true,
				cloud_provider: "aws",
				cloud_identity_id: "ci-1",
				region: "us-east-1",
			}),
		]);
		// Registries keep being emitted alongside.
		expect(snapshot.container_registries).toEqual([
			expect.objectContaining({
				name: "apps",
				cloud_provider: "aws",
				cloud_identity_id: "ci-1",
				region: "us-east-1",
			}),
		]);
	});

	it("rejects (no job, no scaler) when the project has no linked cloud identity", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[projects, [{ id: "p1", org_id: "org-1", cloud_identity_id: null, region: "x" }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/No cloud account linked/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects when the linked identity row is missing (unverified)", async () => {
		setupDb({ select: snapshotSelect(new Map([[cloudIdentities, []]])) });
		await expect(planProject("p1")).rejects.toThrow(/not verified/);
	});

	it("enforces the cross-cloud placement gate on a CORE resource", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([[projectDatabases, [{ name: "db1", cloud_identity_id: "ci-OTHER" }]]]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/Cross-cloud database "db1"/);
	});

	it("fails closed on a non-postgres database on hetzner (no silent chart drop)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectDatabases,
						[{ name: "orders", engine_family: "mysql", cloud_identity_id: null }],
					],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/MySQL databases can't be provisioned on Hetzner/,
		);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("queues a hetzner job when databases are postgres (or legacy NULL family)", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[
						projectDatabases,
						[
							{ name: "pg", engine_family: "postgres", cloud_identity_id: null },
							{ name: "legacy", engine_family: null, cloud_identity_id: null },
						],
					],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
		// Both databases ride the snapshot as in-cluster CNPG addons (operator + 2 clusters).
		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as {
			addons: { id: string }[];
		};
		const addonIds = snapshot.addons.map((a) => a.id);
		expect(addonIds).toEqual(
			expect.arrayContaining(["cnpg-operator", "db-pg", "db-legacy"]),
		);
	});

	it("rejects when network provisioning is off but no existing network is selected", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([[projectNetwork, [{ provision_network: false, network_id: null }]]]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/no VPC selected/);
	});

	// ── Fail-closed unsupported-KIND gate (buildConfigSnapshot) ─────────────
	it("fails closed on a Hetzner topic (kind the template can't provision, no silent drop)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectTopics, [{ name: "events", cloud_identity_id: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/Component "events" \(topic\) can't be provisioned on Hetzner/,
		);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("fails closed on a Hetzner nosql table", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectNosqlTables, [{ name: "sessions", cloud_identity_id: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/Component "sessions" \(nosql\) can't be provisioned on Hetzner/,
		);
	});

	it("fails closed on a Hetzner container registry, naming the Harbor alternative", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectContainerRegistries, [{ name: "apps", cloud_identity_id: null }]],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/Component "apps" \(registry\).*Harbor/,
		);
	});

	it("queues a Hetzner job when only supported kinds are present (cluster/network/db-pg/cache/queue/dns)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectNetwork, [{ provision_network: true, cloud_identity_id: null }]],
					[projectCluster, [{ cloud_identity_id: null }]],
					[projectDns, [{ enabled: true, domain_name: "example.com" }]],
					[
						projectDatabases,
						[{ name: "pg", engine_family: "postgres", cloud_identity_id: null }],
					],
					[projectCaches, [{ name: "cache", cloud_identity_id: null }]],
					[projectQueues, [{ name: "queue", cloud_identity_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
	});

	// Hetzner has NO cloud secret store and `hetznerProvider.ProviderTfvars` never emits
	// `custom_secrets` (every managed cloud does) — so before the kind gate covered `secret`,
	// the component was SILENTLY DROPPED and the deploy still reported SUCCESS. Fail closed.
	it("fails closed on a secret component on hetzner (no silent drop)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[cloudIdentities, [{ id: "ci-1", provider: "hetzner" }]],
					[projectNetwork, [{ provision_network: true, cloud_identity_id: null }]],
					[projectCluster, [{ cloud_identity_id: null }]],
					[projectSecrets, [{ name: "api-key", cloud_identity_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		await expect(planProject("p1")).rejects.toThrow(
			/Component "api-key" \(secret\) can't be provisioned on/,
		);
		// …and the message points the user at the real path (the Vault add-on), not a dead end.
		await expect(planProject("p1")).rejects.toThrow(/Vault marketplace add-on/);
	});

	it("passes a managed cloud (aws) with topic/nosql/registry — supported there", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					// aws is the default identity in snapshotSelect
					[projectTopics, [{ name: "events", cloud_identity_id: null }]],
					[projectNosqlTables, [{ name: "sessions", cloud_identity_id: null }]],
					[projectContainerRegistries, [{ name: "apps", cloud_identity_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});
		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
		const snapshot = valuesFor(valuesSpy, jobs).config_snapshot as Record<string, unknown>;
		expect(snapshot.provider).toBe("aws");
	});

	it("targets an explicit environment, rejecting when it does not belong to the project", async () => {
		setupDb({ select: snapshotSelect(new Map([[projectEnvironments, []]])) });
		await expect(planProject("p1", null, "env-x")).rejects.toThrow(/Environment not found/);
	});

	it("rejects when the project has no default environment", async () => {
		setupDb({ select: snapshotSelect(new Map([[projectEnvironments, []]])) });
		await expect(planProject("p1")).rejects.toThrow(/no default environment/);
	});
});

// ============================================================
// BYO IaC (E3) — snapshot branch + queue gating
// ============================================================

describe("planProject — BYO IaC source", () => {
	const OLD_FLAG = process.env.ALETHIA_BYO_IAC_ENABLED;
	const scannedIacRow = {
		id: "iac-1",
		project_id: "p1",
		environment_id: "env-1",
		repo_url: "https://github.com/acme/infra.git",
		ref: "main",
		path: "stacks/prod",
		commit_sha: "deadbeef",
		var_values: { env: "prod" },
		enabled: true,
		scan_status: "done",
	};

	beforeEach(() => {
		process.env.ALETHIA_BYO_IAC_ENABLED = "true";
	});
	afterEach(() => {
		if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_IAC_ENABLED;
		else process.env.ALETHIA_BYO_IAC_ENABLED = OLD_FLAG;
	});

	it("snapshots iac_source with the pinned sha and SKIPS the template-model gates", async () => {
		const { valuesSpy } = setupDb({
			select: snapshotSelect(
				new Map<unknown, RowsResolver>([
					[projectIacSources, [scannedIacRow]],
					// Both template gates would throw for a template env — they must be skipped:
					// a cross-cloud CORE resource + provisioning off with no network selected.
					[projectDatabases, [{ name: "db1", cloud_identity_id: "ci-OTHER" }]],
					[projectNetwork, [{ provision_network: false, network_id: null }]],
				]),
			),
			insert: new Map([[jobs, [{ id: "job-1" }]]]),
		});

		const r = await planProject("p1");
		expect(r).toEqual({ jobId: "job-1" });
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals.config_snapshot).toMatchObject({
			iac_source: {
				repo_url: "https://github.com/acme/infra.git",
				ref: "main",
				path: "stacks/prod",
				commit_sha: "deadbeef",
				var_values: { env: "prod" },
			},
		});
	});

	it("rejects queueing while the source is unscanned (no pinned commit)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[
						projectIacSources,
						[{ ...scannedIacRow, commit_sha: null, scan_status: "unscanned" }],
					],
				]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/hasn't passed a scan/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("rejects a scanned-but-unpinned source (defense in depth)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([[projectIacSources, [{ ...scannedIacRow, commit_sha: null }]]]),
			),
		});
		await expect(planProject("p1")).rejects.toThrow(/hasn't passed a scan/);
	});

	it("rejects when the flag is off but a row exists (defense in depth)", async () => {
		delete process.env.ALETHIA_BYO_IAC_ENABLED;
		setupDb({
			select: snapshotSelect(new Map([[projectIacSources, [scannedIacRow]]])),
		});
		await expect(planProject("p1")).rejects.toThrow(/disabled/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});
});

describe("provisionProject", () => {
	it("queues a DEPLOY job chained to a plan, audits PROVISIONED, and notifies the scaler", async () => {
		const { valuesSpy, executeSpy } = setupDb({
			select: snapshotSelect(),
			insert: new Map([[jobs, [{ id: "job-7" }]]]),
		});

		const r = await provisionProject("p1", "plan-3", "runner-2");

		expect(authorize).toHaveBeenCalledWith("deploy", { type: "project", id: "p1" });
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({
			job_type: "DEPLOY",
			plan_job_id: "plan-3",
			assigned_runner_id: "runner-2",
			environment_id: "env-1",
			status: "QUEUED",
		});
		expect(valuesFor(valuesSpy, auditLog)).toMatchObject({
			project_id: "p1",
			user_id: "user-1",
			action: "PROVISIONED",
			changes: { job_id: "job-7", environment_id: "env-1" },
		});
		// The env→QUEUED write now routes through the set_env_status CAS (tx.execute).
		expect(executeSpy).toHaveBeenCalled();
		expect(notifyScaler).toHaveBeenCalledTimes(1);
		expect(r).toEqual({ jobId: "job-7" });
	});
});

describe("destroyProject — BYO IaC source", () => {
	const OLD_FLAG = process.env.ALETHIA_BYO_IAC_ENABLED;
	// A source that DEPLOYED successfully (deployed_commit_sha set), then had a later re-scan FAIL
	// (commit_sha cleared, scan_status back off "done"). It must still be destroyable.
	const deployedIacRow = {
		id: "iac-1",
		project_id: "p1",
		environment_id: "env-1",
		repo_url: "https://github.com/acme/infra.git",
		ref: "main",
		path: "stacks/prod",
		commit_sha: null,
		deployed_commit_sha: "cafed00d",
		var_values: { env: "prod" },
		enabled: true,
		scan_status: "failed",
	};

	beforeEach(() => {
		process.env.ALETHIA_BYO_IAC_ENABLED = "true";
	});
	afterEach(() => {
		if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_IAC_ENABLED;
		else process.env.ALETHIA_BYO_IAC_ENABLED = OLD_FLAG;
	});

	it("allows DESTROY after a deploy even when a later re-scan failed — snapshot pins deployed_commit_sha", async () => {
		const { valuesSpy, executeSpy } = setupDb({
			select: snapshotSelect(new Map([[projectIacSources, [deployedIacRow]]])),
			insert: new Map([[jobs, [{ id: "job-9" }]]]),
		});

		const r = await destroyProject("p1");
		expect(r).toEqual({ jobId: "job-9" });
		const jobVals = valuesFor(valuesSpy, jobs);
		expect(jobVals).toMatchObject({ job_type: "DESTROY", status: "QUEUED" });
		// Destroy tears down the module that CREATED the state, not the failed fresh scan.
		expect(jobVals.config_snapshot).toMatchObject({
			iac_source: { commit_sha: "cafed00d" },
		});
		// The env→QUEUED write now routes through the set_env_status CAS (tx.execute).
		expect(executeSpy).toHaveBeenCalled();
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	it("rejects DESTROY when the source was never deployed (no deployed_commit_sha)", async () => {
		setupDb({
			select: snapshotSelect(
				new Map([
					[
						projectIacSources,
						[{ ...deployedIacRow, deployed_commit_sha: null, scan_status: "unscanned" }],
					],
				]),
			),
		});
		await expect(destroyProject("p1")).rejects.toThrow(/no deployed IaC state/);
		expect(notifyScaler).not.toHaveBeenCalled();
	});
});

// ============================================================
// deleteProject
// ============================================================

describe("deleteProject", () => {
	it("authorizes destroy, deletes the project row (CASCADE), and returns success", async () => {
		const { deleteSpy } = setupDb({});
		const r = await deleteProject("p1");
		expect(authorize).toHaveBeenCalledWith("destroy", { type: "project", id: "p1" });
		expect(deleteSpy).toHaveBeenCalledWith(projects);
		expect(r).toEqual({ success: true });
	});
});

// ============================================================
// getProjectAsFormData
// ============================================================

describe("getProjectAsFormData", () => {
	const formSelect = () =>
		new Map<unknown, RowsResolver>([
			[
				projects,
				[
					{
						id: "p1",
						org_id: "org-1",
						cloud_identity_id: "ci-1",
						region: "us-east-1",
						iac_version: "1.9.5",
						project_name: "My App",
					},
				],
			],
			[
				projectNetwork,
				[{ provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true }],
			],
			[
				projectCluster,
				[{ cluster_version: "1.31", instance_types: ["m5.large"], provider_config: {} }],
			],
			[projectDns, [{ enabled: false }]],
			[projectRepositories, [{ apps_destination_repo: "git@x" }]],
			[
				projectDatabases,
				[{ name: "db1", engine: "postgres", min_capacity: 0.5, max_capacity: 4 }],
			],
			[projectSecrets, [{ name: "s1", generate: true, length: 32, special_chars: true }]],
			[
				projectEnvironments,
				[{ id: "env-1", name: "production", status: "DRAFT", is_default: true }],
			],
			[cloudIdentities, [{ provider: "gcp" }]],
		]);

	it("maps the stored project into ProjectFormData with the resolved provider", async () => {
		setupDb({ select: formSelect() });
		const { formData, provider } = await getProjectAsFormData("p1");

		expect(provider).toBe("gcp");
		expect(formData.project).toMatchObject({
			project_name: "My App",
			environment_stage: "production",
			region: "us-east-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.9.5",
		});
		expect(formData.databases).toEqual([
			{
				name: "db1",
				engine: "postgres",
				min_capacity: 0.5,
				max_capacity: 4,
				engine_version: undefined,
				port: undefined,
				backup_retention_days: undefined,
				iam_auth: undefined,
			},
		]);
		expect(formData.secrets[0]).toMatchObject({ name: "s1", special_chars: true, length: 32 });
		expect(formData.cluster).toMatchObject({
			instance_types: ["m5.large"],
			cluster_version: "1.31",
		});
	});

	it("throws when the linked identity cannot be resolved", async () => {
		const m = formSelect();
		m.set(cloudIdentities, []); // both getProject's lookup and the form lookup return nothing
		setupDb({ select: m });
		await expect(getProjectAsFormData("p1")).rejects.toThrow(/Cloud identity not found/);
	});
});

// ============================================================
// duplicateProjectForProvider (real convertProjectConfig)
// ============================================================

describe("duplicateProjectForProvider", () => {
	it("converts an aws project to gcp, overrides region/identity, creates the clone, and returns warnings", async () => {
		// cloud_identities is queried 3x: getProject's provider lookup (aws), the form lookup (aws),
		// then the duplicate's TARGET lookup (gcp). projects is queried as the getProject row, then
		// as createProject's slug-collision list — sequence both with function resolvers.
		let ciCall = 0;
		const ciSeq: Rows[] = [[{ provider: "aws" }], [{ provider: "aws" }], [{ provider: "gcp" }]];
		let projCall = 0;
		const projSeq: Rows[] = [
			[
				{
					id: "p1",
					org_id: "org-1",
					cloud_identity_id: "ci-src",
					region: "us-east-1",
					iac_version: "1.9.5",
					project_name: "My App",
				},
			],
			[{ slug: "my-app" }], // createProject's existing-slug list
		];

		const { valuesSpy } = setupDb({
			select: new Map<unknown, RowsResolver>([
				[projects, () => projSeq[projCall++] ?? []],
				[cloudIdentities, () => ciSeq[ciCall++] ?? [{ provider: "gcp" }]],
				[
					projectNetwork,
					[{ provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true }],
				],
				[
					projectCluster,
					[{ cluster_version: "1.31", instance_types: ["m5.large"], provider_config: {} }],
				],
				[projectDns, [{ enabled: false }]],
				[projectRepositories, [{ apps_destination_repo: "git@x" }]],
				[
					projectDatabases,
					[{ name: "db1", engine: "postgres", min_capacity: 0.5, max_capacity: 4 }],
				],
				[projectSecrets, []],
				[projectCaches, []],
				[
					projectEnvironments,
					[{ id: "env-1", name: "production", status: "DRAFT", is_default: true }],
				],
			]),
			insert: new Map<unknown, RowsResolver>([
				[projects, [{ id: "new-proj", slug: "new-proj", org_id: "org-1" }]],
				[projectEnvironments, [{ id: "env-1" }]],
			]),
		});

		const r = await duplicateProjectForProvider("p1", "ci-target", "europe-west1");

		expect(authorize).toHaveBeenCalledWith("create", { type: "project" });
		expect(r.newProjectId).toBe("new-proj");
		expect(r.newProjectSlug).toBe("new-proj");
		// the real converter always emits at least the cluster k8s-version info note cross-provider
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(r.warnings.some((w) => w.component === "Cluster")).toBe(true);

		// the clone was persisted with the TARGET region + identity (post-conversion overrides)
		const projVals = valuesFor(valuesSpy, projects);
		expect(projVals).toMatchObject({
			region: "europe-west1",
			cloud_identity_id: "ci-target",
			user_id: "user-1",
		});
	});

	it("throws when the target cloud identity is missing", async () => {
		let ciCall = 0;
		const ciSeq: Rows[] = [[{ provider: "aws" }], [{ provider: "aws" }], []]; // target lookup empty
		setupDb({
			select: new Map<unknown, RowsResolver>([
				[
					projects,
					[
						{
							id: "p1",
							org_id: "org-1",
							cloud_identity_id: "ci-src",
							region: "us-east-1",
							iac_version: "1",
						},
					],
				],
				[cloudIdentities, () => ciSeq[ciCall++] ?? []],
				[projectEnvironments, [{ id: "env-1", name: "production", is_default: true }]],
			]),
		});
		await expect(
			duplicateProjectForProvider("p1", "ci-missing", "europe-west1"),
		).rejects.toThrow(/Target cloud identity not found/);
	});
});

// ============================================================
// Environments
// ============================================================

describe("getProjectEnvironments", () => {
	it("returns the project's environments", async () => {
		setupDb({
			select: new Map([
				[
					projectEnvironments,
					[
						{ id: "env-1", name: "production", is_default: true },
						{ id: "env-2", name: "staging", is_default: false },
					],
				],
			]),
		});
		const r = await getProjectEnvironments("p1");
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "p1" });
		expect(r.environments).toHaveLength(2);
		expect(r.environments[1]).toMatchObject({ id: "env-2", name: "staging" });
	});
});

describe("addEnvironment", () => {
	it("slugifies the name, inherits the org, and persists a non-default DRAFT env", async () => {
		const { valuesSpy } = setupDb({
			select: new Map([[projects, [{ org_id: "org-1" }]]]),
			insert: new Map([[projectEnvironments, [{ id: "env-2", name: "my-staging" }]]]),
		});

		const r = await addEnvironment("p1", { name: "My Staging!", stage: "staging", region: null });

		expect(authorize).toHaveBeenCalledWith("edit", { type: "project", id: "p1" });
		expect(valuesFor(valuesSpy, projectEnvironments)).toEqual({
			project_id: "p1",
			user_id: "user-1",
			org_id: "org-1",
			name: "my-staging",
			stage: "staging",
			status: "DRAFT",
			is_default: false,
			region: null,
		});
		expect(r).toEqual({ environment: { id: "env-2", name: "my-staging" } });
	});

	it("rejects a name that slugifies to empty (before any db work)", async () => {
		setupDb({});
		await expect(addEnvironment("p1", { name: "!!!", stage: "staging" })).rejects.toThrow(
			/name is required/,
		);
		expect(withOwnerScope).not.toHaveBeenCalled();
	});

	it("throws when the project is not found", async () => {
		setupDb({ select: new Map([[projects, []]]) });
		await expect(addEnvironment("p1", { name: "stg", stage: "staging" })).rejects.toThrow(
			/Project not found/,
		);
	});
});

describe("deleteEnvironment", () => {
	it("deletes a non-default environment", async () => {
		const { deleteSpy } = setupDb({
			select: new Map([[projectEnvironments, [{ id: "env-2", is_default: false }]]]),
		});
		const r = await deleteEnvironment("p1", "env-2");
		expect(deleteSpy).toHaveBeenCalledWith(projectEnvironments);
		expect(r).toEqual({ success: true });
	});

	it("refuses to delete the default environment", async () => {
		const { deleteSpy } = setupDb({
			select: new Map([[projectEnvironments, [{ id: "env-1", is_default: true }]]]),
		});
		await expect(deleteEnvironment("p1", "env-1")).rejects.toThrow(
			/Cannot delete the project's default/,
		);
		expect(deleteSpy).not.toHaveBeenCalled();
	});

	it("throws when the environment is not found for the project", async () => {
		setupDb({ select: new Map([[projectEnvironments, []]]) });
		await expect(deleteEnvironment("p1", "env-x")).rejects.toThrow(/Environment not found/);
	});
});

// ============================================================
// getProjects (flat)
// ============================================================

describe("getProjects", () => {
	it("maps joined rows into the derived shape with null fallbacks", async () => {
		setupDb({
			select: new Map([
				[
					projects,
					[
						{
							project: { id: "p1", project_name: "A" },
							cloud_provider: "aws",
							env_id: "e1",
							env_name: "prod",
							env_status: "DEPLOYED",
						},
						{
							project: { id: "p2", project_name: "B" },
							cloud_provider: null,
							env_id: null,
							env_name: null,
							env_status: null,
						},
					],
				],
			]),
		});

		const r = await getProjects();
		expect(authorize).toHaveBeenCalledWith("view", { type: "project" });
		expect(r[0]).toEqual({
			id: "p1",
			project_name: "A",
			cloud_provider: "aws",
			environment_stage: "prod",
			status: "DEPLOYED",
			default_environment_id: "e1",
		});
		expect(r[1]).toEqual({
			id: "p2",
			project_name: "B",
			cloud_provider: null,
			environment_stage: "development",
			status: "DRAFT",
			default_environment_id: null,
		});
	});
});
