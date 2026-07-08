"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { PanelRight, Telescope } from "lucide-react";
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
import { proposeOperationInputSchema } from "@/lib/ai/operation";
import type { Artifact, ArtifactTab } from "@/lib/stores/use-artifact-store";
import { Button } from "@repo/ui/button";

const projectIdSchema = z.object({ projectId: z.string() });
const jobIdSchema = z.object({ jobId: z.string() });
const scanResultSchema = z.object({ openInCanvasUrl: z.string().optional() });

interface OrgToolPartsDeps {
	/** Open the artifact panel (dashboard/config/plan/logs) for a project/job/spec. */
	openArtifact: (artifact: Artifact, tab: ArtifactTab) => void;
	/** Feed a HITL tool's outcome back to the model so it continues after approval. */
	addToolResult: AddToolResult;
}

/**
 * The org-agent tool-render lanes: `propose_operation` → approval card, repo scan →
 * "Open in canvas", project/job/plan results → "Open in panel" (artifact panel), and
 * polished tables/chips for list_* + catalog tools. Extracted from the agent page so
 * the shared Elench surface can select it by context.
 */
export function orgRenderToolPart({
	openArtifact,
	addToolResult,
}: OrgToolPartsDeps): RenderToolPart {
	// eslint-disable-next-line react/display-name
	return function renderOrgToolPart(part: ToolUIPart) {
		// HITL proposal (no execute): pending while its input streams, then the approval
		// card — which feeds the outcome back via addToolResult so the model continues.
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

		// Generative dashboard ready → an "Open dashboard" card opening the split pane.
		if (
			part.type === "tool-build_dashboard" &&
			part.state === "output-available"
		) {
			return (
				<DashboardReadyCard
					part={part}
					openArtifact={openArtifact}
					context="org"
				/>
			);
		}

		// Repo scan ready → an "Open in canvas" link to review the proposed project.
		if (
			part.type === "tool-get_scan_result" &&
			part.state === "output-available"
		) {
			const parsed = scanResultSchema.safeParse(part.output);
			if (parsed.success && parsed.data.openInCanvasUrl) {
				const url = parsed.data.openInCanvasUrl;
				return (
					<div className="flex flex-col gap-1.5">
						<AgentToolCard part={part} />
						<Button
							asChild
							variant="outline"
							size="sm"
							className="w-fit gap-1.5 rounded-none"
						>
							<Link href={url}>
								<Telescope className="h-3 w-3" />
								Open in canvas
							</Link>
						</Button>
					</div>
				);
			}
		}

		let onOpen: (() => void) | undefined;
		if (part.type === "tool-get_project") {
			const p = projectIdSchema.safeParse(part.input);
			if (p.success) {
				const id = p.data.projectId;
				onOpen = () => openArtifact({ projectId: id }, "config");
			}
		} else if (
			part.type === "tool-get_job" ||
			part.type === "tool-get_plan_result"
		) {
			const p = jobIdSchema.safeParse(part.input);
			if (p.success) {
				const id = p.data.jobId;
				const tab = part.type === "tool-get_plan_result" ? "plan" : "logs";
				onOpen = () => openArtifact({ jobId: id }, tab);
			}
		}
		if (onOpen) {
			return (
				<div className="flex flex-col gap-1.5">
					<AgentToolCard part={part} />
					<Button
						variant="outline"
						size="sm"
						className="w-fit gap-1.5 rounded-none"
						onClick={onOpen}
					>
						<PanelRight className="h-3 w-3" />
						Open in panel
					</Button>
				</div>
			);
		}

		// Polished tables/chips for list_* + catalog/CIDR tools; else default card.
		if (TOOL_VIEW_TYPES.has(part.type)) return <ToolView part={part} />;
		return undefined;
	};
}
