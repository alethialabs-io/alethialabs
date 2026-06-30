// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use server";

import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { explainFindings } from "@/lib/ai/explain-findings";
import { authorize } from "@/lib/authz/guard";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";
import { withOwnerScope } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/**
 * Explain a job's failing verification controls in plain English (elench, A6§7).
 * The deterministic gate already decided pass/fail; this only adds advisory
 * explanation/remediation via the model — it is never the gate and writes nothing.
 * Returns [] when AI is unconfigured or there is nothing to explain. The
 * orchestration is unit-tested via lib/ai/explain-findings (injected model); this
 * wrapper supplies the real AI-gateway call, mirroring the agent route.
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

	return explainFindings(report, async (prompt) => {
		const { text } = await generateText({ model: getAiModel(), prompt });
		return text;
	});
}
