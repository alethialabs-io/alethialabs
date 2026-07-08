"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentChat } from "@/components/agent/agent-chat";
import { orgRenderToolPart } from "@/components/agent/render-tool-parts/org-tool-parts";
import { projectRenderToolPart } from "@/components/agent/render-tool-parts/project-tool-parts";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import { snapshotCanvas } from "@/components/project-assistant/use-project-assistant";
import type { Mention } from "@/lib/ai/mentions";
import type { AgentThread } from "@/lib/db/schema";
import {
	type ArtifactTab,
	useArtifactStore,
} from "@/lib/stores/use-artifact-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { ElenchComposer } from "./elench-composer";
import {
	ElenchModalLanding,
	ElenchPanelEmpty,
} from "./elench-empty-landing";
import { ElenchModal } from "./elench-modal";
import { ElenchPanel } from "./elench-panel";
import {
	ORG_SUGGESTIONS,
	PROJECT_SUGGESTIONS,
} from "./elench-suggestions";

/** External help destination for the Support affordances. */
export const ELENCH_SUPPORT_HREF = "https://alethialabs.io/contact";

const PLACEHOLDER = "Ask Elench, or type @ to tag a resource";

export interface ElenchThreadApi {
	threads: AgentThread[];
	activeId: string | null;
	initialMessages: UIMessage[];
	selectThread: (id: string) => void;
	newChat: () => void;
	deleteThread: (id: string) => void;
	handleFirstMessage: (id: string, text: string) => void;
}

/**
 * The single Elench conversation. Owns exactly one `useAgentChat` instance and picks
 * its transport, tools, and tool-render lanes from the store's context (org vs
 * project). The modal/panel chrome is branched INTERNALLY, so flipping the view
 * (minimize/maximize) re-renders the wrapper without remounting the chat — the
 * transcript survives intact. Keyed by the conversation lineage upstream.
 */
export function ElenchConversation({
	threads,
	activeId,
	initialMessages,
	selectThread,
	newChat,
	deleteThread,
	handleFirstMessage,
}: ElenchThreadApi) {
	const ctx = useElenchStore((s) => s.ctx);
	const view = useElenchStore((s) => s.view);
	const seedPrompt = useElenchStore((s) => s.seedPrompt);
	const setSeedPrompt = useElenchStore((s) => s.setSeedPrompt);
	const isOrg = ctx.kind === "org";

	// Transport by context. `api` + `prepareBody` are referentially stable within a
	// mount (the conversation is keyed by ctx/thread upstream, so it remounts cleanly
	// when either changes). prepareBody reads the store FRESH at send time.
	const api = isOrg
		? "/api/agent"
		: `/api/projects/${ctx.kind === "project" ? ctx.projectId : ""}/assistant`;
	const projectId = ctx.kind === "project" ? ctx.projectId : "";
	const prepareBody = useMemo(
		() =>
			isOrg
				? () => {
						const s = useElenchStore.getState();
						return {
							threadId: s.threadId,
							mode: s.mode,
							model: s.model,
							mentions: s.pendingMentions,
						};
					}
				: () => ({
						projectId,
						threadId: useElenchStore.getState().threadId,
						canvas: snapshotCanvas(),
						mentions: useElenchStore.getState().pendingMentions,
					}),
		[isOrg, projectId],
	);

	const { messages, sendMessage, status, error, regenerate, stop, resumeStream } =
		useAgentChat({
			api,
			id: activeId ?? undefined,
			initialMessages,
			prepareBody,
		});

	// Resume an interrupted stream after a reload: if the resumed transcript ends on a
	// user turn, the assistant reply never landed — try to reconnect once. Guarded so a
	// settled thread (last message is the assistant's) never fires a needless request.
	const resumedRef = useRef(false);
	useEffect(() => {
		if (resumedRef.current) return;
		resumedRef.current = true;
		if (initialMessages.at(-1)?.role === "user") void resumeStream();
	}, [initialMessages, resumeStream]);

	const setPendingMentions = useElenchStore((s) => s.setPendingMentions);

	const onSend = useCallback(
		(text: string, mentions: Mention[] = []) => {
			// Stage the @-referenced resources so prepareBody sends them with the request.
			setPendingMentions(mentions);
			// Name a fresh thread from its first message (both contexts now persist).
			if (messages.length === 0 && activeId) handleFirstMessage(activeId, text);
			sendMessage({ text });
		},
		[messages.length, activeId, handleFirstMessage, sendMessage, setPendingMentions],
	);

	// Auto-send a staged seed prompt once into an otherwise-empty conversation.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current || !seedPrompt || messages.length > 0) return;
		seededRef.current = true;
		onSend(seedPrompt);
		setSeedPrompt(null);
	}, [seedPrompt, messages.length, onSend, setSeedPrompt]);

	// Tool-render lanes by context. Org routes artifacts through the panel; if the
	// artifact opens while docked (panel view), maximize to the modal first (the
	// artifact panel needs the modal's room).
	const artifactOpen = useArtifactStore((s) => s.open);
	const openArtifact = useCallback(
		(artifact: { projectId?: string; jobId?: string }, tab: ArtifactTab) => {
			if (useElenchStore.getState().view === "panel")
				useElenchStore.getState().maximize();
			artifactOpen(artifact, tab);
		},
		[artifactOpen],
	);
	const [accepted, setAccepted] = useState<Record<string, boolean>>({});
	const renderToolPart = useMemo(
		() =>
			isOrg
				? orgRenderToolPart({ openArtifact })
				: projectRenderToolPart({ accepted, setAccepted }),
		[isOrg, openArtifact, accepted],
	);

	const isEmpty = messages.length === 0;
	const suggestions = isOrg ? ORG_SUGGESTIONS : PROJECT_SUGGESTIONS;
	// The centered title in the modal's active-conversation top bar.
	const convoTitle = isOrg
		? (threads.find((t) => t.id === activeId)?.title ?? "New chat")
		: "Assistant";

	// The chat body: the modal empty landing owns its own composer; every other state
	// uses the shared transcript + docked composer (with the Ask-mode pill).
	const body =
		view === "modal" && isEmpty ? (
			<ElenchModalLanding
				onSend={onSend}
				suggestions={suggestions}
				recents={threads}
				onOpenThread={selectThread}
				showModel={isOrg}
				onPanelRight={() => useElenchStore.getState().minimize()}
				status={status}
			/>
		) : (
			<AgentChat
				messages={messages}
				status={status}
				error={error}
				onSend={onSend}
				onRetry={() => void regenerate()}
				onStop={() => void stop()}
				renderToolPart={renderToolPart}
				placeholder={PLACEHOLDER}
				className={
					view === "modal" ? "mx-auto w-full max-w-[720px]" : undefined
				}
				composerClassName={
					view === "modal" ? "border-t-0 px-6 pb-6 pt-2" : undefined
				}
				renderComposer={
					<ElenchComposer
						onSend={onSend}
						onStop={() => void stop()}
						showModel={isOrg}
						status={status}
					/>
				}
				onFeedback={() => {}}
				supportHref={ELENCH_SUPPORT_HREF}
				emptyState={
					view === "panel" && isEmpty ? (
						<ElenchPanelEmpty
							onSend={onSend}
							suggestions={suggestions}
							supportHref={ELENCH_SUPPORT_HREF}
						/>
					) : undefined
				}
			/>
		);

	if (view === "modal") {
		return (
			<ElenchModal
				isOrg={isOrg}
				threads={threads}
				activeId={activeId}
				isEmpty={isEmpty}
				title={convoTitle}
				onSelectThread={selectThread}
				onNewChat={newChat}
				onDeleteThread={deleteThread}
			>
				{body}
			</ElenchModal>
		);
	}

	return (
		<ElenchPanel
			isOrg={isOrg}
			threads={threads}
			activeId={activeId}
			onSelectThread={selectThread}
			onNewChat={newChat}
		>
			{body}
		</ElenchPanel>
	);
}
