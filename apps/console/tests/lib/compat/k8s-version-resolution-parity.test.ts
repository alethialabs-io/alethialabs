// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-language parity for the Kubernetes-version resolution — the TS half (#5314).
//
// The apply gate judges packages/core/cloud's ResolveK8sVersion; the console's compat surfaces
// judge lib/compat/resolve.ts. If they resolved an unset version differently, the canvas would warn
// about one Kubernetes version while the gate refused (or passed) another. Go is the authority — its
// answer is what tofu receives — so the fixture is generated there:
//   cd packages/core && UPDATE_FIXTURES=1 go test ./cloud/ -run TestK8sVersionResolutionParityFixture

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_K8S_VERSION } from "@/lib/cloud-providers/generated/catalog";
import { BYO_IAC_K8S_VERSION_REASON, evaluate, judgedK8sVersion, resolveK8sVersion } from "@/lib/compat";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/lib/compat → repo root is five levels up.
const FIXTURE = join(__dirname, "../../../../../packages/core/cloud/testdata/k8s_version_resolution.json");

interface ResolutionCase {
	provider: string;
	config_version: string;
	want: string;
}

/** Narrow the Go-written fixture without an `any` or a cast. */
function loadCases(): ResolutionCase[] {
	const parsed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
	if (parsed === null || typeof parsed !== "object") throw new TypeError("fixture is not an object");
	const doc: Record<string, unknown> = { ...parsed };
	if (!Array.isArray(doc.cases)) throw new TypeError("fixture has no cases array");
	return doc.cases.map((raw, i) => {
		if (raw === null || typeof raw !== "object") throw new TypeError(`cases[${i}] is not an object`);
		const c: Record<string, unknown> = { ...raw };
		const field = (k: string): string => {
			const v = c[k];
			if (typeof v !== "string") throw new TypeError(`cases[${i}].${k} is not a string`);
			return v;
		};
		return { provider: field("provider"), config_version: field("config_version"), want: field("want") };
	});
}

describe("resolveK8sVersion — parity with the Go resolver the apply gate uses", () => {
	const cases = loadCases();

	it("the fixture resolves at least one unset version (not vacuous)", () => {
		expect(cases.some((c) => c.config_version === "" && c.want !== "")).toBe(true);
	});

	it.each(cases)("$provider / config_version=$config_version matches Go ($want)", (c) => {
		// Go's "" (no default for an unknown cloud) is the console's `undefined`.
		expect(resolveK8sVersion(c.provider, c.config_version) ?? "").toBe(c.want);
	});
});

describe("resolveK8sVersion — what the compat surfaces judge", () => {
	it("judges an unset version as the catalog default, so the cloud window is evaluated", () => {
		const k8sVersion = resolveK8sVersion("aws", undefined);
		expect(k8sVersion).toBe(DEFAULT_K8S_VERSION.aws);
		const report = evaluate({ providers: ["aws"], k8sVersion });
		expect(report.controls.find((c) => c.id === "COMPAT-K8S-CLOUD-AWS")?.status).toBe("pass");
	});

	it("treats null and empty as unset", () => {
		expect(resolveK8sVersion("gcp", null)).toBe(resolveK8sVersion("gcp", ""));
		expect(resolveK8sVersion("gcp", "")).toBeTruthy();
	});

	it("leaves an explicit version unchanged", () => {
		expect(resolveK8sVersion("azure", "1.30")).toBe("1.30");
	});

	it("yields undefined with no version and no known cloud, which the engine reports not_evaluable", () => {
		expect(resolveK8sVersion(null, undefined)).toBeUndefined();
		expect(resolveK8sVersion("no-such-cloud", "")).toBeUndefined();
	});
});

// #5365 — the canvas's BYO-IaC split, mirroring compatK8sVersion in deploy.go and the config-time
// report in projects.ts: BYO keeps the raw value; unset carries the module reason.
describe("judgedK8sVersion", () => {
	it("resolves an unset version to the catalog default on the template path", () => {
		expect(judgedK8sVersion("aws", "", false)).toEqual({
			version: resolveK8sVersion("aws", ""),
			reason: undefined,
		});
	});

	it("leaves an unset version unjudged on BYO-IaC, with the module reason", () => {
		expect(judgedK8sVersion("aws", "", true)).toEqual({
			version: undefined,
			reason: BYO_IAC_K8S_VERSION_REASON,
		});
	});

	it("judges an explicit version as written on BYO-IaC", () => {
		expect(judgedK8sVersion("aws", "1.30", true)).toEqual({ version: "1.30", reason: undefined });
	});
});
