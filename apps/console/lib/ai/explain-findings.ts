// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { VerifyControlResult, VerifyReport } from "@/types/jsonb.types";

/**
 * The "LLM = explanation" half of the elench AI-audit division of labor (A6§7): the
 * deterministic gate decides pass/fail; the model only EXPLAINS a failing control
 * and suggests a fix in plain English. It is never the gate and has no write path —
 * any proposed fix is separately re-validated by `verify.ReVerify` before it could
 * ever be offered. The model call is injected so this orchestration is unit-tested
 * without a live model; the server action supplies the real AI-gateway call.
 */

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
export function explainableControls(report: VerifyReport): VerifyControlResult[] {
	return report.controls.filter(
		(c) => c.status === "fail" || c.status === "warn",
	);
}

/** Build the explanation prompt for a set of failing controls. */
export function buildExplainPrompt(controls: VerifyControlResult[]): string {
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
	controls: VerifyControlResult[],
): ControlExplanation[] {
	const byId = new Map<string, { explanation?: string; remediation?: string }>();
	try {
		// Tolerate code fences / surrounding text by extracting the first JSON array.
		const match = raw.match(/\[[\s\S]*\]/);
		const parsed: unknown = JSON.parse(match ? match[0] : raw);
		if (Array.isArray(parsed)) {
			for (const item of parsed) {
				if (item && typeof item === "object" && "id" in item) {
					const o = item as Record<string, unknown>;
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
 * Explain a verification report's failing controls via the injected model call.
 * Returns [] when nothing needs explaining.
 */
export async function explainFindings(
	report: VerifyReport,
	generate: GenerateText,
): Promise<ControlExplanation[]> {
	const controls = explainableControls(report);
	if (controls.length === 0) return [];
	const raw = await generate(buildExplainPrompt(controls));
	return parseExplanations(raw, controls);
}
