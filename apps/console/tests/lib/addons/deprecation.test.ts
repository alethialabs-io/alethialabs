// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6543: a deprecated add-on steers new installs to its replacement, refuses them from its removal
// date, and never touches an environment that already has it. The second half pins the catalogue
// itself: every marker names a real, non-deprecated replacement, a real day, and a docs page.

import { describe, expect, it } from "vitest";
import { ADDON_CATALOG, addOnDeprecationView, getAddOn } from "@/lib/addons/catalog";
import {
	closedToNewInstalls,
	newInstallRefusal,
	parseRemovalDate,
} from "@/lib/addons/deprecation";
import type { AddOnDeprecation } from "@/lib/addons/types";

const DEP: AddOnDeprecation = {
	reason: "Upstream retired it.",
	replacementId: "envoy-gateway",
	removalDate: "2027-02-09",
	migrationGuideUrl: "https://alethialabs.io/docs/guides/design-project/migrate-from-ingress-nginx",
};

describe("parseRemovalDate", () => {
	it("reads a YYYY-MM-DD day as its UTC midnight", () => {
		expect(parseRemovalDate("2027-02-09")?.toISOString()).toBe("2027-02-09T00:00:00.000Z");
	});

	it.each(["2027-02-30", "2027-13-01", "2027-2-9", "09/02/2027", "2027-02-09T00:00:00Z", ""])(
		"refuses %j rather than rolling it to some other day",
		(date) => {
			expect(parseRemovalDate(date)).toBeNull();
		},
	);
});

describe("closedToNewInstalls", () => {
	it("is open up to the last millisecond before the removal day", () => {
		expect(closedToNewInstalls(DEP, new Date("2027-02-08T23:59:59.999Z"))).toBe(false);
	});

	it("closes at the start of the removal day, UTC", () => {
		expect(closedToNewInstalls(DEP, new Date("2027-02-09T00:00:00.000Z"))).toBe(true);
		expect(closedToNewInstalls(DEP, new Date("2028-01-01T00:00:00Z"))).toBe(true);
	});

	it("fails closed on a date it cannot read", () => {
		expect(closedToNewInstalls({ ...DEP, removalDate: "soon" }, new Date("2020-01-01"))).toBe(true);
	});
});

describe("newInstallRefusal", () => {
	const def = { name: "Ingress NGINX", deprecated: DEP };
	const after = new Date("2027-03-01T00:00:00Z");
	const before = new Date("2027-01-01T00:00:00Z");

	it("refuses a NEW install from the removal date, naming the replacement and the guide", () => {
		const msg = newInstallRefusal(def, "Envoy Gateway", false, after);
		expect(msg).toContain("no longer accepts new installs (since 2027-02-09)");
		expect(msg).toContain("Enable Envoy Gateway (envoy-gateway) instead");
		expect(msg).toContain(DEP.migrationGuideUrl);
	});

	it("never refuses an environment that already has it — a reconfigure always goes through", () => {
		expect(newInstallRefusal(def, "Envoy Gateway", true, after)).toBeNull();
	});

	it("accepts a new install before the removal date (the console steers; it does not refuse)", () => {
		expect(newInstallRefusal(def, "Envoy Gateway", false, before)).toBeNull();
	});

	it("says nothing for an add-on that is not deprecated", () => {
		expect(newInstallRefusal({ name: "Velero" }, "", false, after)).toBeNull();
		expect(newInstallRefusal({ name: "Velero", deprecated: null }, "", false, after)).toBeNull();
	});
});

describe("the catalogue's deprecation markers", () => {
	const deprecated = ADDON_CATALOG.filter((a) => a.deprecated);

	it("marks ingress-nginx, the retired controller", () => {
		expect(getAddOn("ingress-nginx")?.deprecated).toBeDefined();
	});

	it.each(deprecated.map((a) => [a.id, a] as const))(
		"%s names a replacement in the catalogue that is not itself deprecated",
		(_id, a) => {
			const replacement = getAddOn(a.deprecated?.replacementId ?? "");
			expect(replacement).not.toBeNull();
			expect(replacement?.deprecated).toBeUndefined();
			expect(replacement?.id).not.toBe(a.id);
		},
	);

	it.each(deprecated.map((a) => [a.id, a] as const))(
		"%s has a real removal day, a reason and an Alethia docs migration guide",
		(_id, a) => {
			expect(parseRemovalDate(a.deprecated?.removalDate ?? "")).not.toBeNull();
			expect(a.deprecated?.reason.trim().length).toBeGreaterThan(0);
			expect(a.deprecated?.migrationGuideUrl).toMatch(/^https:\/\/alethialabs\.io\/docs\//);
		},
	);

	it("resolves the replacement's display name for the console", () => {
		const nginx = getAddOn("ingress-nginx");
		if (!nginx) throw new Error("ingress-nginx is not in the catalogue");
		const view = addOnDeprecationView(nginx);
		const replacement = getAddOn(nginx.deprecated?.replacementId ?? "");
		expect(view?.replacementName).toBe(replacement?.name);
		expect(addOnDeprecationView({ ...nginx, deprecated: undefined })).toBeNull();
	});
});
