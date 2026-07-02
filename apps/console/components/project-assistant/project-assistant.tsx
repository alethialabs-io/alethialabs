"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { Check, Sparkles, Telescope, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { AgentChat, AgentToolCard } from "@/components/agent/agent-chat";
import { TOOL_VIEW_TYPES, ToolView } from "@/components/agent/agent-tool-views";
import { ApprovalCard } from "@/components/agent/approval-card";
import { VerifyBlock } from "@/components/agent/artifact-panel";
import { applyProposal } from "@/components/design-project/canvas/ai/apply-proposal";
import { aiProposalSchema } from "@/lib/ai/proposal";
import { operationProposalSchema } from "@/lib/ai/operation";
import { useAssistantStore } from "@/lib/stores/use-assistant-store";
import { Button } from "@repo/ui/button";
import { useProjectAssistant } from "./use-project-assistant";

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

const SUGGESTIONS = [
	"Scan my repo: https://github.com/…",
	"Add a Postgres database",
	"Plan this project and show me the verification",
	"What clusters are running?",
];

/**
 * The project-page assistant — the agent body of the canvas's inline docked side panel. Drives
 * the MVP loop for THIS project: scan repos → propose infra, edit the design (propose_changes →
 * canvas), and propose plan/deploy (ApprovalCard) with the elench verdict. Reuses the shared
 * `<AgentChat>` + the canvas/agent proposal renderers. Stays mounted so chat state survives the
 * panel closing/switching to the inspector.
 */
export function AssistantPanel({ projectId }: { projectId: string }) {
	const setOpen = useAssistantStore((s) => s.setOpen);
	const { messages, sendMessage, status, error, regenerate } =
		useProjectAssistant(projectId);
	const [accepted, setAccepted] = useState<Record<string, boolean>>({});

	const renderToolPart = (part: ToolUIPart) => {
		// Design proposal → accept lane (applies to the canvas).
		if (part.type === "tool-propose_changes") {
			if (part.state !== "output-available") return null;
			const parsed = aiProposalSchema.safeParse(part.output);
			if (!parsed.success) return null;
			const proposal = parsed.data;
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
							}}
						>
							<Check className="mr-1 h-3 w-3" />
							Accept
						</Button>
					)}
				</div>
			);
		}

		// Plan/deploy proposal → approval card (runs plan/deploy on the user's click).
		if (part.type === "tool-propose_operation") {
			if (part.state !== "output-available") return null;
			const parsed = operationProposalSchema.safeParse(part.output);
			if (!parsed.success) return null;
			return <ApprovalCard proposal={parsed.data} />;
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

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-start justify-between gap-2 border-b border-border p-4">
				<div className="min-w-0">
					<span className="vx-eyebrow flex items-center gap-1.5">
						<Sparkles className="h-3 w-3" />
						Project assistant
					</span>
					<h2 className="mt-1 text-base font-semibold">
						Build & operate this project
					</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Scan a repo to infer infrastructure, edit the design, and
						plan/deploy with verification — you approve every change.
					</p>
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-7 w-7 shrink-0"
					onClick={() => setOpen(false)}
					aria-label="Close assistant"
				>
					<X className="h-4 w-4" />
				</Button>
			</div>

			<div className="flex min-h-0 flex-1 flex-col">
				<AgentChat
					messages={messages}
					status={status}
					error={error}
					onSend={(t) => sendMessage({ text: t })}
					onRetry={() => void regenerate()}
					suggestions={SUGGESTIONS}
					placeholder="Scan a repo, edit the design, or ask about this project…"
					renderToolPart={renderToolPart}
				/>
			</div>
		</div>
	);
}
