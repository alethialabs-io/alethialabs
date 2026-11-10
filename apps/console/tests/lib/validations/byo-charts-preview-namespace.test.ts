// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6494 — a BYO chart may not target one of its project's preview namespaces.
//
// The rule mirrors the Go `argocd.ByoPreviewNamespaceConflict`, whose test pins it to the namespace
// patterns the preview guardrails renderer emits. The case table is READ out of
// packages/core/argocd/byo_test.go (byoPreviewCases) rather than restated, so the two sides cannot
// drift apart: a case added or changed in Go is checked here too.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { byoPreviewNamespaceMessage } from "@/lib/validations/byo-charts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/console/tests/lib/validations → repo root is five levels up.
const GO_TEST = join(__dirname, "../../../../../packages/core/argocd/byo_test.go");

/** The `byoPreviewCases` table from the Go test, as [namespace, conflicts] pairs. */
function goCases(): [string, boolean][] {
	const src = readFileSync(GO_TEST, "utf8");
	const block = src.match(/var byoPreviewCases = \[\]struct \{[\s\S]*?\n\}\{([\s\S]*?)\n\}/);
	if (!block) throw new Error("byoPreviewCases not found in byo_test.go");
	return [...block[1].matchAll(/\{"([^"]+)",\s*(true|false)\}/g)].map((m) => [m[1], m[2] === "true"]);
}

describe("byoPreviewNamespaceMessage", () => {
	it("agrees with the Go rule on every case of its table (prefix pr)", () => {
		const cases = goCases();
		// A table that parsed to nothing would pass on any rule.
		expect(cases.length).toBeGreaterThanOrEqual(6);
		expect(cases.some(([, c]) => c)).toBe(true);
		expect(cases.some(([, c]) => !c)).toBe(true);
		for (const [ns, conflict] of cases) {
			expect({ ns, conflict: byoPreviewNamespaceMessage(ns, "pr") !== null }).toEqual({ ns, conflict });
		}
	});

	it("admits a namespace that only shares the prefix's letters", () => {
		expect(byoPreviewNamespaceMessage("pre-7", "pr")).toBeNull();
		expect(byoPreviewNamespaceMessage("pr-7", "pr")).not.toBeNull();
	});

	it("names the namespace and the prefix, and says what to change", () => {
		const msg = byoPreviewNamespaceMessage("preview-api", " preview ") ?? "";
		expect(msg).toContain("“preview-api”");
		expect(msg).toContain("“preview-”");
		expect(msg).toContain("Choose a namespace");
		expect(msg).toContain("preview namespace prefix");
	});

	it("conflicts with nothing when the project has no preview configuration", () => {
		for (const prefix of [null, undefined, "", "  "]) {
			expect(byoPreviewNamespaceMessage("preview-1", prefix)).toBeNull();
		}
	});
});
