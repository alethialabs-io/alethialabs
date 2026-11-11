// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6541 — the snapshot's `byo_admission`: the environment's setting, and which of its BYO charts were
// last read back in a running state. `last_synced_at` is NOT the signal: it is stamped for names whose
// Application does not exist (the health read seeds Unknown/Unknown), so a chart the deploy refused
// would be listed after the next drift scan.

import { describe, expect, it } from "vitest";
import { byoAdmissionSnapshot } from "@/lib/addons/byo-admission";

describe("byoAdmissionSnapshot", () => {
	it("lists exactly the BYO charts read back in a running state, sorted, with the setting", () => {
		expect(
			byoAdmissionSnapshot(true, [
				{ source: "byo", addon_id: "shop", health: "Healthy" },
				{ source: "byo", addon_id: "api", health: "Degraded" },
				{ source: "byo", addon_id: "jobs", health: "Progressing" },
				{ source: "byo", addon_id: "paused", health: "Suspended" },
				{ source: "byo", addon_id: "fresh", health: null },
				{ source: "catalog", addon_id: "grafana", health: "Healthy" },
			]),
		).toEqual({ enforce: true, deployed_charts: ["api", "jobs", "paused", "shop"] });
	});

	it("a drift scan's Unknown for a refused chart, or Missing resources, is not history", () => {
		expect(
			byoAdmissionSnapshot(false, [
				{ source: "byo", addon_id: "refused", health: "Unknown" },
				{ source: "byo", addon_id: "missing", health: "Missing" },
			]),
		).toEqual({ enforce: false, deployed_charts: [] });
	});

	it("is null — the key left off, the snapshot bytes unchanged — without a BYO chart", () => {
		expect(byoAdmissionSnapshot(true, [{ source: "catalog", addon_id: "grafana", health: "Healthy" }])).toBeNull();
		expect(byoAdmissionSnapshot(false, [])).toBeNull();
	});
});
