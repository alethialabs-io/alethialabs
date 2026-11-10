// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6494, both directions of one rule: a BYO chart may not target one of its project's preview
// namespaces (the prefix itself, or the prefix followed by "-").
//   - attachByoChart refuses a NEW namespace there, against the project's stored preview prefix, and
//     keeps a re-attach that leaves the chart's stored namespace unchanged (the runner reports that
//     chart on the Deploy tab instead of refusing it).
//   - savePreviewConfig refuses a prefix CHANGE that would put an attached chart in a preview
//     namespace, and leaves an unchanged prefix alone.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/projects/refuse-other-org", () => ({ refuseProjectOfAnotherOrg: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => true }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId: vi.fn() }));

import { attachByoChart } from "@/app/server/actions/byo-charts";
import { savePreviewConfig } from "@/app/server/actions/preview";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { FieldRefusal } from "@/lib/actions/result";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectAddons, projectPreviewConfig, projects } from "@/lib/db/schema";

type Rows = Record<string, unknown>[];

/** A drizzle-ish tx whose SELECTs resolve to the rows given for their table; writes are recorded. */
function setupDb(rows: Map<unknown, Rows>) {
	const written: { table: unknown; payload: unknown }[] = [];
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
				written.push({ table, payload });
				return self;
			},
			then: (resolve: (v: Rows) => unknown) => resolve(rows.get(table) ?? []),
		};
		return self;
	}
	const tx = {
		select: () => chain(),
		insert: (t: unknown) => chain(t),
		update: (t: unknown) => chain(t),
		delete: (t: unknown) => chain(t),
	};
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { written };
}

const PROJECT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "u-1", orgId: "o-1" } as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1");
});

/** Attaches chart `api` with `namespace`, in a project whose preview prefix is `prefix`. */
function attach(namespace: string | undefined, prefix: string | null, storedNamespace?: string) {
	const rows = new Map<unknown, Rows>();
	if (prefix !== null) rows.set(projectPreviewConfig, [{ namespace_prefix: prefix }]);
	if (storedNamespace !== undefined) rows.set(projectAddons, [{ namespace: storedNamespace }]);
	const { written } = setupDb(rows);
	const run = attachByoChart({ projectId: PROJECT, id: "api", repoUrl: "oci://ghcr.io/acme/api", namespace });
	return { run, written: () => written.filter((w) => w.table === projectAddons) };
}

describe("attachByoChart — the project's preview namespaces (#6494)", () => {
	it("refuses a namespace starting with the preview prefix, as a namespace field error naming the prefix", async () => {
		const { run, written } = attach("pr-7", "pr");
		const err = await run.catch((e: unknown) => e);
		if (!(err instanceof FieldRefusal)) throw new Error(`want a FieldRefusal, got ${String(err)}`);
		expect(err.fields.namespace?.[0]).toContain("“pr-”");
		expect(written()).toHaveLength(0);
	});

	it("refuses the prefix itself", async () => {
		const { run } = attach("pr", "pr");
		await expect(run).rejects.toBeInstanceOf(FieldRefusal);
	});

	it("admits a namespace that only shares the prefix's letters", async () => {
		const { run, written } = attach("pre-7", "pr");
		await expect(run).resolves.toEqual({ ok: true, id: "api" });
		expect(written()[0]?.payload).toMatchObject({ namespace: "pre-7" });
	});

	it("checks the namespace the chart is STORED with: a blank field's byo-<chart id> too", async () => {
		const { run } = attach(undefined, "byo");
		await expect(run).rejects.toBeInstanceOf(FieldRefusal);
	});

	it("admits anything in a project with no preview configuration", async () => {
		const { run } = attach("preview-7", null);
		await expect(run).resolves.toEqual({ ok: true, id: "api" });
	});

	it("keeps a re-attach that leaves the stored namespace unchanged, and refuses moving it to another preview namespace", async () => {
		const kept = attach("pr-7", "pr", "pr-7");
		await expect(kept.run).resolves.toEqual({ ok: true, id: "api" });
		const moved = attach("pr-8", "pr", "pr-7");
		await expect(moved.run).rejects.toBeInstanceOf(FieldRefusal);
	});
});

/** Saves a preview config with `prefix`, over a stored one (`stored`, null for none) and `charts`. */
async function savePrefix(prefix: string | undefined, stored: string | null, charts: Rows) {
	const rows = new Map<unknown, Rows>([
		[projects, [{ org_id: "o-1" }]],
		[projectAddons, charts],
	]);
	if (stored !== null) rows.set(projectPreviewConfig, [{ namespace_prefix: stored }]);
	const { written } = setupDb(rows);
	const res = await savePreviewConfig({
		projectId: PROJECT,
		config: {
			enabled: true,
			git_provider: "github",
			repo_owner: "acme",
			repo_name: "shop",
			...(prefix === undefined ? {} : { namespace_prefix: prefix }),
		},
	});
	return { res, written: written.filter((w) => w.table === projectPreviewConfig) };
}

describe("savePreviewConfig — a prefix an attached chart would match (#6494)", () => {
	it("refuses changing the prefix to one an attached chart's namespace starts with, naming the chart", async () => {
		const { res, written } = await savePrefix("pr", "preview", [{ addon_id: "api", namespace: "pr-7" }]);
		expect(res).toMatchObject({ ok: false, error: { kind: "validation" } });
		const fields = !res.ok && res.error.kind === "validation" ? res.error.fields : {};
		expect(fields["config.namespace_prefix"]?.[0]).toContain("“api”");
		expect(fields["config.namespace_prefix"]?.[0]).toContain("“pr-7”");
		expect(written).toHaveLength(0);
	});

	it("admits a prefix an attached chart's namespace only shares letters with", async () => {
		const { res, written } = await savePrefix("pr", "preview", [{ addon_id: "api", namespace: "pre-7" }]);
		expect(res.ok).toBe(true);
		expect(written).toHaveLength(1);
	});

	it("reads a blank or legacy `default` namespace as the chart's own byo-<chart id>", async () => {
		for (const namespace of [null, "default"]) {
			const { res } = await savePrefix("byo", "preview", [{ addon_id: "api", namespace }]);
			expect(res).toMatchObject({ ok: false, error: { kind: "validation" } });
		}
	});

	it("checks a NEW configuration's default prefix too", async () => {
		const { res } = await savePrefix(undefined, null, [{ addon_id: "api", namespace: "preview-api" }]);
		expect(res).toMatchObject({ ok: false, error: { kind: "validation" } });
	});

	it("leaves an UNCHANGED prefix alone, even when a chart attached before the rule matches it", async () => {
		const { res, written } = await savePrefix("pr", "pr", [{ addon_id: "api", namespace: "pr-7" }]);
		expect(res.ok).toBe(true);
		expect(written).toHaveLength(1);
	});
});
