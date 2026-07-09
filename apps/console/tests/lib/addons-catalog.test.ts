// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the add-on catalog: resolving an enabled project_addons row into the
// runner-facing install spec (chart coords + merged Helm values), and catalog integrity.

import { describe, expect, it } from "vitest";
import {
	ADDON_CATALOG,
	deepMerge,
	getAddOn,
	parseValuesYaml,
	resolveAddOnInstall,
	resolveByoChartInstall,
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

	it("deep-merges raw values_yaml on top of the knobs (raw wins)", () => {
		const spec = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			values: { grafana: true },
			values_yaml:
				"grafana:\n  adminPassword: s3cr3t\nprometheus:\n  prometheusSpec:\n    retention: 90d\n",
		});
		const v = spec?.values as {
			grafana: { enabled: boolean; adminPassword: string };
			prometheus: { prometheusSpec: { retention: string } };
		};
		// Raw YAML extends (adminPassword) and overrides (retention) the knob values.
		expect(v.grafana.adminPassword).toBe("s3cr3t");
		expect(v.grafana.enabled).toBe(true); // knob preserved where raw didn't touch it
		expect(v.prometheus.prometheusSpec.retention).toBe("90d");
	});

	it("ignores malformed / non-mapping values_yaml (never blocks a deploy)", () => {
		const spec = resolveAddOnInstall({
			addon_id: "loki",
			mode: "managed",
			values_yaml: ":\n  - not valid yaml: [",
		});
		expect(spec).not.toBeNull();
	});
});

describe("resolveByoChartInstall", () => {
	it("resolves a git-source spec (path + ref + repo) from a byo row", () => {
		const spec = resolveByoChartInstall({
			addon_id: "payments",
			mode: "managed",
			chart_repo: "https://github.com/acme/payments-helm",
			chart_path: "charts/payments",
			version: "main",
			namespace: "payments",
			values: { replicas: 2 },
		});
		expect(spec).not.toBeNull();
		expect(spec).toMatchObject({
			id: "payments",
			source: "git",
			chartRepo: "https://github.com/acme/payments-helm",
			path: "charts/payments",
			chart: "",
			version: "main",
			namespace: "payments",
			values: { replicas: 2 },
		});
	});

	it("defaults ref to HEAD and namespace to default", () => {
		const spec = resolveByoChartInstall({
			addon_id: "svc",
			mode: "managed",
			chart_repo: "https://github.com/acme/svc",
			chart_path: "chart",
		});
		expect(spec?.version).toBe("HEAD");
		expect(spec?.namespace).toBe("default");
	});

	it("deep-merges a raw values_yaml override on top of stored values", () => {
		const spec = resolveByoChartInstall({
			addon_id: "svc",
			mode: "managed",
			chart_repo: "https://github.com/acme/svc",
			chart_path: "chart",
			values: { image: { tag: "1.0" }, replicas: 1 },
			values_yaml: "image:\n  tag: v2",
		});
		expect(spec?.values).toEqual({ image: { tag: "v2" }, replicas: 1 });
	});

	it("returns null when the git coordinates are missing", () => {
		expect(
			resolveByoChartInstall({ addon_id: "x", mode: "managed", chart_path: "chart" }),
		).toBeNull();
		expect(
			resolveByoChartInstall({ addon_id: "x", mode: "managed", chart_repo: "https://x" }),
		).toBeNull();
	});
});

describe("parseValuesYaml", () => {
	it("parses a YAML mapping, rejects empty/scalar/list", () => {
		expect(parseValuesYaml("a: 1\nb:\n  c: 2")).toEqual({ a: 1, b: { c: 2 } });
		expect(parseValuesYaml("")).toBeNull();
		expect(parseValuesYaml("   ")).toBeNull();
		expect(parseValuesYaml("just a scalar")).toBeNull();
		expect(parseValuesYaml("- a\n- b")).toBeNull();
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
