"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { Check, Telescope } from "lucide-react";
import Link from "next/link";
import { z } from "zod";
import { AgentToolCard } from "@/components/agent/agent-chat";
import type { RenderToolPart } from "@/components/agent/agent-chat";
import {
	TOOL_VIEW_TYPES,
	ToolView,
} from "@/components/agent/agent-tool-views";
import { ApprovalCard } from "@/components/agent/approval-card";
import { DashboardReadyCard } from "@/components/agent/render-tool-parts/dashboard-card";
import { ToolPending } from "@/components/agent/render-tool-parts/tool-pending";
import type { AddToolResult } from "@/components/agent/use-agent-chat";
import { VerifyBlock } from "@/components/agent/artifact-panel";
import { applyProposal } from "@/components/design-project/canvas/ai/apply-proposal";
import { proposeOperationInputSchema } from "@/lib/ai/operation";
import { proposeChangesInputSchema } from "@/lib/ai/proposal";
import type { Artifact, ArtifactTab } from "@/lib/stores/use-artifact-store";
import { Button } from "@repo/ui/button";

const scanResultSchema = z.object({ openInCanvasUrl: z.string().optional() });

const verifyStatus = z.enum(["pass", "fail", "warn", "not_evaluable"]);
/** Mirrors the VerifyReport JSON shape (jsonb.types) so a tool output parses without `as`. */
const verifyReportSchema = z.object({
	verdict: verifyStatus,
	catalog_version: z.string(),
	provider: z.string(),
	controls: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			severity: z.enum(["high", "medium", "low"]),
			status: verifyStatus,
			frameworks: z.array(z.string()).optional(),
			provider: z.string(),
			findings: z
				.array(z.object({ address: z.string(), message: z.string() }))
				.optional(),
			coverage: z.string().optional(),
		}),
	),
	summary: z.object({
		pass: z.number(),
		fail: z.number(),
		warn: z.number(),
		not_evaluable: z.number(),
	}),
});
const planResultSchema = z.object({
	verify_result: verifyReportSchema.nullish(),
});

interface ProjectToolPartsDeps {
	/** Accepted-proposal map (id → true) so re-renders keep the "Added" state. */
	accepted: Record<string, boolean>;
	setAccepted: (updater: (a: Record<string, boolean>) => Record<string, boolean>) => void;
	/** Feed a HITL tool's outcome back to the model so it continues after approval. */
	addToolResult: AddToolResult;
	/** Open the artifact panel (dashboard/config/plan/logs) — used by build_dashboard. */
	openArtifact: (artifact: Artifact, tab: ArtifactTab) => void;
}

/**
 * The project-assistant tool-render lanes: design proposal → Accept (applies to the
 * canvas), plan/deploy proposal → approval card, plan result → inline elench verdict
 * (VerifyBlock), repo scan → review link, and polished tables/chips for list_* tools.
 * Extracted from the docked assistant so the shared Elench surface selects it by context.
 */
export function projectRenderToolPart({
	accepted,
	setAccepted,
	addToolResult,
	openArtifact,
}: ProjectToolPartsDeps): RenderToolPart {
	// eslint-disable-next-line react/display-name
	return function renderProjectToolPart(part: ToolUIPart) {
		// Generative dashboard ready → an "Open dashboard" card opening the split pane.
		if (
			part.type === "tool-build_dashboard" &&
			part.state === "output-available"
		) {
			return (
				<DashboardReadyCard
					part={part}
					openArtifact={openArtifact}
					context="project"
				/>
			);
		}

		// Design proposal → accept lane (HITL: applies to the canvas, then feeds the
		// accepted outcome back so the model continues).
		if (part.type === "tool-propose_changes") {
			if (part.state === "input-streaming")
				return <ToolPending label="Preparing changes" />;
			const parsed = proposeChangesInputSchema.safeParse(part.input);
			if (!parsed.success) return null;
			const proposal = { id: part.toolCallId, ...parsed.data };
			const isAccepted = accepted[proposal.id];
			return (
				<div className="flex w-full items-center justify-between border border-border px-2.5 py-1.5">
					<span className="font-mono text-xs">{proposal.label}</span>
					{isAccepted ? (
						<span className="vx-status vx-status--active">
							<span className="vx-status__dot" />
							Added
						</span>
					) : (
						<Button
							type="button"
							size="sm"
							className="h-6 px-2 text-[11px]"
							onClick={() => {
								applyProposal(proposal);
								setAccepted((a) => ({ ...a, [proposal.id]: true }));
								addToolResult({
									tool: "propose_changes",
									toolCallId: part.toolCallId,
									output: { status: "accepted", label: proposal.label },
								});
							}}
						>
							<Check className="mr-1 h-3 w-3" />
							Accept
						</Button>
					)}
				</div>
			);
		}

		// Plan/deploy proposal → approval card (HITL: runs plan/deploy on the user's click,
		// then feeds the outcome back so the model continues).
		if (part.type === "tool-propose_operation") {
			if (part.state === "input-streaming")
				return <ToolPending label="Preparing operation" />;
			const parsed = proposeOperationInputSchema.safeParse(part.input);
			if (!parsed.success) return null;
			return (
				<ApprovalCard
					proposal={{ id: part.toolCallId, ...parsed.data }}
					onResolve={(output) =>
						addToolResult({
							tool: "propose_operation",
							toolCallId: part.toolCallId,
							output,
						})
					}
				/>
			);
		}

		// Plan result → render the elench verification verdict inline (the proof beat),
		// so the user sees pass/fail per control before approving a deploy.
		if (
			part.type === "tool-get_plan_result" &&
			part.state === "output-available"
		) {
			const parsed = planResultSchema.safeParse(part.output);
			if (parsed.success && parsed.data.verify_result) {
				return (
					<div className="flex flex-col gap-1.5">
						<AgentToolCard part={part} />
						<VerifyBlock report={parsed.data.verify_result} />
					</div>
				);
			}
		}

		// Repo scan ready → a link to review the proposed project in the design surface.
		if (
			part.type === "tool-get_scan_result" &&
			part.state === "output-available"
		) {
			const parsed = scanResultSchema.safeParse(part.output);
			if (parsed.success && parsed.data.openInCanvasUrl) {
				return (
					<div className="flex flex-col gap-1.5">
						<AgentToolCard part={part} />
						<Button
							asChild
							variant="outline"
							size="sm"
							className="w-fit gap-1.5 rounded-none"
						>
							<Link href={parsed.data.openInCanvasUrl}>
								<Telescope className="h-3 w-3" />
								Review proposed project
							</Link>
						</Button>
					</div>
				);
			}
		}

		// Polished tables/chips for list_* + catalog tools; else the default card.
		if (TOOL_VIEW_TYPES.has(part.type)) return <ToolView part={part} />;
		return undefined;
	};
}
