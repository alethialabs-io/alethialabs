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

import { disableAddonAction, enableAddon, enableAddonAction } from "@/app/server/actions/addons";
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

// #6119: the board calls `enableAddonAction` / `disableAddonAction` (the mutation contract). A
// refusal only the server can decide arrives keyed by the action's own input, so the card can put
// each sentence under the box that caused it; an environment that does not resolve is not-found.
describe("enableAddonAction / disableAddonAction — the mutation contract", () => {
	const PROJECT = "11111111-1111-4111-8111-111111111111";
	const ENV = "22222222-2222-4222-8222-222222222222";
	const TARGET = { projectId: PROJECT, environmentId: ENV, addonId: "kube-prometheus-stack" };

	it("answers the add-on's id when it lands", async () => {
		setupDb();
		expect(await enableAddonAction({ ...TARGET, version: "58.2.1" })).toEqual({
			ok: true,
			data: { addonId: "kube-prometheus-stack" },
		});
	});

	it("refuses an invalid version as a field error on `version`, writing nothing", async () => {
		const upsert = setupDb();
		const result = await enableAddonAction({ ...TARGET, version: "^58" });
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "validation",
				message: `Invalid chart version: ${CHART_VERSION_REFUSAL}`,
				fields: { version: [CHART_VERSION_REFUSAL] },
			},
		});
		expect(upsert.values).toBeNull();
	});

	it("refuses an Advanced override that is not a YAML mapping as a field error on `valuesYaml`", async () => {
		setupDb();
		const result = await enableAddonAction({ ...TARGET, valuesYaml: "- just\n- a list" });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.kind === "validation" && result.error.fields).toHaveProperty(
			"valuesYaml",
		);
	});

	it("refuses an unknown add-on as not-found, with its sentence", async () => {
		setupDb();
		expect(await enableAddonAction({ ...TARGET, addonId: "no-such-addon" })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Unknown add-on: no-such-addon" },
		});
	});

	it("refuses an environment that does not resolve for the actor as not-found", async () => {
		setupDb();
		vi.mocked(resolveActiveEnvironmentId).mockRejectedValue(
			new Error("Project has no default environment"),
		);
		expect(await disableAddonAction(TARGET)).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Environment not found." },
		});
		expect(withActorScope).not.toHaveBeenCalled();
	});
});
