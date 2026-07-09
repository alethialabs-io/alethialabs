// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { explainFindings } from "@/lib/ai/explain-findings";
import { authorize } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/**
 * Explain a job's failing verification controls in plain English (elench, A6§7).
 * The deterministic gate already decided pass/fail; this only adds advisory
 * explanation/remediation via the model — it is never the gate and writes nothing.
 * Returns [] when AI is unconfigured or there is nothing to explain. The
 * orchestration is unit-tested via lib/ai/explain-findings (injected model); this
 * wrapper supplies the real direct-to-provider call, mirroring the agent route.
 */
export async function explainJobFindings(jobId: string) {
	const actor = await authorize("view", { type: "job", id: jobId });
	if (!isAiConfigured()) return [];

	const report = await withOwnerScope(actor.userId, async (tx) => {
		const [job] = await tx
			.select({ md: jobs.execution_metadata })
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.limit(1);
		return job?.md?.verify_result ?? null;
	});
	if (!report) return [];

	// Budget-gate + meter the model call. This is an advisory feature, so an
	// over-budget org degrades to no explanation rather than an error.
	const charge = await assertAiAllowed(actor.orgId, "agent", actor.userId).catch((e: unknown) => {
		if (e instanceof AiBudgetError) return null;
		throw e;
	});
	if (!charge) return [];

	const resolved = getAiModel();
	let inputTokens = 0;
	let outputTokens = 0;
	let cachedInputTokens = 0;
	const explanations = await explainFindings(report, async (prompt) => {
		const { text, usage } = await generateText({ model: resolved.model, prompt });
		inputTokens += usage.inputTokens ?? 0;
		outputTokens += usage.outputTokens ?? 0;
		cachedInputTokens += usage.cachedInputTokens ?? 0;
		return text;
	});

	void recordAiUsage({
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "agent",
		// Metered → omit credits; settled from the explanation's real cost-of-serve.
		source: charge.source,
		refId: jobId,
		model: resolved.key,
		inputTokens,
		outputTokens,
		cachedInputTokens,
	});

	return explanations;
}
