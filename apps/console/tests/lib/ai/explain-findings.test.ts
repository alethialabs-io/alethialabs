// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
});
