// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import { getScanProposal, scanRepo } from "@/app/server/actions/scanner";
import { compareProviders } from "@/lib/scanner/compare";

/**
 * Repo-analyzer tools — point the agent at a repo, infer its infrastructure, and
 * hand a guaranteed-valid proposed Spec to the canvas for review. scan_repo queues a
 * runner job (clone + static digest); the model never sees untrusted code, only the
 * structured digest. Every result is HITL — nothing provisions without the user.
 */
export function scannerTools() {
	return {
		scan_repo: tool({
			description:
				"Analyze a git repository to infer the infrastructure it needs. Queues a scan (the runner clones + statically parses it — no code is executed) and returns a jobId. Then poll get_scan_result. Accepts a public URL or a connected private repo.",
			inputSchema: z.object({
				repoUrl: z
					.string()
					.describe("Git repository URL, e.g. https://github.com/owner/name"),
			}),
			execute: async ({ repoUrl }) => {
				const { jobId } = await scanRepo(repoUrl);
				return {
					jobId,
					status: "queued",
					note: "Scanning — call get_scan_result(jobId) to check progress; logs stream in the panel.",
				};
			},
		}),

		get_scan_result: tool({
			description:
				"Get a repo scan's status and, when ready, the inferred stack + a summary of the proposed Spec. Tell the user to open it in the canvas to review/edit before deploying.",
			inputSchema: z.object({ jobId: z.string() }),
			execute: async ({ jobId }) => {
				const res = await getScanProposal(jobId);
				if (res.status !== "READY") return res;
				const { stack, proposedSpec, provider } = res.proposal;
				return {
					status: "ready",
					stack: {
						runtime: stack.runtime,
						framework: stack.framework,
						summary: stack.summary,
						scale: stack.scale,
						needs: stack.needs.map((n) => ({
							kind: n.kind,
							engine: n.engine,
							confidence: n.confidence,
							rationale: n.rationale,
						})),
					},
					proposed: {
						provider,
						region: proposedSpec.spec.region,
						project_name: proposedSpec.spec.project_name,
						databases: proposedSpec.databases.length,
						caches: proposedSpec.caches.length,
						queues: proposedSpec.queues.length,
						nosql: proposedSpec.nosql_tables.length,
						secrets: proposedSpec.secrets.length,
					},
					openInCanvasUrl: `/dashboard/design-spec?scan=${jobId}`,
				};
			},
		}),

		compare_providers: tool({
			description:
				"Compare the estimated monthly cost of a scanned stack across AWS, GCP, and Azure (cheapest first).",
			inputSchema: z.object({ jobId: z.string() }),
			execute: async ({ jobId }) => {
				const res = await getScanProposal(jobId);
				if (res.status !== "READY")
					return { error: "Scan not ready — analyze the repo first." };
				const costs = await compareProviders(res.proposal.stack);
				return {
					currency: "USD",
					costs: costs.map((c) => ({
						provider: c.provider,
						region: c.region,
						monthly: c.monthly,
					})),
				};
			},
		}),
	};
}
