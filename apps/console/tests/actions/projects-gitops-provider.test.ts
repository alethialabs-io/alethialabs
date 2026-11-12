// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6599: a deploy that would push a GitOps-mode add-on's manifest into an apps repo on GitLab or
// Bitbucket is refused BEFORE it is queued: those links are read-only, so the deploy would otherwise
// fail on a push it could never make. Same mocked-boundary harness as build-project.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({
	withActorScope: vi.fn(),
	withScope: vi.fn(),
	getServiceDb: vi.fn(),
}));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/billing/usage-guard", () => ({ assertUsageAllowed: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));
vi.mock("@/lib/config/auth", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/config/auth")>()),
	getGitlabBaseUrl: () => "https://code.acme.example",
}));

import { buildProject, planProject, provisionProject } from "@/app/server/actions/projects";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { assertUsageAllowed } from "@/lib/billing/usage-guard";
import { getServiceDb, withActorScope, withScope } from "@/lib/db";
import {
	cloudIdentities,
	jobs,
	projectAddons,
	projectEnvironments,
	projectRepositories,
	projectServices,
	projects,
} from "@/lib/db/schema";
import { notifyScaler } from "@/lib/scaler";

type Rows = unknown[];

/** Table-aware thenable drizzle-ish tx wired through withActorScope (projects.test.ts shape). */
function setupDb(select: Map<unknown, Rows>, insert: Map<unknown, Rows>) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();
	const executeSpy = vi.fn();
	function makeChain(op: "select" | "insert", table?: unknown) {
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
			then: (res: (v: Rows) => void) =>
				res(op === "insert" ? (insert.get(from) ?? []) : (select.get(from) ?? [])),
		});
		return c;
	}
	const tx = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: () => makeChain("select"),
		delete: () => makeChain("select"),
		// env-status CAS (set_env_status): env moved.
		execute: (q: unknown) => {
			executeSpy(q);
			return Promise.resolve([{ updated: true }]);
		},
	};
	vi.mocked(withActorScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	// Provisioning-queue paths scope by the ACTIVE ORG (withScope), not withActorScope.
	vi.mocked(withScope).mockImplementation(
		((_scope: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue({} as never);
	return { valuesSpy, executeSpy };
}

/** Pulls the `.values()` payload recorded against a given schema table. */
function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded for table");
	return call[1] as Record<string, unknown>;
}

const repoServiceRow = {
	id: "svc-web",
	project_id: "p1",
	environment_id: "env-1",
	name: "web",
	cloud_identity_id: null,
	region: null,
	type: "deployment",
	source: { kind: "repo", repo_url: "https://github.com/acme/web", path: "" },
	build: null,
	env: [],
	ports: [],
	replicas: 2,
	resources: null,
	probe: null,
	resolved_image: null,
	status: "PENDING",
	status_message: null,
	estimated_monthly_cost: null,
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-01T00:00:00.000Z",
};

const imageServiceRow = {
	...repoServiceRow,
	id: "svc-worker",
	name: "worker",
	source: { kind: "image", image: "ghcr.io/acme/worker:1.2.3" },
};

/** Select map sufficient for buildConfigSnapshot; env status + service rows vary per test. */
function snapshotSelect(envStatus: string, services: Rows) {
	return new Map<unknown, Rows>([
		[projects, [{ id: "p1", org_id: "org-1", cloud_identity_id: "ci-1", region: "us-east-1" }]],
		[
			projectEnvironments,
			[
				{
					id: "env-1",
					name: "production",
					stage: "production",
					status: envStatus,
					is_default: true,
					region: null,
				},
			],
		],
		[cloudIdentities, [{ id: "ci-1", provider: "aws" }]],
		[projectServices, services],
	]);
}


/** A project_addons row for a catalog add-on in `mode`. */
function addonRow(addonId: string, mode: "managed" | "gitops") {
	return {
		id: `pa-${addonId}`,
		addon_id: addonId,
		source: "catalog",
		enabled: true,
		mode,
		version: null,
		values: {},
		values_yaml: null,
		chart_repo: null,
		chart_path: null,
		namespace: null,
	};
}

/** The select map for an environment whose apps repo is `appsRepo`, with `addons` installed. */
function withRepoAndAddons(appsRepo: string, addons: Rows, envStatus = "ACTIVE", services: Rows = [imageServiceRow]) {
	const select = snapshotSelect(envStatus, services);
	select.set(projectRepositories, [{ apps_destination_repo: appsRepo, apps_path: null }]);
	select.set(projectAddons, addons);
	return select;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	vi.mocked(assertUsageAllowed).mockResolvedValue(undefined as never);
});

describe("provisionProject — GitOps add-ons need an apps repo on GitHub", () => {
	it.each([
		["https://code.acme.example/acme/apps", "GitLab"],
		["https://bitbucket.org/acme/apps", "Bitbucket"],
	])("refuses a deploy with a GitOps add-on and its apps repo at %s, and queues nothing", async (repo, name) => {
		const { valuesSpy } = setupDb(withRepoAndAddons(repo, [addonRow("loki", "gitops")]), new Map([[jobs, [{ id: "job-x" }]]]));

		await expect(provisionProject("p1")).rejects.toThrow(
			new RegExp(`apps repository is on ${name}.*Switch the GitOps add-on loki to Managed delivery`),
		);
		expect(valuesSpy.mock.calls.some((c) => c[0] === jobs)).toBe(false);
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("queues the deploy when the apps repo is on GitHub", async () => {
		const { valuesSpy } = setupDb(
			withRepoAndAddons("https://github.com/acme/apps", [addonRow("loki", "gitops")]),
			new Map([[jobs, [{ id: "job-gh" }]]]),
		);

		await expect(provisionProject("p1")).resolves.toEqual({ jobId: "job-gh" });
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "DEPLOY" });
	});

	it.each(["https://code.acme.example/acme/apps", "https://bitbucket.org/acme/apps"])(
		"queues the deploy on %s when every add-on is Managed: nothing is pushed",
		async (repo) => {
			const { valuesSpy } = setupDb(withRepoAndAddons(repo, [addonRow("loki", "managed")]), new Map([[jobs, [{ id: "job-m" }]]]));

			await expect(provisionProject("p1")).resolves.toEqual({ jobId: "job-m" });
			expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "DEPLOY" });
		},
	);
});

describe("buildProject — the BUILD chains a deploy, so it is gated the same way", () => {
	it.each(["https://code.acme.example/acme/apps", "https://bitbucket.org/acme/apps"])(
		"refuses a BUILD whose chained deploy would push a GitOps add-on to %s",
		async (repo) => {
			const { valuesSpy } = setupDb(
				withRepoAndAddons(repo, [addonRow("loki", "gitops")], "ACTIVE", [repoServiceRow]),
				new Map([[jobs, [{ id: "job-b" }]]]),
			);

			await expect(buildProject("p1")).rejects.toThrow(/Switch the GitOps add-on loki to Managed delivery/);
			expect(valuesSpy.mock.calls.some((c) => c[0] === jobs)).toBe(false);
		},
	);
});

describe("planProject — a promotion deploys the plan's snapshot, so it is gated the same way", () => {
	it.each(["https://code.acme.example/acme/apps", "https://bitbucket.org/acme/apps"])(
		"refuses a PLAN whose snapshot would push a GitOps add-on to %s",
		async (repo) => {
			const { valuesSpy } = setupDb(withRepoAndAddons(repo, [addonRow("loki", "gitops")]), new Map([[jobs, [{ id: "job-p" }]]]));

			await expect(planProject("p1")).rejects.toThrow(/Switch the GitOps add-on loki to Managed delivery/);
			expect(valuesSpy.mock.calls.some((c) => c[0] === jobs)).toBe(false);
		},
	);

	it("queues the plan when the apps repo is on GitHub", async () => {
		const { valuesSpy } = setupDb(
			withRepoAndAddons("https://github.com/acme/apps", [addonRow("loki", "gitops")]),
			new Map([[jobs, [{ id: "job-pg" }]]]),
		);

		await expect(planProject("p1")).resolves.toEqual({ jobId: "job-pg" });
		expect(valuesFor(valuesSpy, jobs)).toMatchObject({ job_type: "PLAN" });
	});
});
