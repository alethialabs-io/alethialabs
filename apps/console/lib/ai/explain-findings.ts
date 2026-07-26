// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { asRecord } from "@/lib/records";
import type { CompatControlResult, CompatReport } from "@/types/compat.types";
import type { VerifyControlResult, VerifyReport } from "@/types/jsonb.types";

/**
 * The "LLM = explanation" half of the elench AI-audit division of labor (A6§7): the
 * deterministic gate decides pass/fail; the model only EXPLAINS a failing control
 * and suggests a fix in plain English. It is never the gate and has no write path —
 * any proposed fix is separately re-validated by `verify.ReVerify` before it could
 * ever be offered. The model call is injected so this orchestration is unit-tested
 * without a live model; the server action supplies the real AI-gateway call.
 *
 * Handles both gate reports uniformly: the elench verify report (packages/core/verify)
 * and the version-compatibility report (packages/core/compat, #1219). Both expose the
 * same explainable surface — controls with `{ id, title, status, findings }` — so the
 * orchestration is report-agnostic.
 */

/** A report the explainer can consume: either gate's report shares this control surface. */
type ExplainableReport = VerifyReport | CompatReport;
/** A control from either gate — only the shared fields are read below. */
type ExplainableControl = VerifyControlResult | CompatControlResult;

export interface ControlExplanation {
	id: string;
	title: string;
	/** Plain-English why-it-failed. */
	explanation: string;
	/** A suggested remediation (advisory only — re-validated by the gate). */
	remediation: string;
}

/** The injected model call: takes a prompt, returns the model's raw text. */
export type GenerateText = (prompt: string) => Promise<string>;

/** Controls worth explaining: hard fails and warnings (not pass / not_evaluable). */
export function explainableControls(
	report: ExplainableReport,
): ExplainableControl[] {
	// Widen to the shared control surface first — `report.controls` is a union of the
	// two gates' arrays, and the intermediate binding lets `.filter` narrow cleanly.
	const controls: ExplainableControl[] = report.controls;
	return controls.filter((c) => c.status === "fail" || c.status === "warn");
}

/** Build the explanation prompt for a set of failing controls. */
export function buildExplainPrompt(controls: ExplainableControl[]): string {
	const lines = controls.map((c) => {
		const findings = (c.findings ?? [])
			.map((f) => `    - ${f.address}: ${f.message}`)
			.join("\n");
		return `- ${c.id} (${c.title}) [${c.status}]\n${findings}`;
	});
	return [
		"You are an infrastructure security reviewer. For each verification control below,",
		"explain in one or two plain sentences WHY it failed and suggest a concrete remediation.",
		"Respond ONLY with a JSON array of objects {id, explanation, remediation}. No prose.",
		"",
		"Controls:",
		...lines,
	].join("\n");
}

/**
 * Parse the model's JSON response into per-control explanations, joined back to the
 * controls (so a malformed or partial response degrades to a safe generic message
 * rather than throwing — the model is advisory, never load-bearing).
 */
export function parseExplanations(
	raw: string,
	controls: ExplainableControl[],
): ControlExplanation[] {
	const byId = new Map<string, { explanation?: string; remediation?: string }>();
	try {
		// Tolerate code fences / surrounding text by extracting the first JSON array.
		const match = raw.match(/\[[\s\S]*\]/);
		const parsed: unknown = JSON.parse(match ? match[0] : raw);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				if (item && typeof item === "object" && "id" in item) {
					const o = asRecord(item);
					if (typeof o.id === "string") {
						byId.set(o.id, {
							explanation:
								typeof o.explanation === "string" ? o.explanation : undefined,
							remediation:
								typeof o.remediation === "string" ? o.remediation : undefined,
						});
					}
				}
			}
		}
	} catch {
		// fall through to generic messages
	}
	return controls.map((c) => ({
		id: c.id,
		title: c.title,
		explanation:
			byId.get(c.id)?.explanation ??
			`${c.title} did not pass; review the findings above.`,
		remediation:
			byId.get(c.id)?.remediation ??
			"Adjust the plan to satisfy this control, then re-run the gate.",
	}));
}

/**
 * Explain a gate report's failing controls via the injected model call — works for
 * either the verify or the compat report. Returns [] when nothing needs explaining.
 */
export async function explainFindings(
	report: ExplainableReport,
	generate: GenerateText,
): Promise<ControlExplanation[]> {
	const controls = explainableControls(report);
	if (controls.length === 0) return [];
	const raw = await generate(buildExplainPrompt(controls));
	return parseExplanations(raw, controls);
}
