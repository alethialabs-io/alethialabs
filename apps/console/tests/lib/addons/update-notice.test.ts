// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6537: a catalogue chart bump reaches a managed, unpinned install on its next deploy and nothing
// else. These pin who is TOLD, and that the security marker on the catalogue is what makes the
// telling loud — with ingress-nginx 4.15.1, the case that opened the issue.

import { describe, expect, it } from "vitest";
import { ADDON_CATALOG, getAddOn } from "@/lib/addons/catalog";
import { addOnUpdateNotice, compareChartVersions } from "@/lib/addons/update-notice";

const SECURITY = { summary: "Fixes a CVE.", advisoryUrl: "https://example.com/advisory" };
const CATALOG = { version: "4.15.1", securityRelease: SECURITY };

describe("addOnUpdateNotice", () => {
	it("says nothing to an install that is not there", () => {
		expect(addOnUpdateNotice(CATALOG, null)).toBeNull();
	});

	it("says nothing to a managed, unpinned install — it follows the catalogue on the next deploy", () => {
		expect(addOnUpdateNotice(CATALOG, { mode: "managed", version: null })).toBeNull();
	});

	it("offers a pin below the catalogue the catalogue's version, marked security", () => {
		expect(addOnUpdateNotice(CATALOG, { mode: "managed", version: "4.11.2" })).toEqual({
			kind: "pin-behind",
			catalogVersion: "4.15.1",
			installedVersion: "4.11.2",
			security: SECURITY,
		});
	});

	it("offers a pin below an ordinary release without the security marker", () => {
		const notice = addOnUpdateNotice({ version: "4.15.1" }, { mode: "managed", version: "4.11.2" });
		expect(notice).toMatchObject({ kind: "pin-behind", security: null });
	});

	it("says nothing to a pin at or above the catalogue", () => {
		expect(addOnUpdateNotice(CATALOG, { mode: "managed", version: "4.15.1" })).toBeNull();
		expect(addOnUpdateNotice(CATALOG, { mode: "managed", version: "v4.15.1" })).toBeNull();
		expect(addOnUpdateNotice(CATALOG, { mode: "managed", version: "4.16.0" })).toBeNull();
	});

	it("orders by SemVer, not by text: 4.9.0 is older than 4.15.1", () => {
		expect(addOnUpdateNotice(CATALOG, { mode: "managed", version: "4.9.0" })).toMatchObject({
			kind: "pin-behind",
		});
	});

	it("always states the catalogue's version to a GitOps install, whose repo only the runner can read", () => {
		for (const version of [null, "4.11.2", "4.15.1"]) {
			expect(addOnUpdateNotice(CATALOG, { mode: "gitops", version })).toMatchObject({
				kind: "gitops",
				catalogVersion: "4.15.1",
				security: SECURITY,
			});
		}
	});
});

describe("compareChartVersions", () => {
	it.each([
		["4.11.2", "4.15.1", -1],
		["4.15.1", "4.11.2", 1],
		["4.15.1", "v4.15.1", 0],
		["10.0.0", "9.9.9", 1],
		["1.0.0-rc.1", "1.0.0", -1],
		["1.0.0-alpha", "1.0.0-alpha.1", -1],
		["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
		["1.0.0-beta.2", "1.0.0-beta.11", -1],
		["1.0.0+build.1", "1.0.0", 0],
	])("%s vs %s", (a, b, sign) => {
		expect(Math.sign(compareChartVersions(a, b) ?? Number.NaN)).toBe(sign);
	});

	it("refuses to order what is not SemVer", () => {
		expect(compareChartVersions("4.*", "4.15.1")).toBeNull();
		expect(compareChartVersions("4.15", "4.15.1")).toBeNull();
	});
});

describe("the catalogue's security marker", () => {
	it("marks ingress-nginx 4.15.1 a security release, so a 4.11.2 pin is told loudly", () => {
		const def = getAddOn("ingress-nginx");
		expect(def?.version).toBe("4.15.1");
		expect(def?.securityRelease?.summary).toMatch(/CVE-2025-1974/);
		expect(def?.securityRelease?.advisoryUrl).toMatch(/^https:\/\//);
		if (!def) return;
		expect(addOnUpdateNotice(def, { mode: "managed", version: "4.11.2" })?.security).toBe(
			def.securityRelease,
		);
	});

	it("every marker carries a sentence and an https advisory", () => {
		const markers = ADDON_CATALOG.flatMap((def) =>
			def.securityRelease ? [{ id: def.id, ...def.securityRelease }] : [],
		);
		expect(markers.length).toBeGreaterThan(0);
		for (const m of markers) {
			expect(m.summary.length).toBeGreaterThan(20);
			expect(m.advisoryUrl).toMatch(/^https:\/\//);
		}
	});
});
