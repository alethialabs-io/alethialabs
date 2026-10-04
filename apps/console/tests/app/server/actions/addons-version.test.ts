// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5525: enableAddon writes a catalog add-on's chart-version pin into project_addons.version.
// The three states matter at BOTH halves of the upsert: the INSERT (a first enable) and the
// ON CONFLICT DO UPDATE set (a reconfigure). A reconfigure that does not mention a version must
// leave the column out of the update set — that is what keeps the stored pin.

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(),
}));

import { enableAddon } from "@/app/server/actions/addons";
import { resolveActiveEnvironmentId } from "@/app/server/actions/resolve";
import { CHART_VERSION_REFUSAL } from "@/lib/addons/chart-version";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

/** What one enableAddon call wrote: the INSERT values and the conflict-update set. */
interface Upsert {
	values: Record<string, unknown> | null;
	set: Record<string, unknown> | null;
}

/** A drizzle-shaped tx stub: the existing-row select returns nothing; the upsert is recorded. */
function setupDb(): Upsert {
	const upsert: Upsert = { values: null, set: null };
	const select = {
		from: () => select,
		where: () => select,
		limit: () => Promise.resolve([]),
	};
	const insert = {
		values: (v: Record<string, unknown>) => {
			upsert.values = v;
			return insert;
		},
		onConflictDoUpdate: (c: { set: Record<string, unknown> }) => {
			upsert.set = c.set;
			return Promise.resolve(undefined);
		},
	};
	const tx = { select: () => select, insert: () => insert };
	vi.mocked(withActorScope).mockImplementation(
		// The stub cannot satisfy drizzle's PgTransaction type; same shape byo-charts-oci.test.ts uses.
		((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never,
	);
	return upsert;
}

const BASE = { projectId: "proj-1", environmentId: "env-1", addonId: "kube-prometheus-stack" };

const ORIGINAL_KEY = process.env.ALETHIA_CRED_ENCRYPTION_KEY;

beforeEach(() => {
	vi.clearAllMocks();
	// kube-prometheus-stack mints its Grafana admin secret on enable, which encrypts.
	process.env.ALETHIA_CRED_ENCRYPTION_KEY = randomBytes(32).toString("base64");
	vi.mocked(authorize).mockResolvedValue({
		userId: "u-1",
		orgId: "o-1",
	} as Awaited<ReturnType<typeof authorize>>);
	vi.mocked(resolveActiveEnvironmentId).mockResolvedValue("env-1");
});

afterEach(() => {
	if (ORIGINAL_KEY === undefined) delete process.env.ALETHIA_CRED_ENCRYPTION_KEY;
	else process.env.ALETHIA_CRED_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("enableAddon — chart version pin", () => {
	it("persists a pin on both the insert and the reconfigure", async () => {
		const upsert = setupDb();
		await enableAddon({ ...BASE, version: "58.2.1" });
		expect(upsert.values).toMatchObject({ version: "58.2.1" });
		expect(upsert.set).toMatchObject({ version: "58.2.1" });
	});

	it("a reconfigure that omits version does not touch the stored pin", async () => {
		const upsert = setupDb();
		await enableAddon({ ...BASE });
		expect(upsert.set).not.toBeNull();
		expect(upsert.set).not.toHaveProperty("version");
		// A first enable without a version is the catalog default: the column is left to its NULL.
		expect(upsert.values).not.toHaveProperty("version");
	});

	it.each([
		["null", null],
		["the empty string", ""],
	])("an explicit %s clears the pin", async (_label, version) => {
		const upsert = setupDb();
		await enableAddon({ ...BASE, version });
		expect(upsert.values).toMatchObject({ version: null });
		expect(upsert.set).toMatchObject({ version: null });
	});

	it("refuses an invalid version before anything is written", async () => {
		const upsert = setupDb();
		await expect(enableAddon({ ...BASE, version: "^58" })).rejects.toThrow(
			`Invalid chart version: ${CHART_VERSION_REFUSAL}`,
		);
		await expect(
			enableAddon({ ...BASE, version: "58.2.1\n---\nkind: Secret" }),
		).rejects.toThrow(/^Invalid chart version:/);
		expect(withActorScope).not.toHaveBeenCalled();
		expect(upsert.values).toBeNull();
	});
});
