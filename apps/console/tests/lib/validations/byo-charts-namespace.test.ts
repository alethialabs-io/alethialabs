// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6446 — a BYO chart runs in its own namespace, byo-<chart id>, unless it names one.
//
// The table below is the one packages/core/argocd/byo_oci_test.go (byoChartNamespaceCases) pins for
// the Go `argocd.ByoChartNamespace`, so the attach form's default and the runner's move of a legacy
// chart out of "default" name the same namespace.

import { describe, expect, it } from "vitest";
import { byoChartNamespace } from "@/lib/validations/byo-charts";
import { byoReservedNamespaceReason } from "@/lib/validations/byo-reserved-namespaces";
import { ADDON_ID_MAX_LENGTH, chartSlug } from "@/lib/validations/names";

const CASES: [id: string, want: string][] = [
	["payments", "byo-payments"],
	["my-chart", "byo-my-chart"],
	["a".repeat(57), `byo-${"a".repeat(57)}`],
	[`${"b".repeat(58)}-cdef`, `byo-${"b".repeat(58)}`],
	["c".repeat(70), `byo-${"c".repeat(59)}`],
];

describe("byoChartNamespace", () => {
	it("matches the runner's table", () => {
		for (const [id, want] of CASES) {
			expect({ id, ns: byoChartNamespace(id) }).toEqual({ id, ns: want });
		}
	});

	it("is never a reserved namespace and always a legal one", () => {
		for (const [id] of CASES) {
			const ns = byoChartNamespace(id);
			expect(byoReservedNamespaceReason(ns)).toBeNull();
			expect(ns.length).toBeLessThanOrEqual(63);
			expect(ns).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
		}
	});

	it("fits a NEW chart's longest id without a cut", () => {
		// A display name (not an already-stored id, which chartSlug keeps as it is) is slugified and capped.
		const id = chartSlug("X".repeat(200));
		expect(id.length).toBe(ADDON_ID_MAX_LENGTH);
		expect(byoChartNamespace(id)).toBe(`byo-${id}`);
	});
});
