// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// /api/cli/projects/:id/addons and the chart-version pin (#5525).
//   - POST passes `version` through to enableAddon in its three states (absent / null / a pin), and
//     an invalid pin is a 400 carrying the same sentence the console shows.
//   - GET reports the EFFECTIVE version (the pin, else the catalog default) and whether it is pinned.

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
vi.mock("@/lib/cli/paging", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cli/paging")>();
	return { ...actual, paginate: vi.fn() };
});

import { GET, POST } from "@/app/api/cli/projects/[id]/addons/route";
import { enableAddon } from "@/app/server/actions/addons";
import { getAddOn } from "@/lib/addons/catalog";
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
