// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the CHART_SCAN enqueue (#1300): what scanByoChart puts on the job's
// config_snapshot decides whether the runner can reach an OCI-hosted chart at all, and whether the
// claim route attaches the chart-repo credential. These lock that contract.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
// The project-in-the-actor's-org check has its own suite (tests/lib/projects/refuse-other-org.test.ts).
vi.mock("@/lib/projects/refuse-other-org", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/projects/refuse-other-org")>()),
	refuseProjectOfAnotherOrg: vi.fn(async () => undefined),
}));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));

import {
	detachByoChartAction,
	saveChartWorkloadOverlayAction,
	scanByoChart,
	scanByoChartAction,
} from "@/app/server/actions/byo-charts";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { authorize } from "@/lib/authz/guard";
import { getServiceDb, withActorScope } from "@/lib/db";
import { jobs, projectAddons, projectHelmRegistries } from "@/lib/db/schema";
import { ProjectOrgRefusalError, refuseProjectOfAnotherOrg } from "@/lib/projects/refuse-other-org";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { UsageLimitError } from "@/lib/billing/usage-guard";

type Rows = unknown[];

/** Table-aware thenable drizzle-ish tx, mirroring the byo-iac tests' boundary mock. */
function setupDb(select: Map<unknown, Rows>) {
	const valuesSpy = vi.fn<(table: unknown, payload: unknown) => void>();

	function makeChain(op: "select" | "insert" | "update", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				from = t;
				return c;
			},
			where: () => c,
			limit: () => c,
			returning: () => c,
			values: (payload: unknown) => {
				valuesSpy(from, payload);
				return c;
			},
			set: () => c,
			then: (res: (v: Rows) => void) =>
				res(op === "select" ? (select.get(from) ?? []) : op === "insert" ? [{ id: "job-1" }] : []),
		});
		return c;
	}

	const db = {
		select: () => makeChain("select"),
		insert: (t: unknown) => makeChain("insert", t),
		update: (t: unknown) => makeChain("update", t),
	};
	vi.mocked(withActorScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(db)) as never,
	);
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { valuesSpy };
}

/** Pulls the config_snapshot the action queued onto the jobs table. */
function queuedSnapshot(valuesSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
	const call = valuesSpy.mock.calls.find((c) => c[0] === jobs);
	if (!call) throw new Error("no job was queued");
	const payload = call[1] as { config_snapshot: Record<string, unknown> };
	return payload.config_snapshot;
}

const GIT_CHART = {
	chart_repo: "https://github.com/acme/charts.git",
	chart_path: "charts/demo",
	version: "main",
	values: {},
};

const OCI_CHART = {
	chart_repo: "oci://ghcr.io/acme/charts/demo",
	chart_path: null,
	version: "1.4.0",
	values: {},
};

const HELM_REGISTRY_ROW = {
	name: "charts",
	provider: "oci-github-cr",
	provider_config: { registry_host: "ghcr.io" },
};

const OLD_FLAG = process.env.ALETHIA_BYO_HELM_ENABLED;

beforeEach(() => {
	vi.clearAllMocks();
	process.env.ALETHIA_BYO_HELM_ENABLED = "true";
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1" as never);
});

afterEach(() => {
	if (OLD_FLAG === undefined) delete process.env.ALETHIA_BYO_HELM_ENABLED;
	else process.env.ALETHIA_BYO_HELM_ENABLED = OLD_FLAG;
});

describe("scanByoChart — git charts", () => {
	const input = { projectId: "p1", environmentId: "env-1", id: "demo" };

	it("queues the chart coords and does NOT carry helm_registries", async () => {
		const { valuesSpy } = setupDb(new Map([[projectAddons, [GIT_CHART]]]));

		await scanByoChart(input);

		const snapshot = queuedSnapshot(valuesSpy);
		expect(snapshot.repo_url).toBe(GIT_CHART.chart_repo);
		expect(snapshot.chart_path).toBe("charts/demo");
		expect(snapshot.ref).toBe("main");
		// A git chart needs no chart-repo credential, so the claim route must attach none.
		expect(snapshot).not.toHaveProperty("helm_registries");
	});

	it("refuses a project of another org before queueing anything, in the refusal's own words", async () => {
		const { valuesSpy } = setupDb(new Map([[projectAddons, [GIT_CHART]]]));
		vi.mocked(refuseProjectOfAnotherOrg).mockRejectedValueOnce(
			new ProjectOrgRefusalError("This project belongs to another organization — switch to it to run this."),
		);
		await expect(scanByoChart(input)).rejects.toThrow("This project belongs to another organization");
		expect(valuesSpy.mock.calls.find((c) => c[0] === jobs)).toBeUndefined();
	});

	it("puts the scanned project in the job's column, so job visibility follows it (#6121)", async () => {
		const { valuesSpy } = setupDb(new Map([[projectAddons, [GIT_CHART]]]));
		await scanByoChart(input);
		const call = valuesSpy.mock.calls.find((c) => c[0] === jobs);
		expect(call?.[1]).toMatchObject({ job_type: "CHART_SCAN", project_id: "p1" });
	});

	it("still requires chart_path — a git repo cannot say which directory holds the chart", async () => {
		setupDb(new Map([[projectAddons, [{ ...GIT_CHART, chart_path: null }]]]));

		await expect(scanByoChart(input)).rejects.toThrow(/Chart not found/);
	});

	it("defaults an unpinned git chart to HEAD", async () => {
		const { valuesSpy } = setupDb(new Map([[projectAddons, [{ ...GIT_CHART, version: null }]]]));

		await scanByoChart(input);

		expect(queuedSnapshot(valuesSpy).ref).toBe("HEAD");
	});
});

describe("scanByoChart — OCI charts", () => {
	const input = { projectId: "p1", environmentId: "env-1", id: "demo" };

	it("queues an OCI chart without a chart_path", async () => {
		const { valuesSpy } = setupDb(
			new Map<unknown, Rows>([
				[projectAddons, [OCI_CHART]],
				[projectHelmRegistries, []],
			]),
		);

		await scanByoChart(input);

		const snapshot = queuedSnapshot(valuesSpy);
		expect(snapshot.repo_url).toBe("oci://ghcr.io/acme/charts/demo");
		expect(snapshot.chart_path).toBeNull();
		expect(snapshot.ref).toBe("1.4.0");
	});

	it("carries the environment's chart repos so the claim route attaches the credential", async () => {
		const { valuesSpy } = setupDb(
			new Map<unknown, Rows>([
				[projectAddons, [OCI_CHART]],
				[projectHelmRegistries, [HELM_REGISTRY_ROW]],
			]),
		);

		await scanByoChart(input);

		// The claim route resolves connector credentials from snapshot.helm_registries[].provider.
		expect(queuedSnapshot(valuesSpy).helm_registries).toEqual([
			{ name: "charts", provider: "oci-github-cr", provider_config: { registry_host: "ghcr.io" } },
		]);
	});

	it("carries only non-secret provider config — never a credential", async () => {
		const { valuesSpy } = setupDb(
			new Map<unknown, Rows>([
				[projectAddons, [OCI_CHART]],
				[
					projectHelmRegistries,
					// A row shape carrying extra columns must not widen the snapshot.
					[{ ...HELM_REGISTRY_ROW, cloud_identity_id: "ci-1", status: "READY" }],
				],
			]),
		);

		await scanByoChart(input);

		const registries = queuedSnapshot(valuesSpy).helm_registries as Record<string, unknown>[];
		expect(Object.keys(registries[0]).sort()).toEqual(["name", "provider", "provider_config"]);
	});

	it("defaults an unpinned OCI chart to the latest release, not the git HEAD sentinel", async () => {
		const { valuesSpy } = setupDb(
			new Map<unknown, Rows>([
				[projectAddons, [{ ...OCI_CHART, version: null }]],
				[projectHelmRegistries, []],
			]),
		);

		await scanByoChart(input);

		expect(queuedSnapshot(valuesSpy).ref).toBe("*");
	});

	it("tolerates a chart repo with no provider_config", async () => {
		const { valuesSpy } = setupDb(
			new Map<unknown, Rows>([
				[projectAddons, [OCI_CHART]],
				[projectHelmRegistries, [{ name: "ghcr", provider: "oci-github-cr", provider_config: null }]],
			]),
		);

		await scanByoChart(input);

		expect(queuedSnapshot(valuesSpy).helm_registries).toEqual([
			{ name: "ghcr", provider: "oci-github-cr", provider_config: {} },
		]);
	});

	it("rejects a chart row with no chart_repo at all", async () => {
		setupDb(new Map([[projectAddons, [{ ...OCI_CHART, chart_repo: null }]]]));

		await expect(scanByoChart(input)).rejects.toThrow(/Chart not found/);
	});
});

// #6119: the board calls the `…Action` forms through `useActionMutation`. A refusal the person can
// act on keeps its sentence and gets its kind; anything else stays `unexpected`.
describe("the BYO chart actions — the mutation contract", () => {
	const PROJECT = "11111111-1111-4111-8111-111111111111";
	const ENV = "22222222-2222-4222-8222-222222222222";
	const WORKLOAD = "33333333-3333-4333-8333-333333333333";
	const target = { projectId: PROJECT, environmentId: ENV, id: "demo" };

	it("answers the queued scan", async () => {
		setupDb(new Map([[projectAddons, [GIT_CHART]]]));
		await expect(scanByoChartAction(target)).resolves.toEqual({ ok: true, data: { jobId: "job-1" } });
	});

	it("answers a project of another org as a conflict, in the refusal's own words", async () => {
		setupDb(new Map([[projectAddons, [GIT_CHART]]]));
		const reason = "This project belongs to another organization — switch to it to run this.";
		vi.mocked(refuseProjectOfAnotherOrg).mockRejectedValueOnce(new ProjectOrgRefusalError(reason));
		await expect(scanByoChartAction(target)).resolves.toEqual({
			ok: false,
			error: { kind: "conflict", message: reason },
		});
	});

	it("answers an upgradable job cap as an entitlement refusal, and a hard cap as a conflict", async () => {
		// The BYO scans THROW the cap (assertJobQuotaAllowed), unlike `try*Project`, which returns it —
		// so this is the board's real entitlement path.
		setupDb(new Map([[projectAddons, [GIT_CHART]]]));
		vi.mocked(assertJobQuotaAllowed).mockRejectedValueOnce(
			new UsageLimitError("Free plan: 25 jobs a day.", true),
		);
		await expect(scanByoChartAction(target)).resolves.toEqual({
			ok: false,
			error: { kind: "entitlement", message: "Free plan: 25 jobs a day.", feature: "jobQuota" },
		});
		vi.mocked(assertJobQuotaAllowed).mockRejectedValueOnce(
			new UsageLimitError("Usage cap reached.", false),
		);
		await expect(scanByoChartAction(target)).resolves.toEqual({
			ok: false,
			error: { kind: "conflict", message: "Usage cap reached." },
		});
	});

	it("answers a chart that is not attached as not-found", async () => {
		setupDb(new Map());
		await expect(scanByoChartAction(target)).resolves.toEqual({
			ok: false,
			error: { kind: "not-found", message: "Chart not found (attach it before scanning)." },
		});
	});

	it("answers the feature switched off as a conflict naming the switch", async () => {
		setupDb(new Map());
		process.env.ALETHIA_BYO_HELM_ENABLED = "false";
		const result = await detachByoChartAction(target);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.kind).toBe("conflict");
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("binds the overlay write to the actor's org, and answers a workload it cannot see as not-found", async () => {
		const seen: { where: { sql: string; params: unknown[] } | null } = { where: null };
		const chain: Record<string, unknown> = {};
		Object.assign(chain, {
			set: () => chain,
			where: (clause: SQL) => {
				seen.where = new PgDialect().sqlToQuery(clause);
				return chain;
			},
			returning: () => Promise.resolve([]),
		});
		vi.mocked(withActorScope).mockImplementation(
			((_actor: unknown, cb: (tx: unknown) => unknown) => cb({ update: () => chain })) as never,
		);

		const result = await saveChartWorkloadOverlayAction({
			projectId: PROJECT,
			workloadId: WORKLOAD,
			config: { replicas: 2 },
		});

		expect(result).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Chart workload not found" },
		});
		expect(seen.where?.params).toEqual(expect.arrayContaining([WORKLOAD, PROJECT, "org-1"]));
	});
});
