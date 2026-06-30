"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ToolUIPart, UIMessage } from "ai";
import { PanelRight, Telescope } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	createThread,
	deleteThread,
	getThread,
	listThreads,
	renameThread,
} from "@/app/server/actions/agent";
import { AgentChat, AgentToolCard } from "@/components/agent/agent-chat";
import {
	TOOL_VIEW_TYPES,
	ToolView,
} from "@/components/agent/agent-tool-views";
import { ApprovalCard } from "@/components/agent/approval-card";
import { ArtifactPanel } from "@/components/agent/artifact-panel";
import { ChatTopBar } from "@/components/agent/chat-top-bar";
import { ThreadRail } from "@/components/agent/thread-rail";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import { Button } from "@repo/ui/button";
import { operationProposalSchema } from "@/lib/ai/operation";
import type { AgentMode } from "@/lib/ai/tools";
import { AI_MODELS } from "@/lib/config/ai";
import type { AgentThread } from "@/lib/db/schema";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";

const SUGGESTIONS = [
	"Are my connectors healthy?",
	"What clusters are running?",
	"Design an EKS cluster + RDS for ~511 hosts",
	"Show my recent provisioning jobs",
];

const projectIdSchema = z.object({ projectId: z.string() });
const jobIdSchema = z.object({ jobId: z.string() });
const scanResultSchema = z.object({ openInCanvasUrl: z.string().optional() });

interface ActiveThread {
	id: string;
	messages: UIMessage[];
}

/**
 * The Agent page — `[thread rail | chat]`. Threads persist (DB); selecting one
 * resumes its transcript. The artifact panel + approvals land in later phases.
 * Breaks out of the layout's padded ScrollArea via negative margins.
 */
export default function AgentPage() {
	const [threads, setThreads] = useState<AgentThread[]>([]);
	const [active, setActive] = useState<ActiveThread | null>(null);
	const [mode, setMode] = useState<AgentMode>("ask");
	const [model, setModel] = useState(AI_MODELS[0].id);
	// A prompt handed off from the create-project hero (`?prompt=`) — auto-sent into the
	// freshest thread once, then stripped from the URL so a refresh doesn't resend it.
	const [seedPrompt, setSeedPrompt] = useState<string | null>(null);

	useEffect(() => {
		const p = new URLSearchParams(window.location.search).get("prompt");
		if (p) {
			setSeedPrompt(p);
			window.history.replaceState(null, "", window.location.pathname);
		}
	}, []);

	const selectThread = useCallback(async (id: string) => {
		const full = await getThread(id);
		if (full) setActive({ id: full.id, messages: full.messages });
	}, []);

	const newChat = useCallback(async () => {
		const t = await createThread();
		setThreads((prev) => [t, ...prev]);
		setActive({ id: t.id, messages: [] });
	}, []);

	// Initial load: list threads, then resume the most recent (or start a fresh one).
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const list = await listThreads();
			if (cancelled) return;
			setThreads(list);
			if (list.length > 0) {
				const full = await getThread(list[0].id);
				if (!cancelled && full)
					setActive({ id: full.id, messages: full.messages });
			} else {
				const t = await createThread();
				if (cancelled) return;
				setThreads([t]);
				setActive({ id: t.id, messages: [] });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const removeThread = useCallback(
		async (id: string) => {
			await deleteThread(id);
			const remaining = threads.filter((t) => t.id !== id);
			setThreads(remaining);
			if (active?.id === id) {
				if (remaining.length > 0) await selectThread(remaining[0].id);
				else await newChat();
			}
		},
		[threads, active, selectThread, newChat],
	);

	// First user message names a fresh thread (optimistic + persisted).
	const handleFirstMessage = useCallback((id: string, text: string) => {
		const title = text.trim().slice(0, 60) || "New chat";
		setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
		void renameThread(id, title);
	}, []);

	return (
		<div className="-m-4 flex h-[calc(100dvh-3.5rem)] sm:-m-6 lg:-m-8 xl:-m-10">
			<ThreadRail
				threads={threads}
				activeId={active?.id ?? null}
				onSelect={selectThread}
				onNew={newChat}
				onDelete={removeThread}
			/>

			<section className="flex min-w-0 flex-1 flex-col">
				<ChatTopBar
					title={threads.find((t) => t.id === active?.id)?.title ?? "Agent"}
					mode={mode}
					onModeChange={setMode}
					model={model}
					onModelChange={setModel}
				/>

				{active ? (
					<AgentChatPane
						key={active.id}
						threadId={active.id}
						initialMessages={active.messages}
						onFirstMessage={handleFirstMessage}
						initialPrompt={seedPrompt}
						mode={mode}
						model={model}
					/>
				) : (
					<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
						Loading…
					</div>
				)}
			</section>

			<ArtifactPanel />
		</div>
	);
}

/**
 * One thread's chat, keyed by thread id so it remounts cleanly on switch (fresh
 * initial transcript). Sends `threadId` so the route persists on finish.
 */
function AgentChatPane({
	threadId,
	initialMessages,
	onFirstMessage,
	initialPrompt,
	mode,
	model,
}: {
	threadId: string;
	initialMessages: UIMessage[];
	onFirstMessage: (id: string, text: string) => void;
	/** Prompt handed off from the create-project hero; auto-sent once into an empty thread. */
	initialPrompt?: string | null;
	mode: AgentMode;
	model: string;
}) {
	const prepareBody = useCallback(
		() => ({ threadId, mode, model }),
		[threadId, mode, model],
	);
	const openArtifact = useArtifactStore((s) => s.open);
	const { messages, sendMessage, status, error } = useAgentChat({
		api: "/api/agent",
		id: threadId,
		initialMessages,
		prepareBody,
	});

	// Auto-send the create-project hero prompt once, into an otherwise-empty thread.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current || !initialPrompt || messages.length > 0) return;
		seededRef.current = true;
		onFirstMessage(threadId, initialPrompt);
		sendMessage({ text: initialPrompt });
	}, [initialPrompt, messages.length, threadId, onFirstMessage, sendMessage]);

	// propose_operation → approval card; project/job results → Open-in-panel; else default.
	const renderToolPart = useCallback(
		(part: ToolUIPart) => {
			if (part.type === "tool-propose_operation") {
				if (part.state !== "output-available") return null;
				const parsed = operationProposalSchema.safeParse(part.output);
				if (!parsed.success) return null;
				return <ApprovalCard proposal={parsed.data} />;
			}

			// Repo scan ready → an "Open in canvas" link to review the proposed project.
			if (part.type === "tool-get_scan_result" && part.state === "output-available") {
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
		},
		[openArtifact],
	);

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
			<AgentChat
				messages={messages}
				status={status}
				error={error}
				onSend={(t) => {
					if (messages.length === 0) onFirstMessage(threadId, t);
					sendMessage({ text: t });
				}}
				suggestions={SUGGESTIONS}
				renderToolPart={renderToolPart}
			/>
		</div>
	);
}
