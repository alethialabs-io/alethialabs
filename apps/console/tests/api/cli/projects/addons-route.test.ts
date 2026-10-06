// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// /api/cli/projects/:id/addons and the chart-version pin (#5525).
//   - POST passes `version` through to enableAddon in its three states (absent / null / a pin), and
//     an invalid pin is a 400 carrying the same sentence the console shows.
//   - POST keeps what the CLI did not send (#5545): an omitted `values_yaml` carries the stored
//     Advanced override forward, `null`/"" clears it, and `values` keys merge over the stored knobs.
//   - GET reports the EFFECTIVE version (the pin, else the catalog default) and whether it is pinned.
//   - GET returns each row's non-secret settings, its values_yaml and its secret setting NAMES, and
//     never a secret value (#5528).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/addons", () => ({
	enableAddon: vi.fn(),
	disableAddon: vi.fn(),
}));
vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/cli/resolve-project", () => ({
	resolveCliProject: vi.fn(),
	resolveCliEnvironment: vi.fn(),
	resolveCliWriteEnvironment: vi.fn(),
	resolveDefaultEnvironmentId: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn(() => ({})) }));
vi.mock("@/app/api/cli/projects/[id]/addons/reconfigure", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/app/api/cli/projects/[id]/addons/reconfigure")>();
	return { ...actual, loadStoredAddon: vi.fn() };
});
vi.mock("@/lib/cli/paging", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cli/paging")>();
	return { ...actual, paginate: vi.fn() };
});

import { loadStoredAddon } from "@/app/api/cli/projects/[id]/addons/reconfigure";
import { GET, POST } from "@/app/api/cli/projects/[id]/addons/route";
import { enableAddon } from "@/app/server/actions/addons";
import { ADDON_CATALOG, getAddOn } from "@/lib/addons/catalog";
import { CHART_VERSION_REFUSAL, chartVersionIntent } from "@/lib/addons/chart-version";
import { authorizeCli } from "@/lib/authz/guard";
import { paginate } from "@/lib/cli/paging";
import {
	resolveCliProject,
	resolveCliWriteEnvironment,
	resolveDefaultEnvironmentId,
} from "@/lib/cli/resolve-project";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ENV_ID = "55555555-5555-4555-8555-555555555555";
const URL_BASE = "https://console.local/api/cli/projects/shop/addons";
const params = { params: Promise.resolve({ id: "shop" }) };

/** POSTs a body as the CLI would. */
function post(body: unknown) {
	return POST(
		new Request(URL_BASE, { method: "POST", body: JSON.stringify(body) }),
		params,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
		orgScope: ["org-1"],
	} as never);
	vi.mocked(resolveCliProject).mockResolvedValue({ id: PROJECT_ID } as never);
	vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: true, id: ENV_ID, name: "prod" });
	vi.mocked(resolveDefaultEnvironmentId).mockResolvedValue(ENV_ID);
	vi.mocked(enableAddon).mockResolvedValue({ ok: true });
	vi.mocked(loadStoredAddon).mockResolvedValue(null);
});

describe("POST /api/cli/projects/:id/addons — version", () => {
	it.each([
		["a pin", { version: "58.2.1" }, "58.2.1"],
		["null (reset)", { version: null }, null],
		["no field (keep)", {}, undefined],
	])("passes %s to enableAddon", async (_label, extra, expected) => {
		const res = await post({ addon_id: "kube-prometheus-stack", ...extra });
		expect(res.status).toBe(201);
		expect(vi.mocked(enableAddon).mock.calls[0]?.[0].version).toBe(expected);
	});

	it("answers 400 with the refusal sentence when the version is invalid", async () => {
		// The route delegates to enableAddon, whose check is the shared module; the mock throws what
		// that module throws, so this pins the status mapping and that the text is passed through.
		vi.mocked(enableAddon).mockImplementation(async (input) => {
			chartVersionIntent(input.version);
			return { ok: true };
		});
		const res = await post({ addon_id: "kube-prometheus-stack", version: "^58" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: `Invalid chart version: ${CHART_VERSION_REFUSAL}`,
		});
	});

	it("refuses a non-string version at the edge", async () => {
		const res = await post({ addon_id: "kube-prometheus-stack", version: 58 });
		expect(res.status).toBe(400);
		expect(enableAddon).not.toHaveBeenCalled();
	});
});

describe("POST /api/cli/projects/:id/addons — keep what was not sent (#5545)", () => {
	const STORED_YAML = "loki:\n  auth_enabled: false\n";

	beforeEach(() => {
		vi.mocked(loadStoredAddon).mockResolvedValue({
			mode: "gitops",
			values: { retention_days: 7, replicas: 2 },
			valuesYaml: STORED_YAML,
		});
	});

	/** The input enableAddon received on the one call this test made. */
	function sent() {
		const input = vi.mocked(enableAddon).mock.calls[0]?.[0];
		if (!input) throw new Error("enableAddon was not called");
		return input;
	}

	it("keeps the stored Advanced override when values_yaml is left out", async () => {
		const res = await post({ addon_id: "loki", values: { retention_days: 14 } });
		expect(res.status).toBe(201);
		expect(loadStoredAddon).toHaveBeenCalledWith("org-1", PROJECT_ID, ENV_ID, "loki");
		expect(sent().valuesYaml).toBe(STORED_YAML);
	});

	it.each([
		["null", null],
		['""', ""],
	])("clears the stored override when values_yaml is %s", async (_label, value) => {
		await post({ addon_id: "loki", values_yaml: value });
		expect(sent().valuesYaml).toBeNull();
	});

	it("replaces the stored override whole when a new one is sent", async () => {
		await post({ addon_id: "loki", values_yaml: "loki:\n  replicas: 3\n" });
		expect(sent().valuesYaml).toBe("loki:\n  replicas: 3\n");
	});

	it("merges values over the stored knobs, and a null key resets that knob", async () => {
		await post({ addon_id: "loki", values: { retention_days: 14, replicas: null } });
		expect(sent().values).toEqual({ retention_days: 14 });
	});

	it("keeps every stored knob and the mode when only the version changes", async () => {
		await post({ addon_id: "loki", version: "6.1.0" });
		expect(sent()).toMatchObject({
			values: { retention_days: 7, replicas: 2 },
			valuesYaml: STORED_YAML,
			mode: "gitops",
			version: "6.1.0",
		});
	});

	it("takes the request as given when nothing is stored", async () => {
		vi.mocked(loadStoredAddon).mockResolvedValue(null);
		await post({ addon_id: "loki", values: { retention_days: 14, replicas: null } });
		expect(sent()).toMatchObject({
			values: { retention_days: 14 },
			valuesYaml: null,
			mode: undefined,
		});
	});
});

describe("reconfigureInput — secrets", () => {
	it("drops stored secret envelopes so enableAddon's mergeAddonSecrets carries them forward", async () => {
		const { reconfigureInput } = await import("@/app/api/cli/projects/[id]/addons/reconfigure");
		const def = ADDON_CATALOG.find((d) => d.fields.some((f) => f.type === "secret" || f.secret));
		if (!def) throw new Error("the catalog declares no secret field to test against");
		const secretKey = def.fields.find((f) => f.type === "secret" || f.secret)?.key ?? "";
		const out = reconfigureInput(
			def,
			{ mode: "managed", values: { [secretKey]: { ciphertext: "x" }, plain: 1 }, valuesYaml: null },
			{},
		);
		expect(out.values).toEqual({ plain: 1 });
	});
});

describe("GET /api/cli/projects/:id/addons — effective version", () => {
	it("reports the pin for a pinned row and the catalog default for an unpinned one", async () => {
		const row = {
			id: "r",
			enabled: true,
			mode: "managed",
			namespace: "monitoring",
			status: "READY",
			health: null,
			sync_status: null,
			last_synced_at: null,
			values: {},
			values_yaml: null,
			cursor_key: "k",
		};
		vi.mocked(paginate).mockResolvedValue({
			items: [
				{ ...row, addon_id: "kube-prometheus-stack", version: "58.2.1" },
				{ ...row, addon_id: "loki", version: null },
			],
			page: { mode: "exact", limit: 100, total: 2, next_cursor: null },
		} as never);

		const res = await GET(new Request(URL_BASE), params);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.addons[0]).toMatchObject({
			addon_id: "kube-prometheus-stack",
			version: "58.2.1",
			version_pinned: true,
		});
		expect(body.addons[1]).toMatchObject({
			addon_id: "loki",
			version: getAddOn("loki")?.version,
			version_pinned: false,
		});
		expect(body.addons[1].version).toEqual(expect.any(String));
	});
});

describe("GET /api/cli/projects/:id/addons — stored settings for the plan (#5528)", () => {
	it("returns the non-secret settings and values_yaml, and a secret setting by NAME only", async () => {
		const def = ADDON_CATALOG.find((d) => d.fields.some((f) => f.type === "secret" || f.secret));
		if (!def) throw new Error("the catalog declares no secret field to test against");
		const secretKey = def.fields.find((f) => f.type === "secret" || f.secret)?.key ?? "";
		const envelope = { iv: "SECRET-IV", tag: "SECRET-TAG", data: "SECRET-CIPHERTEXT" };
		vi.mocked(paginate).mockResolvedValue({
			items: [
				{
					id: "r",
					addon_id: def.id,
					enabled: true,
					mode: "managed",
					version: null,
					namespace: def.namespace,
					status: "READY",
					health: null,
					sync_status: null,
					last_synced_at: null,
					values: { [secretKey]: envelope, replicas: 2 },
					values_yaml: "resources:\n  limits:\n    cpu: 1\n",
					cursor_key: "k",
				},
			],
			page: { mode: "exact", limit: 100, total: 1, next_cursor: null },
		} as never);

		const res = await GET(new Request(URL_BASE), params);
		expect(res.status).toBe(200);
		const text = await res.text();
		// No part of the envelope reaches the wire — not masked, absent.
		expect(text).not.toContain("SECRET-");
		const body = JSON.parse(text);
		expect(body.addons[0].settings).toEqual({ replicas: 2 });
		expect(body.addons[0].settings).not.toHaveProperty(secretKey);
		expect(body.addons[0].secret_keys).toContain(secretKey);
		expect(body.addons[0].values_yaml).toBe("resources:\n  limits:\n    cpu: 1\n");
	});

	it("returns no settings at all for an add-on id the catalog does not know", async () => {
		vi.mocked(paginate).mockResolvedValue({
			items: [
				{
					id: "r",
					addon_id: "retired-addon",
					enabled: true,
					mode: "managed",
					version: null,
					namespace: null,
					status: "READY",
					health: null,
					sync_status: null,
					last_synced_at: null,
					values: { password: "plaintext-from-an-old-row" },
					values_yaml: null,
					cursor_key: "k",
				},
			],
			page: { mode: "exact", limit: 100, total: 1, next_cursor: null },
		} as never);

		const res = await GET(new Request(URL_BASE), params);
		const text = await res.text();
		expect(text).not.toContain("plaintext-from-an-old-row");
		expect(JSON.parse(text).addons[0]).toMatchObject({ settings: {}, secret_keys: [] });
	});
});
