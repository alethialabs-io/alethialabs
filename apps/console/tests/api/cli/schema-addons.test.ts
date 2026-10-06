// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/schema/addons (#5528) — the catalog `alethia plan` checks an alethia.yaml against.
//   - It is gated like the component schema it sits beside.
//   - It names every catalog add-on, with its secret settings by NAME and never a default for one.
//   - It publishes the chart-version rule the server itself applies, so the CLI holds no copy.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));

import { GET } from "@/app/api/cli/schema/addons/route";
import { ADDON_CATALOG } from "@/lib/addons/catalog";
import { chartVersionError } from "@/lib/addons/chart-version";
import { secretFieldKeys } from "@/lib/addons/secrets";
import { authorizeCli } from "@/lib/authz/guard";
import { addonSettingDefaults } from "@/lib/cli/addon-catalog";
import { asRecord } from "@/lib/records";
import { cliAddonCatalogResponse } from "@/lib/validations/cli-contract";

const URL_ = "https://console.local/api/cli/schema/addons";

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
	} as never);
});

/** Fetches and parses the document through the route. */
async function document() {
	const res = await GET(new Request(URL_));
	expect(res.status).toBe(200);
	return cliAddonCatalogResponse.parse(await res.json());
}

describe("GET /api/cli/schema/addons", () => {
	it("enforces project:view, and returns the guard's denial with no document", async () => {
		const denied = new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
		vi.mocked(authorizeCli).mockResolvedValue({ error: denied } as never);
		const res = await GET(new Request(URL_));
		expect(authorizeCli).toHaveBeenCalledWith(expect.any(Request), "view", { type: "project" });
		expect(res.status).toBe(403);
	});

	it("lists every catalog add-on with its default version", async () => {
		const doc = await document();
		expect(doc.addons.map((a) => a.id)).toEqual(ADDON_CATALOG.map((d) => d.id));
		for (const def of ADDON_CATALOG) {
			expect(doc.addons.find((a) => a.id === def.id)?.version).toBe(def.version);
		}
	});

	it("names secret settings and never carries a default for one", async () => {
		const doc = await document();
		const withSecrets = ADDON_CATALOG.filter((d) => secretFieldKeys(d).length > 0);
		expect(withSecrets.length).toBeGreaterThan(0);
		for (const def of withSecrets) {
			const entry = doc.addons.find((a) => a.id === def.id);
			expect(entry?.secret_keys).toEqual(secretFieldKeys(def));
			for (const key of secretFieldKeys(def)) {
				expect(entry?.defaults).not.toHaveProperty(key);
			}
		}
	});

	it("publishes defaults equal to what a reset stores: configSchema.parse({}) without secrets", () => {
		for (const def of ADDON_CATALOG) {
			const parsed = def.configSchema.safeParse({});
			if (!parsed.success) continue;
			const defaults = addonSettingDefaults(def);
			for (const [key, value] of Object.entries(defaults)) {
				expect(asRecord(parsed.data)[key]).toEqual(value);
			}
		}
	});

	it("publishes every setting key the add-on's schema declares, secret ones included", async () => {
		const doc = await document();
		for (const def of ADDON_CATALOG) {
			const entry = doc.addons.find((a) => a.id === def.id);
			expect(entry?.settings).not.toBeNull();
			for (const f of def.fields) expect(entry?.settings).toContain(f.key);
			for (const key of secretFieldKeys(def)) expect(entry?.settings).toContain(key);
		}
	});

	it("publishes the server's own chart-version rule", async () => {
		const doc = await document();
		const re = new RegExp(doc.chart_version.pattern);
		for (const v of ["58.2.1", "v1.15.0", "1.0.0-rc.1+build.5"]) {
			expect(re.test(v)).toBe(true);
			expect(chartVersionError(v)).toBeNull();
		}
		for (const v of ["^58", "~58.2", ">=58", "*", "58", "1.2.3\n", "1.2.3 "]) {
			expect(re.test(v)).toBe(false);
			expect(chartVersionError(v)).not.toBeNull();
		}
		expect(doc.chart_version.max_length).toBe(64);
	});
});
