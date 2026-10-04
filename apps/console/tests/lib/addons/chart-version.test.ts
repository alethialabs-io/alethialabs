// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5525: the one definition of a chart-version pin. The value is rendered into an ArgoCD
// Application's targetRevision by the runner, so this is the injection boundary — every refused
// input below is a shape that either moves under the user (a range) or tries to leave the scalar
// (whitespace, a newline, a quote, a template, a YAML document marker).

import { describe, expect, it } from "vitest";
import { getAddOn, resolveAddOnInstall } from "@/lib/addons/catalog";
import {
	CHART_VERSION_REFUSAL,
	CHART_VERSION_TOO_LONG,
	chartVersionError,
	chartVersionIntent,
} from "@/lib/addons/chart-version";

describe("chartVersionError", () => {
	it.each([
		"58.2.1",
		"v58.2.1",
		"0.0.0",
		"1.4.0-rc.1",
		"1.4.0-alpha.0.beta",
		"1.4.0+build.7",
		"v1.4.0-rc.1+sha.5114f85",
	])("accepts the exact version %j", (v) => {
		expect(chartVersionError(v)).toBeNull();
	});

	it("accepts the empty string — it means no pin", () => {
		expect(chartVersionError("")).toBeNull();
	});

	it.each([
		["a caret range", "^58"],
		["a caret range on a full version", "^58.2.1"],
		["a tilde range", "~58.2"],
		["a comparison range", ">=58.0.0"],
		["a wildcard", "*"],
		["an x-range", "58.x"],
		["a partial version", "58.2"],
		["a leading space", " 58.2.1"],
		["a trailing space", "58.2.1 "],
		["an inner space", "58.2.1 || 59.0.0"],
		["a trailing newline", "58.2.1\n"],
		["a newline then a second document", "58.2.1\n---\nkind: ClusterRoleBinding"],
		["a double quote", '58.2.1"'],
		["a single quote", "'58.2.1'"],
		["a Go template", "{{ .Values.x }}"],
		["a template suffix", "58.2.1-{{x}}"],
		["a YAML document marker", "---"],
		["a YAML document end marker", "..."],
		["a leading zero", "058.2.1"],
		["a capital V", "V58.2.1"],
		["a git ref", "main"],
	])("refuses %s (%j) with the actionable sentence", (_label, v) => {
		expect(chartVersionError(v)).toBe(CHART_VERSION_REFUSAL);
	});

	it("refuses a version longer than 64 characters", () => {
		const long = `1.0.0-${"a".repeat(59)}`;
		expect(long).toHaveLength(65);
		expect(chartVersionError(long)).toBe(CHART_VERSION_TOO_LONG);
		expect(chartVersionError(long.slice(0, 64))).toBeNull();
	});

	it("tells the user what IS allowed", () => {
		expect(CHART_VERSION_REFUSAL).toMatch(/exact version, such as 58\.2\.1/);
		expect(CHART_VERSION_REFUSAL).toMatch(/catalog's default/);
	});
});

describe("chartVersionIntent", () => {
	it("keeps the stored pin when the caller did not mention a version", () => {
		expect(chartVersionIntent(undefined)).toEqual({ kind: "keep" });
	});

	it("clears the pin on null or the empty string", () => {
		expect(chartVersionIntent(null)).toEqual({ kind: "clear" });
		expect(chartVersionIntent("")).toEqual({ kind: "clear" });
	});

	it("sets a valid pin verbatim", () => {
		expect(chartVersionIntent("v58.2.1")).toEqual({ kind: "set", version: "v58.2.1" });
	});

	it("throws a prefixed refusal the route maps to 400", () => {
		expect(() => chartVersionIntent("^58")).toThrow(
			`Invalid chart version: ${CHART_VERSION_REFUSAL}`,
		);
	});
});

describe("the pin reaches the install spec the runner renders", () => {
	it("a pinned row resolves to the pin", () => {
		const spec = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			version: "58.2.1",
		});
		expect(spec?.version).toBe("58.2.1");
	});

	it("an unpinned row resolves to exactly the catalog default — unchanged for a user who sets nothing", () => {
		const def = getAddOn("kube-prometheus-stack");
		const unpinned = resolveAddOnInstall({ addon_id: "kube-prometheus-stack", mode: "managed" });
		const nulled = resolveAddOnInstall({
			addon_id: "kube-prometheus-stack",
			mode: "managed",
			version: null,
		});
		expect(unpinned?.version).toBe(def?.version);
		expect(nulled).toEqual(unpinned);
	});
});
