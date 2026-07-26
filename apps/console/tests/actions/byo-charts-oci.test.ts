// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The OCI half of the BYO-chart actions (#1247). Two things worth pinning:
//   - attachByoChart persists an OCI chart as chart_repo + version with chart_path NULL — the shape
//     resolveByoChartInstall turns into an ArgoCD helm source.
//   - scanByoChart queues a CHART_SCAN for it. The runner resolves an OCI chart by pulling it from
//     the registry (#1300), so a null chart_path must NOT be mistaken for a missing chart, which is
//     how it read before that landed.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => true }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(),
}));

import { attachByoChart, scanByoChart } from "@/app/server/actions/byo-charts";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectAddons } from "@/lib/db/schema";

/** Minimal thenable drizzle-ish tx: selects resolve to `rows`, writes are recorded. */
function setupDb(rows: unknown[] = []) {
	const inserted: { table: unknown; payload: unknown }[] = [];

	function chain(op: string, table?: unknown): Record<string, unknown> {
		const self: Record<string, unknown> = {
			from: (t: unknown) => chain(op, t),
			where: () => self,
			limit: () => self,
			orderBy: () => self,
			returning: () => Promise.resolve([{ id: "job-1" }]),
			onConflictDoUpdate: () => Promise.resolve(undefined),
			set: () => self,
			values: (payload: unknown) => {
				inserted.push({ table, payload });
				return self;
			},
			then: (resolve: (v: unknown[]) => unknown) => resolve(rows),
		};
		return self;
	}

	const tx = {
		select: () => chain("select"),
		insert: (t: unknown) => chain("insert", t),
		update: (t: unknown) => chain("update", t),
		delete: (t: unknown) => chain("delete", t),
	};

	vi.mocked(withActorScope).mockImplementation(
		// The action only needs the tx; the actor is opaque here. Same shape byo-iac.test.ts uses —
		// the stub can't satisfy drizzle's PgTransaction type.
		((_actor: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { inserted };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({
		userId: "u-1",
		orgId: "o-1",
	} as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1");
});

describe("attachByoChart — OCI", () => {
	it("stores an OCI chart with a null chart_path and the version as the target revision", async () => {
		const { inserted } = setupDb();

		await attachByoChart({
			projectId: "proj-1",
			environmentId: "env-1",
			id: "payments",
			repoUrl: "oci://ghcr.io/acme/payments",
			ref: "1.4.2",
		});

		const row = inserted.find((i) => i.table === projectAddons)?.payload;
		expect(row).toMatchObject({
			addon_id: "payments",
			chart_repo: "oci://ghcr.io/acme/payments",
			chart_path: null,
			version: "1.4.2",
			source: "byo",
		});
	});

	it("defaults an OCI chart to the latest version", async () => {
		const { inserted } = setupDb();

		await attachByoChart({
			projectId: "proj-1",
			id: "payments",
			repoUrl: "oci://ghcr.io/acme/payments",
		});

		expect(inserted.find((i) => i.table === projectAddons)?.payload).toMatchObject({
			version: "*",
		});
	});

	it("rejects an oci:// reference that names no chart path at all", async () => {
		setupDb();
		await expect(
			attachByoChart({ projectId: "proj-1", id: "x", repoUrl: "not-a-url" }),
		).rejects.toThrow(/valid chart repository URL/i);
	});

	it("still requires a chart path for a git chart", async () => {
		setupDb();
		await expect(
			attachByoChart({
				projectId: "proj-1",
				id: "x",
				repoUrl: "https://github.com/acme/charts",
			}),
		).rejects.toThrow(/chart path/i);
	});
});

describe("scanByoChart — OCI", () => {
	it("queues a scan for an OCI chart, which has no chart path", async () => {
		const { inserted } = setupDb([
			{
				addon_id: "payments",
				chart_repo: "oci://ghcr.io/acme/payments",
				chart_path: null,
				version: "1.4.2",
			},
		]);

		await expect(
			scanByoChart({ projectId: "proj-1", environmentId: "env-1", id: "payments" }),
		).resolves.toMatchObject({ ok: true });

		// The runner resolves an OCI chart by pulling it from the registry (#1300), so chart_path
		// stays null and `ref` carries the chart version rather than a git ref.
		const job = inserted.find((i) => Object(i.payload) && "job_type" in Object(i.payload))
			?.payload as { job_type: string; config_snapshot: Record<string, unknown> };
		expect(job.job_type).toBe("CHART_SCAN");
		expect(job.config_snapshot).toMatchObject({
			repo_url: "oci://ghcr.io/acme/payments",
			chart_path: null,
			ref: "1.4.2",
		});
	});

	it("still queues a scan for a git chart", async () => {
		const { inserted } = setupDb([
			{
				addon_id: "payments",
				chart_repo: "https://github.com/acme/charts",
				chart_path: "charts/payments",
				version: "main",
			},
		]);

		await scanByoChart({ projectId: "proj-1", environmentId: "env-1", id: "payments" });
		expect(inserted.some((i) => i.payload && "job_type" in Object(i.payload))).toBe(true);
	});
});
