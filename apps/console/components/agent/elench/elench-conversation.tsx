"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentArtifactGallery } from "@/components/agent/agent-artifact-gallery";
import { AgentKnowledgePanel } from "@/components/agent/agent-knowledge-panel";
import { AgentChat } from "@/components/agent/agent-chat";
import { ChatSkeleton } from "@/components/agent/chat-skeleton";
import { openArtifactOnGrid } from "@/app/server/actions/artifacts";
import { orgRenderToolPart } from "@/components/agent/render-tool-parts/org-tool-parts";
import { projectRenderToolPart } from "@/components/agent/render-tool-parts/project-tool-parts";
import { useAgentChat } from "@/components/agent/use-agent-chat";
import { snapshotCanvas } from "@/components/project-assistant/use-project-assistant";
import { track } from "@/lib/analytics/track";
import type { Mention } from "@/lib/ai/mentions";
import type { AgentThread } from "@/lib/db/schema";
import {
	type Artifact,
	type ArtifactTab,
	useArtifactStore,
} from "@/lib/stores/use-artifact-store";
import { useWidgetAutoPin } from "@/components/agent/widgets/use-widget-auto-pin";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import { elenchChatId, useElenchStore } from "@/lib/stores/use-elench-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref } from "@/lib/routing";
import { ElenchComposer } from "./elench-composer";
import {
	ElenchModalLanding,
	ElenchPanelEmpty,
} from "./elench-empty-landing";
import { ElenchErrorBoundary } from "./elench-error-boundary";
import { ElenchModal } from "./elench-modal";
import { ElenchPanel } from "./elench-panel";
import {
	ORG_SUGGESTIONS,
	PROJECT_SUGGESTIONS,
} from "./elench-suggestions";

/** Read the staged empty-cell target and clear it — a cell request must ride exactly the
 * one request it was typed for, and never leak into the next message. */
function takePendingCellTarget(): { x: number; y: number } | null {
	const grid = useWidgetGridStore.getState();
	const target = grid.pendingCellTarget;
	if (target) grid.setPendingCellTarget(null);
	return target;
}

const PLACEHOLDER = "Ask Elench, or type @ to tag a resource";

export interface ElenchThreadApi {
	/** False until the initial thread list resolves — the body shows a skeleton meanwhile. */
	ready: boolean;
	threads: AgentThread[];
	activeId: string | null;
	initialMessages: UIMessage[];
	selectThread: (id: string) => void;
	newChat: () => void;
	/** Lazily persist the ephemeral conversation on its first send; returns the new thread. */
	startThread: (firstMessage: string) => Promise<AgentThread>;
	deleteThread: (id: string) => void;
}

/**
 * The single Elench conversation. Owns exactly one `useAgentChat` instance — keyed by the
 * ctx+epoch chat lineage token, so a "New chat" / resume recreates the underlying chat
 * (fresh or resumed transcript) WITHOUT remounting this component or its chrome. The
 * modal/panel chrome is branched INTERNALLY and stays mounted across a view flip, the
 * ready gate, and a new chat — so the panel's open animation runs once, the rail never
 * flashes, and minimize/maximize preserves the transcript. Mounted once per open.
 */
export function ElenchConversation({
	ready,
	threads,
	activeId,
	initialMessages,
	selectThread,
	newChat,
	startThread,
	deleteThread,
}: ElenchThreadApi) {
	const ctx = useElenchStore((s) => s.ctx);
	const view = useElenchStore((s) => s.view);
	const epoch = useElenchStore((s) => s.epoch);
	const close = useElenchStore((s) => s.close);
	const seedPrompt = useElenchStore((s) => s.seedPrompt);
	const setSeedPrompt = useElenchStore((s) => s.setSeedPrompt);
	const isOrg = ctx.kind === "org";

	// In-app support hub (`/{org}/~/support`), not the marketing contact page. Undefined until
	// the active org slug resolves, which hides the Support affordance rather than linking to
	// a malformed `//~/support`.
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const supportHref = orgSlug ? globalHref(orgSlug, "support") : undefined;

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
							deepReasoning: s.deepReasoning,
							// Consumed HERE, as the request body is built: clearing it after
							// `onSend` returned raced the transport and the coordinates were
							// gone by the time this ran, so the widget landed at (0,0).
							cellTarget: takePendingCellTarget(),
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

	// The chat lineage token (ctx + epoch) is the `useChat` id: it changes on new-chat /
	// resume (recreating the chat with fresh/loaded messages) but NOT on a lazy thread-attach
	// or a view flip — so an in-flight send and the transcript survive both.
	const chatId = elenchChatId(ctx, epoch);
	const {
		messages,
		sendMessage,
		status,
		error,
		regenerate,
		stop,
		resumeStream,
		addToolResult,
	} = useAgentChat({
		api,
		id: chatId,
		initialMessages,
		prepareBody,
	});

	// Resume an interrupted stream after a reload: if the resumed transcript ends on a
	// user turn, the assistant reply never landed — try to reconnect once per lineage.
	// Guarded so a settled thread (last message is the assistant's) never fires a needless
	// request. Re-armed per epoch since this component is not remounted between threads.
	const resumedEpoch = useRef<number | null>(null);
	useEffect(() => {
		if (resumedEpoch.current === epoch) return;
		resumedEpoch.current = epoch;
		if (initialMessages.at(-1)?.role === "user") void resumeStream();
	}, [epoch, initialMessages, resumeStream]);

	// The per-chat widget grid: hydrate it for the active thread and auto-pin matching
	// tool results (registry reads + exploded build_dashboard blocks + pin_widget).
	const hydrateGrid = useWidgetGridStore((s) => s.hydrate);
	const resetGrid = useWidgetGridStore((s) => s.reset);
	useEffect(() => {
		if (activeId) void hydrateGrid(activeId);
		else resetGrid();
	}, [activeId, hydrateGrid, resetGrid]);
	useWidgetAutoPin(messages, activeId);

	const setPendingMentions = useElenchStore((s) => s.setPendingMentions);

	const onSend = useCallback(
		async (text: string, mentions: Mention[] = []) => {
			// Stage the @-referenced resources so prepareBody sends them with the request.
			setPendingMentions(mentions);
			// First send of an ephemeral conversation: lazily create+attach the thread so its
			// id (title derived from `text`) rides this request — prepareBody reads it fresh at
			// send time, and the route's onFinish persists the transcript to it.
			if (messages.length === 0 && activeId == null) {
				await startThread(text);
			}
			track("elench_message_sent", {
				context: isOrg ? "org" : "project",
				model: useElenchStore.getState().model,
				project: projectId || undefined,
			});
			sendMessage({ text });
		},
		[messages.length, activeId, startThread, sendMessage, setPendingMentions, isOrg, projectId],
	);

	// Auto-send a staged seed prompt once into an otherwise-empty conversation.
	const seededRef = useRef(false);
	useEffect(() => {
		if (seededRef.current || !seedPrompt || messages.length > 0) return;
		seededRef.current = true;
		onSend(seedPrompt);
		setSeedPrompt(null);
	}, [seedPrompt, messages.length, onSend, setSeedPrompt]);

	// Empty-cell prompt dispatch: a submitted cell composer stages the target cell
	// (prepareBody reads it fresh at send time → the route hints the model to fill
	// exactly that cell) and sends the text as a normal, visible chat message.
	const pendingCellRequest = useWidgetGridStore((s) => s.pendingCellRequest);
	useEffect(() => {
		if (!pendingCellRequest) return;
		const grid = useWidgetGridStore.getState();
		grid.clearPendingCellRequest();
		// Staged for the next request body only — `prepareBody` consumes (and clears) it.
		grid.setPendingCellTarget({ x: pendingCellRequest.x, y: pendingCellRequest.y });
		void onSend(pendingCellRequest.text);
	}, [pendingCellRequest, onSend]);

	// Tool-render lanes by context. Org routes artifacts through the panel; if the
	// artifact opens while docked (panel view), maximize to the modal first (the
	// artifact panel needs the modal's room).
	const artifactOpen = useArtifactStore((s) => s.open);
	const openArtifact = useCallback(
		(artifact: Artifact, tab: ArtifactTab) => {
			// The inspector needs the modal's room — maximize a docked panel first so the
			// split pane has somewhere to open.
			if (useElenchStore.getState().view === "panel")
				useElenchStore.getState().maximize();
			artifactOpen(artifact, tab);
		},
		[artifactOpen],
	);
	const openGrid = useCallback(() => {
		if (useElenchStore.getState().view === "panel")
			useElenchStore.getState().maximize();
		useArtifactStore.getState().openGrid();
		track("elench_grid_opened", { context: isOrg ? "org" : "project" });
	}, [isOrg]);

	/** Drop an artifact's widgets onto a (persisted) thread's grid and show it. */
	const materializeOnto = useCallback(
		async (artifactId: string, threadId: string) => {
			await openArtifactOnGrid(artifactId, threadId);
			// Force a re-pull so the materialized rows appear on the grid.
			useWidgetGridStore.setState({ threadId: null });
			await hydrateGrid(threadId);
			useElenchStore.getState().setMainView("chat");
			openGrid();
			track("elench_artifact_opened", { context: isOrg ? "org" : "project" });
		},
		[hydrateGrid, openGrid, isOrg],
	);

	// EXPLICIT action: add the artifact to the conversation that's already open. Never implicit —
	// the old code called startThread(name) on a click, silently creating a chat named after the
	// artifact (or hijacking your last one).
	const addArtifactToChat = useCallback(
		async (artifactId: string) => {
			if (!activeId) return;
			await materializeOnto(artifactId, activeId);
		},
		[activeId, materializeOnto],
	);

	// EXPLICIT action: start a fresh conversation for this artifact and materialize it there.
	const openArtifactInNewChat = useCallback(
		async (artifactId: string, name: string) => {
			newChat();
			const thread = await startThread(name);
			await materializeOnto(artifactId, thread.id);
		},
		[newChat, startThread, materializeOnto],
	);

	// The Artifacts library — available in EVERY chat (org and project alike): artifacts are an
	// org-scoped library (`agent_artifacts` is unique on org_id+name), and — as in Claude, where
	// the artifact library is workspace-level — a project conversation must be able to browse and
	// open them too. `startThread` carries the projectId, so a project chat lands on its own grid.
	const galleryNode = (
		<AgentArtifactGallery
			hasActiveChat={activeId !== null}
			onAddToChat={addArtifactToChat}
			onOpenInNewChat={openArtifactInNewChat}
			onNewArtifact={newChat}
			onClose={() => useElenchStore.getState().setMainView("chat")}
		/>
	);

	// The Knowledge panel — edits the pinned instructions/knowledge for THIS scope: the infra
	// project's row in a project chat, the org-level row in an org chat (the Claude-Projects model).
	const knowledgeNode = (
		<AgentKnowledgePanel
			projectId={projectId || null}
			onClose={() => useElenchStore.getState().setMainView("chat")}
		/>
	);
	const [accepted, setAccepted] = useState<Record<string, boolean>>({});
	const renderToolPart = useMemo(
		() =>
			isOrg
				? orgRenderToolPart({ openArtifact, openGrid, addToolResult })
				: projectRenderToolPart({
						accepted,
						setAccepted,
						addToolResult,
						openArtifact,
						openGrid,
					}),
		[isOrg, openArtifact, openGrid, accepted, addToolResult],
	);

	// Empty only once the thread list has resolved (while loading, the chrome shows the
	// active-conversation top bar over a skeleton, not the hero landing).
	const isEmpty = ready && messages.length === 0;
	const suggestions = isOrg ? ORG_SUGGESTIONS : PROJECT_SUGGESTIONS;
	// The centered title in the modal's active-conversation top bar.
	const convoTitle = !ready
		? "Loading…"
		: isOrg
			? (threads.find((t) => t.id === activeId)?.title ?? "New chat")
			: "Assistant";

	// The chat body swaps between three in-place states inside the SAME chrome: a skeleton
	// while the list resolves, the modal hero landing when settled-empty, or the shared
	// transcript + docked composer. Wrapped in an error boundary re-armed per lineage
	// (epoch) so a new conversation clears any prior render error without remounting chrome.
	const body = (
		<ElenchErrorBoundary key={epoch} onReset={close}>
			{!ready ? (
				<ChatSkeleton
					className={view === "modal" ? "mx-auto w-full max-w-[720px]" : undefined}
				/>
			) : view === "modal" && isEmpty ? (
				<ElenchModalLanding
					onSend={onSend}
					suggestions={suggestions}
					recents={threads}
					onOpenThread={selectThread}
					showModel={isOrg}
					context={isOrg ? "org" : "project"}
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
					supportHref={supportHref}
					onSupport={supportHref ? () => router.push(supportHref) : undefined}
					emptyState={
						view === "panel" && isEmpty ? (
							<ElenchPanelEmpty
								onSend={onSend}
								suggestions={suggestions}
								supportHref={supportHref}
							/>
						) : undefined
					}
				/>
			)}
		</ElenchErrorBoundary>
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
				gallery={galleryNode}
				knowledge={knowledgeNode}
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
