// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6446 — a BYO chart runs in its own namespace, byo-<chart id>, unless it names one.
//
// The table below is the one packages/core/argocd/byo_oci_test.go (byoChartNamespaceCases) pins for
// the Go `argocd.ByoChartNamespace`, as LITERALS, so the attach form's default and the runner's move
// of a legacy chart out of "default" name the same namespace — hash included.

import { describe, expect, it } from "vitest";
import {
	byoChartAttachSchema,
	byoChartFormSchema,
	byoChartNamespace,
	byoNamespacePrefixMessage,
} from "@/lib/validations/byo-charts";
import { byoReservedNamespaceReason } from "@/lib/validations/byo-reserved-namespaces";
import { ADDON_ID_MAX_LENGTH, chartSlug } from "@/lib/validations/names";

const CASES: [id: string, want: string][] = [
	["payments", "byo-payments"],
	["my-chart", "byo-my-chart"],
	["a".repeat(57), `byo-${"a".repeat(57)}`],
	["a".repeat(59), `byo-${"a".repeat(59)}`],
	[`${"b".repeat(58)}-cdef`, `byo-${"b".repeat(50)}-1f994818`],
	[`${"b".repeat(58)}-zzzz`, `byo-${"b".repeat(50)}-646f1ab0`],
	["c".repeat(70), `byo-${"c".repeat(50)}-6335c5d7`],
];

describe("byoChartNamespace", () => {
	it("matches the runner's table", () => {
		for (const [id, want] of CASES) {
			expect({ id, ns: byoChartNamespace(id) }).toEqual({ id, ns: want });
		}
	});

	it("is never reserved, always legal, its chart's own, and distinct per id", () => {
		const seen = new Set<string>();
		for (const [id] of CASES) {
			const ns = byoChartNamespace(id);
			expect(byoReservedNamespaceReason(ns)).toBeNull();
			expect(byoNamespacePrefixMessage(ns, id)).toBeNull();
			expect(ns.length).toBeLessThanOrEqual(63);
			expect(ns).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
			expect(seen.has(ns)).toBe(false);
			seen.add(ns);
		}
	});

	it("fits a NEW chart's longest id without a cut", () => {
		// A display name (not an already-stored id, which chartSlug keeps as it is) is slugified and capped.
		const id = chartSlug("X".repeat(200));
		expect(id.length).toBe(ADDON_ID_MAX_LENGTH);
		expect(byoChartNamespace(id)).toBe(`byo-${id}`);
	});
});

describe("the byo- prefix is reserved for derived namespaces", () => {
	const attach = (id: string, namespace: string) =>
		byoChartAttachSchema.safeParse({
			projectId: "p1",
			id,
			repoUrl: "https://github.com/acme/charts",
			chartPath: "charts/api",
			namespace,
		}).success;

	it("lets the attach action store a chart's own derived namespace", () => {
		expect(attach("api", "byo-api")).toBe(true);
		// The id is canonicalised the way the action stores it.
		expect(attach("My API", "byo-my-api")).toBe(true);
	});

	it("refuses another chart's byo- namespace on the attach action", () => {
		expect(attach("api", "byo-payments")).toBe(false);
	});

	it("refuses any typed byo- namespace on the form, where blank gives the chart its own", () => {
		const form = (namespace: string) =>
			byoChartFormSchema.safeParse({
				source: "git",
				repoUrl: "https://github.com/acme/charts",
				chartPath: "charts/api",
				namespace,
			});
		const refused = form("byo-api");
		expect(refused.success).toBe(false);
		if (!refused.success) {
			expect(refused.error.issues.find((i) => i.path.join(".") === "namespace")?.message).toMatch(
				/reserved for the namespace each chart gets by default/,
			);
		}
		expect(form("").success).toBe(true);
		expect(form("api-byo").success).toBe(true);
	});
});
