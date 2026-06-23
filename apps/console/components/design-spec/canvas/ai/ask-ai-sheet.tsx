"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart } from "ai";
import { Check, Sparkles } from "lucide-react";
import { useState } from "react";
import { AgentChat } from "@/components/agent/agent-chat";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { aiProposalSchema } from "@/lib/ai/proposal";
import { applyProposal } from "./apply-proposal";
import { useAskAi } from "./use-ask-ai";

const SUGGESTIONS = [
	"Add a Postgres database",
	"Add a Redis cache",
	"Put DNS on Cloudflare",
	"Estimate the monthly cost",
];

interface AskAiSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Canvas Ask AI — the shared `<AgentChat>` inside a Sheet, with a canvas-specific
 * `renderToolPart` that turns `propose_changes` into an accept lane (→ applyProposal).
 */
export function AskAiSheet({ open, onOpenChange }: AskAiSheetProps) {
	const { messages, sendMessage, status, error } = useAskAi();
	const [accepted, setAccepted] = useState<Record<string, boolean>>({});

	/** propose_changes → grayscale accept lane; other tools fall back to the default card. */
	const renderToolPart = (part: ToolUIPart) => {
		if (part.type !== "tool-propose_changes") return undefined;
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
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-[440px] flex-col gap-0 p-0 sm:max-w-[440px]"
			>
				<SheetHeader className="border-b border-border">
					<span className="vx-eyebrow flex items-center gap-1.5">
						<Sparkles className="h-3 w-3" />
						Assistant
					</span>
					<SheetTitle className="text-base">Ask AI</SheetTitle>
					<SheetDescription className="text-xs">
						Describe the infrastructure you want; accept suggestions to drop them
						on the canvas.
					</SheetDescription>
				</SheetHeader>

				<AgentChat
					messages={messages}
					status={status}
					error={error}
					onSend={(t) => sendMessage({ text: t })}
					suggestions={SUGGESTIONS}
					placeholder="Describe what to add…"
					renderToolPart={renderToolPart}
				/>
			</SheetContent>
		</Sheet>
	);
}
