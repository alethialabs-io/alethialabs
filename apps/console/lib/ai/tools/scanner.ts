// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import { queueAudit } from "@/app/server/actions/audit";
import { getScanProposal, scanRepo } from "@/app/server/actions/scanner";
import { compareProviders } from "@/lib/scanner/compare";

/**
 * Repo-analyzer tools — point the agent at a repo, infer its infrastructure, and
 * hand a guaranteed-valid proposed Project to the canvas for review. scan_repo queues a
 * runner job (clone + static digest); the model never sees untrusted code, only the
 * structured digest. Every result is HITL — nothing provisions without the user.
 */
export function scannerTools() {
	return {
		audit_infrastructure: tool({
			description:
				"Audit a customer's EXISTING infrastructure with elench (the 'bring your own IaC' flow): paste an OpenTofu/Terraform `show -json` plan or Kubernetes manifests. Queues an AUDIT job (provisions nothing) and returns a jobId — then poll get_plan_result(jobId), whose verify_result carries the signed report + per-control findings.",
			inputSchema: z.object({
				input: z
					.string()
					.describe("The OpenTofu/Terraform plan JSON, or Kubernetes manifests (YAML)."),
				kind: z
					.enum(["plan", "manifests"])
					.describe("Whether the input is a terraform 'plan' JSON or k8s 'manifests'."),
				projectId: z
					.string()
					.optional()
					.describe("Optional project to attach the audit to."),
			}),
			execute: async ({ input, kind, projectId }) => {
				const { jobId } = await queueAudit(input, kind, projectId);
				return {
					jobId,
					status: "queued",
					note: "Auditing — call get_plan_result(jobId); its verify_result holds the verdict + findings.",
				};
			},
		}),
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
				"Get a repo scan's status and, when ready, the inferred stack + a summary of the proposed Project. Tell the user to open it in the canvas to review/edit before deploying.",
			inputSchema: z.object({ jobId: z.string() }),
			execute: async ({ jobId }) => {
				const res = await getScanProposal(jobId);
				if (res.status !== "READY") return res;
				const { stack, proposedProject, provider } = res.proposal;
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
						region: proposedProject.project.region,
						project_name: proposedProject.project.project_name,
						databases: proposedProject.databases.length,
						caches: proposedProject.caches.length,
						queues: proposedProject.queues.length,
						nosql: proposedProject.nosql_tables.length,
						secrets: proposedProject.secrets.length,
					},
					openInCanvasUrl: `/dashboard/new?scan=${jobId}`,
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
