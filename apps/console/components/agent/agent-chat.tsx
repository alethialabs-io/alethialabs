"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { Loader2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import {
	Conversation,
	ConversationContent,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { cn } from "@repo/ui/utils";

export type AgentChatStatus = "submitted" | "streaming" | "ready" | "error";

/** The default collapsible tool-call card (AI Elements `<Tool>`). Exported so surfaces
 * can compose it — e.g. wrap it with an "Open in panel" action — without duplicating it. */
export function AgentToolCard({ part }: { part: ToolUIPart }) {
	return (
		<Tool>
			<ToolHeader type={part.type} state={part.state} />
			<ToolContent>
				{(part.state === "input-available" ||
					part.state === "output-available") && <ToolInput input={part.input} />}
				<ToolOutput output={part.output} errorText={part.errorText} />
			</ToolContent>
		</Tool>
	);
}

export interface AgentToolRenderContext {
	messageId: string;
	index: number;
}

/**
 * Render a tool part. Return `undefined` to fall back to the default `<Tool>`
 * card; return `null` to render nothing; return a node to render it. Lets each
 * surface own its proposal/approval lanes while sharing the transcript.
 */
export type RenderToolPart = (
	part: ToolUIPart,
	ctx: AgentToolRenderContext,
) => ReactNode | undefined;

export interface AgentChatProps {
	messages: UIMessage[];
	status: AgentChatStatus;
	error?: Error;
	onSend: (text: string) => void;
	suggestions?: string[];
	placeholder?: string;
	emptyState?: ReactNode;
	renderToolPart?: RenderToolPart;
	/** Shown when `error` is set (defaults to a generic unavailable message). */
	errorMessage?: ReactNode;
	className?: string;
}

/**
 * Surface-agnostic chat transcript + composer, built on the AI Elements
 * primitives (grayscale/squared). Consumed by the Agent page and the canvas
 * Ask AI sheet — each passes its own transport (via `useAgentChat`) and an
 * optional `renderToolPart` for proposal/approval lanes.
 */
export function AgentChat({
	messages,
	status,
	error,
	onSend,
	suggestions,
	placeholder = "Ask the agent, or describe what to build…",
	emptyState,
	renderToolPart,
	errorMessage,
	className,
}: AgentChatProps) {
	const pending = status === "submitted" || status === "streaming";
	const lastMessageId = messages.at(-1)?.id;

	const submit = (text: string) => {
		const t = text.trim();
		if (!t || pending) return;
		onSend(t);
	};

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<Conversation className="flex-1">
				<ConversationContent>
					{messages.length === 0 &&
						(emptyState ??
							(suggestions && suggestions.length > 0 ? (
								<div className="space-y-3">
									<p className="text-sm text-muted-foreground">
										Try one of these:
									</p>
									<Suggestions>
										{suggestions.map((s) => (
											<Suggestion key={s} suggestion={s} onClick={submit} />
										))}
									</Suggestions>
								</div>
							) : null))}

					{messages.map((m) => (
						<Message key={m.id} from={m.role}>
							<MessageContent>
								{m.parts.map((part, i) => {
									const key = `${m.id}-${i}`;

									if (part.type === "text" && part.text) {
										return m.role === "assistant" ? (
											<MessageResponse key={key}>{part.text}</MessageResponse>
										) : (
											<span key={key}>{part.text}</span>
										);
									}

									if (isToolUIPart(part)) {
										if (part.type === "dynamic-tool") return null;

										const custom = renderToolPart?.(part, {
											messageId: m.id,
											index: i,
										});
										if (custom !== undefined)
											return <Fragment key={key}>{custom}</Fragment>;

										return <AgentToolCard key={key} part={part} />;
									}

									return null;
								})}
								{m.role === "assistant" &&
									m.id === lastMessageId &&
									status === "streaming" && (
										<span
											aria-hidden
											className="ml-0.5 inline-block h-3.5 w-[7px] animate-pulse bg-foreground align-text-bottom"
										/>
									)}
							</MessageContent>
						</Message>
					))}

					{status === "submitted" && (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="h-3 w-3 animate-spin" />
							Thinking…
						</div>
					)}
					{error && (
						<div className="border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
							{errorMessage ??
								"The assistant is unavailable. Confirm AI is configured (AI_GATEWAY_API_KEY) and try again."}
						</div>
					)}
				</ConversationContent>
			</Conversation>

			<div className="border-t border-border p-3">
				<PromptInput
					className="rounded-none"
					onSubmit={(message) => {
						if (message.text) submit(message.text);
					}}
				>
					<PromptInputBody>
						<PromptInputTextarea placeholder={placeholder} />
					</PromptInputBody>
					<PromptInputFooter className="justify-end">
						<PromptInputSubmit status={status} disabled={pending} />
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	);
}
