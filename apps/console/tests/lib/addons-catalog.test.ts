// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the add-on catalog: resolving an enabled project_addons row into the
// runner-facing install spec (chart coords + merged Helm values), and catalog integrity.

import { describe, expect, it } from "vitest";
import {
	ADDON_CATALOG,
	deepMerge,
	getAddOn,
	resolveAddOnInstall,
} from "@/lib/addons/catalog";

describe("deepMerge", () => {
	it("merges nested objects, override wins, arrays replace", () => {
		expect(
			deepMerge(
				{ a: { x: 1, y: 2 }, list: [1, 2] },
				{ a: { y: 9, z: 3 }, list: [3] },
			),
		).toEqual({ a: { x: 1, y: 9, z: 3 }, list: [3] });
	});
});

describe("getAddOn", () => {
	it("returns a known add-on and null for an unknown id", () => {
		expect(getAddOn("kube-prometheus-stack")?.chart).toBe(
			"kube-prometheus-stack",
		);
		expect(getAddOn("does-not-exist")).toBeNull();
	});
});

describe("resolveAddOnInstall", () => {
	it("resolves chart coords + merges user knobs onto defaults", () => {
		const spec = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			values: { retentionDays: 30, storageGb: 50, grafana: false },
		});
		expect(spec).not.toBeNull();
		expect(spec?.chartRepo).toContain("prometheus-community");
		expect(spec?.namespace).toBe("monitoring");
		expect(spec?.mode).toBe("managed");
		// User knob → merged Helm value.
		const values = spec?.values as {
			grafana: { enabled: boolean };
			prometheus: { prometheusSpec: { retention: string } };
		};
		expect(values.prometheus.prometheusSpec.retention).toBe("30d");
		expect(values.grafana.enabled).toBe(false);
	});

	it("falls back to schema defaults when stored knobs are invalid", () => {
		const spec = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			values: { retentionDays: "not-a-number" as unknown as number },
		});
		// Default retention (15d) is applied rather than throwing.
		const values = spec?.values as {
			prometheus: { prometheusSpec: { retention: string } };
		};
		expect(values.prometheus.prometheusSpec.retention).toBe("15d");
	});

	it("returns null for a retired add-on id (skipped, not mis-provisioned)", () => {
		expect(
			resolveAddOnInstall({ addon_id: "retired", mode: "managed" }),
		).toBeNull();
	});

	it("honours a version override", () => {
		const spec = resolveAddOnInstall({
			addon_id: "loki",
			mode: "gitops",
			version: "9.9.9",
		});
		expect(spec?.version).toBe("9.9.9");
		expect(spec?.mode).toBe("gitops");
	});
});

describe("ADDON_CATALOG integrity", () => {
	it("every entry has unique id, pinned chart coords, and a fields array", () => {
		const ids = new Set<string>();
		for (const a of ADDON_CATALOG) {
			expect(ids.has(a.id)).toBe(false);
			ids.add(a.id);
			expect(a.chartRepo).toMatch(/^https?:\/\//);
			expect(a.chart).toBeTruthy();
			expect(a.version).toBeTruthy();
			expect(a.namespace).toBeTruthy();
			expect(Array.isArray(a.fields)).toBe(true);
		}
	});
});
