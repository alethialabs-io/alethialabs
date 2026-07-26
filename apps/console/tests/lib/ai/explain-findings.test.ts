// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "LLM = explanation" half of the AI-audit loop. The model call is injected, so
// the orchestration is fully tested without a live model: prompt selection, parsing,
// and graceful degradation on malformed responses (the model is advisory only).

import { describe, expect, it } from "vitest";
import {
	buildExplainPrompt,
	explainableControls,
	explainFindings,
	parseExplanations,
} from "@/lib/ai/explain-findings";
import type { CompatReport } from "@/types/compat.types";
import type { VerifyControlResult, VerifyReport } from "@/types/jsonb.types";

function control(
	id: string,
	status: VerifyControlResult["status"],
): VerifyControlResult {
	return {
		id,
		title: `${id} title`,
		severity: "high",
		status,
		provider: "aws",
		findings: status === "fail" ? [{ address: "res.x", message: "bad" }] : [],
	};
}

function report(controls: VerifyControlResult[]): VerifyReport {
	return {
		verdict: "fail",
		catalog_version: "test",
		provider: "aws",
		controls,
		summary: { pass: 0, fail: 1, warn: 0, not_evaluable: 0 },
	};
}

describe("explainableControls", () => {
	it("selects only fail/warn controls", () => {
		const r = report([
			control("A", "fail"),
			control("B", "pass"),
			control("C", "warn"),
			control("D", "not_evaluable"),
		]);
		expect(explainableControls(r).map((c) => c.id)).toEqual(["A", "C"]);
	});
});

describe("buildExplainPrompt", () => {
	it("includes control ids, findings, and a JSON-only instruction", () => {
		const p = buildExplainPrompt([control("KEYLESS-001", "fail")]);
		expect(p).toContain("KEYLESS-001");
		expect(p).toContain("res.x: bad");
		expect(p).toMatch(/JSON array/i);
	});
});

describe("parseExplanations", () => {
	it("joins model output to controls", () => {
		const raw = JSON.stringify([
			{ id: "A", explanation: "because X", remediation: "do Y" },
		]);
		const out = parseExplanations(raw, [control("A", "fail")]);
		expect(out[0]).toMatchObject({ id: "A", explanation: "because X", remediation: "do Y" });
	});

	it("tolerates code fences / surrounding prose", () => {
		const raw = "Here you go:\n```json\n[{\"id\":\"A\",\"explanation\":\"x\",\"remediation\":\"y\"}]\n```";
		const out = parseExplanations(raw, [control("A", "fail")]);
		expect(out[0].explanation).toBe("x");
	});

	it("degrades to a generic message on malformed output (model is advisory)", () => {
		const out = parseExplanations("not json at all", [control("A", "fail")]);
		expect(out).toHaveLength(1);
		expect(out[0].explanation).toContain("did not pass");
		expect(out[0].remediation).toContain("re-run the gate");
	});

	it("fills missing controls not mentioned by the model", () => {
		const raw = JSON.stringify([{ id: "A", explanation: "x", remediation: "y" }]);
		const out = parseExplanations(raw, [control("A", "fail"), control("B", "warn")]);
		expect(out.map((o) => o.id)).toEqual(["A", "B"]);
		expect(out[1].explanation).toContain("did not pass");
	});
});

describe("explainFindings", () => {
	it("returns [] when nothing fails", async () => {
		const r = report([control("A", "pass")]);
		const out = await explainFindings(r, async () => "[]");
		expect(out).toEqual([]);
	});

	it("calls the injected model and returns explanations", async () => {
		const r = report([control("A", "fail")]);
		let seenPrompt = "";
		const out = await explainFindings(r, async (prompt) => {
			seenPrompt = prompt;
			return JSON.stringify([{ id: "A", explanation: "e", remediation: "r" }]);
		});
		expect(seenPrompt).toContain("A");
		expect(out[0]).toMatchObject({ id: "A", explanation: "e", remediation: "r" });
	});

	// The explainer is report-agnostic: a compat report (no `provider`/`frameworks`,
	// same control surface) flows through the same path as a verify report (#1219).
	it("explains a compat report's failing controls too", async () => {
		const r: CompatReport = {
			verdict: "fail",
			catalog_version: "compat-test",
			controls: [
				{
					id: "COMPAT-001",
					title: "k8s ↔ cloud version",
					severity: "high",
					status: "fail",
					findings: [{ address: "cluster.k8s", message: "1.35 unsupported on eks" }],
				},
				{ id: "COMPAT-ADDON", title: "add-on pin", severity: "low", status: "pass" },
			],
			summary: { pass: 1, fail: 1, warn: 0, not_evaluable: 0 },
		};
		expect(explainableControls(r).map((c) => c.id)).toEqual(["COMPAT-001"]);
		const out = await explainFindings(r, async () =>
			JSON.stringify([{ id: "COMPAT-001", explanation: "e", remediation: "r" }]),
		);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: "COMPAT-001", explanation: "e", remediation: "r" });
	});
});
