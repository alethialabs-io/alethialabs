// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6541 — the snapshot's `byo_admission`: the environment's setting, and which of its BYO charts have
// EVER been read back in a running state (`first_observed_running_at`, sticky). Neither the current
// `health` (a drift scan rewrites it to Unknown after a re-provision) nor `last_synced_at` (stamped
// for Applications that do not exist) is the signal.

import { describe, expect, it } from "vitest";
import { byoAdmissionSnapshot, isRunningHealth } from "@/lib/addons/byo-admission";

const ran = new Date("2026-11-01T00:00:00Z");

describe("byoAdmissionSnapshot", () => {
	it("lists exactly the BYO charts ever observed running, sorted, with the setting", () => {
		expect(
			byoAdmissionSnapshot(true, [
				{ source: "byo", addon_id: "shop", first_observed_running_at: ran },
				{ source: "byo", addon_id: "api", first_observed_running_at: ran },
				{ source: "byo", addon_id: "fresh", first_observed_running_at: null },
				{ source: "catalog", addon_id: "grafana", first_observed_running_at: ran },
			]),
		).toEqual({ enforce: true, deployed_charts: ["api", "shop"] });
	});

	it("is an empty list, not an absent key, when no BYO chart has run yet", () => {
		expect(byoAdmissionSnapshot(false, [{ source: "byo", addon_id: "fresh", first_observed_running_at: null }])).toEqual({
			enforce: false,
			deployed_charts: [],
		});
	});

	it("is null — the key left off, the snapshot bytes unchanged — without a BYO chart", () => {
		expect(byoAdmissionSnapshot(true, [{ source: "catalog", addon_id: "grafana", first_observed_running_at: ran }])).toBeNull();
		expect(byoAdmissionSnapshot(false, [])).toBeNull();
	});
});

describe("isRunningHealth", () => {
	it("is a state whose Application exists with resources; never Unknown, Missing or nothing", () => {
		for (const h of ["Healthy", "Progressing", "Degraded", "Suspended"]) expect(isRunningHealth(h)).toBe(true);
		for (const h of ["Unknown", "Missing", "", null, undefined]) expect(isRunningHealth(h)).toBe(false);
	});
});
