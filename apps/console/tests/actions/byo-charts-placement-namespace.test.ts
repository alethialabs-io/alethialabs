// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6562: attachByoChart — which the board's attachByoChartAction and the CLI byo-charts route both
// run — refuses a namespace that a live namespace placement on the environment's Fabric resolves to,
// naming that environment, at attach and when an update moves a chart there. A re-attach that keeps
// the stored namespace is not refused (the runner reports that chart instead).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/projects/refuse-other-org", () => ({ refuseProjectOfAnotherOrg: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => true }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId: vi.fn() }));
vi.mock("@/lib/queries/placement-host-namespaces", () => ({ placementNamespacesOnFabric: vi.fn() }));

import { attachByoChart } from "@/app/server/actions/byo-charts";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { FieldRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectAddons, projectEnvironments } from "@/lib/db/schema";
import { placementNamespacesOnFabric } from "@/lib/queries/placement-host-namespaces";

type Rows = Record<string, unknown>[];

/** A drizzle-ish tx whose SELECTs resolve to the rows given for their table; writes are recorded. */
function setupDb(rows: Map<unknown, Rows>) {
	const written: unknown[] = [];
	function chain(table?: unknown): Record<string, unknown> {
		const self: Record<string, unknown> = {
			from: (t: unknown) => chain(t),
			where: () => self,
			limit: () => self,
			orderBy: () => self,
			returning: () => Promise.resolve([{ id: "row-1" }]),
			onConflictDoUpdate: () => self,
			set: () => self,
			values: (payload: unknown) => {
				if (table === projectAddons) written.push(payload);
				return self;
			},
			then: (resolve: (v: Rows) => unknown) => resolve(rows.get(table) ?? []),
		};
		return self;
	}
	const tx = {
		execute: () => Promise.resolve([]),
		select: () => chain(),
		insert: (t: unknown) => chain(t),
		update: (t: unknown) => chain(t),
		delete: (t: unknown) => chain(t),
	};
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return written;
}

const PROJECT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "u-1", orgId: "o-1" } as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1");
	vi.mocked(placementNamespacesOnFabric).mockResolvedValue([
		{ environment: "staging", namespace: "team-web" },
		{ environment: "Preview", namespace: "preview" },
	]);
});

/** Attaches chart `api` with `namespace` on an environment on Fabric `fabric` (null for none). */
function attach(namespace: string | undefined, opts: { fabric?: string | null; stored?: string } = {}) {
	const rows = new Map<unknown, Rows>();
	rows.set(projectEnvironments, [{ fabric_id: opts.fabric === undefined ? "fab-1" : opts.fabric }]);
	if (opts.stored !== undefined) rows.set(projectAddons, [{ namespace: opts.stored }]);
	const written = setupDb(rows);
	const run = attachByoChart({ projectId: PROJECT, id: "api", repoUrl: "oci://ghcr.io/acme/api", namespace });
	return { run, written };
}

describe("attachByoChart — a namespace a namespace placement holds (#6562)", () => {
	it("refuses it as a namespace field error naming the environment, and writes nothing", async () => {
		const { run, written } = attach("team-web");
		const err = await run.catch((e: unknown) => e);
		if (!(err instanceof FieldRefusal)) throw new Error(`want a FieldRefusal, got ${String(err)}`);
		expect(err.fields.namespace?.[0]).toContain("“team-web”");
		expect(err.fields.namespace?.[0]).toContain("“staging”");
		expect(written).toHaveLength(0);
		expect(placementNamespacesOnFabric).toHaveBeenCalledWith(expect.anything(), PROJECT, "fab-1");
	});

	it("refuses the default Preview environment's namespace too", async () => {
		await expect(attach("preview").run).rejects.toBeInstanceOf(FieldRefusal);
	});

	it("admits a namespace no placement on the Fabric resolves to", async () => {
		const { run, written } = attach("payments");
		await expect(run).resolves.toEqual({ ok: true, id: "api" });
		expect(written[0]).toMatchObject({ namespace: "payments" });
	});

	it("admits anything on an environment with no Fabric, without reading placements", async () => {
		await expect(attach("team-web", { fabric: null }).run).resolves.toEqual({ ok: true, id: "api" });
		expect(placementNamespacesOnFabric).not.toHaveBeenCalled();
	});

	it("refuses an update that moves a chart into a placement's namespace, and keeps one that leaves it there", async () => {
		await expect(attach("team-web", { stored: "payments" }).run).rejects.toBeInstanceOf(FieldRefusal);
		const kept = attach("team-web", { stored: "team-web" });
		await expect(kept.run).resolves.toEqual({ ok: true, id: "api" });
		expect(kept.written[0]).toMatchObject({ namespace: "team-web" });
	});
});
