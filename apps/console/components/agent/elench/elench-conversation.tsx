"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isToolUIPart, type UIMessage } from "ai";
import { createEditor } from "lexical";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentArtifactGallery } from "@/components/agent/agent-artifact-gallery";
import { AgentKnowledgePanel } from "@/components/agent/agent-knowledge-panel";
import { AgentChat } from "@/components/agent/agent-chat";
import {
	ChatError,
	ChatNoticeError,
	UnansweredTurnError,
} from "@/components/agent/chat-error";
import { ChatSkeleton } from "@/components/agent/chat-skeleton";
import { type FirstTurn, getThread } from "@/app/server/actions/agent";
import { openArtifactOnGrid } from "@/app/server/actions/artifacts";
import {
	getThreadFeedback,
	setMessageFeedback,
} from "@/app/server/actions/agent-feedback";
import { orgRenderToolPart } from "@/components/agent/render-tool-parts/org-tool-parts";
import { projectRenderToolPart } from "@/components/agent/render-tool-parts/project-tool-parts";
import { TurnRefusedError, useAgentChat } from "@/components/agent/use-agent-chat";
import { pendingClientToolCalls, turnText } from "@/lib/agent/turn-key";
import {
	snapshotCanvas,
	snapshotView,
} from "@/components/project-assistant/use-project-assistant";
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
import { contentToEditor } from "./draft-editor";
import { ElenchComposer, type ElenchComposerHandle } from "./elench-composer";
import { MentionNode } from "./mention-node";
import {
	ElenchModalLanding,
	ElenchPanelEmpty,
} from "./elench-empty-landing";
import { ElenchErrorBoundary } from "./elench-error-boundary";
import { ElenchModal } from "./elench-modal";
import { ElenchPanel } from "./elench-panel";
import { useElenchSend } from "./use-elench-send";
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

/** How often a turn being answered elsewhere is re-read until it is done (ADR 0003 §9.3). */
const IN_FLIGHT_POLL_MS = 5_000;

/** The composer's serialized state holding plain `text` (a refused turn's words, put back). */
function textToComposerState(text: string): string {
	const editor = createEditor({
		nodes: [MentionNode],
		onError: (e) => {
			throw e;
		},
	});
	editor.update(contentToEditor({ text, mentions: [] }), { discrete: true });
	return JSON.stringify(editor.getEditorState().toJSON());
}

/** The status line each typed refusal leaves above the composer (ADR 0003 §9.3's table). */
const REFUSAL_NOTICE: Partial<Record<TurnRefusedError["refusal"]["refusal"], string>> = {
	"turn-in-progress": "Being answered in another tab or device",
	"turn-committed-different-text":
		"An earlier version of this message was already sent. It is shown above. Your edit is still in the box.",
	"thread-busy": "Another message in this conversation is being answered",
	"transcript-stale":
		"This conversation has newer messages. They are shown now. Press Enter to send.",
	"thread-deleted": "That conversation was deleted. Your message is in a new conversation.",
	"thread-not-found": "That conversation is not available. Your message is still in the box.",
	"org-forbidden":
		"This conversation belongs to an organization you are no longer a member of",
	"project-not-found": "That project is not available. Your message is still in the box.",
	"client-outdated": "Reload to continue",
	"turn-has-accepted-approval":
		"This answer started an approved operation, so it cannot be regenerated.",
};

/** How the transcript's Retry resends the last turn (see {@link retryKind}). */
type RetryKind =
	| { kind: "answer" | "continue" | "await-approval" }
	| { kind: "regenerate"; messageId: string };

/**
 * How the transcript's Retry resends the last turn (ADR 0003 §9.1), by what is last:
 * - a user message (an unanswered turn): `regenerate()`, an `answer` attempt;
 * - an assistant message whose pending client tool calls all have outputs: the continuation
 *   request again, which the server re-arms or resumes with the stored outputs kept (#5796);
 * - one whose pending client tool calls lack outputs (a tail that proposed something new):
 *   `await-approval`, no Retry: the card is still approvable and is the way on;
 * - any other assistant message: `regenerate({ messageId })` of that answer.
 */
function retryKind(messages: readonly UIMessage[]): RetryKind {
	const last = messages.at(-1);
	if (!last || last.role !== "assistant") return { kind: "answer" };
	const pending = pendingClientToolCalls(last);
	if (pending.length === 0) return { kind: "regenerate", messageId: last.id };
	const answered = new Set(
		last.parts.flatMap((p) =>
			isToolUIPart(p) && p.state === "output-available" ? [p.toolCallId] : [],
		),
	);
	return pending.every((id) => answered.has(id))
		? { kind: "continue" }
		: { kind: "await-approval" };
}

/** The card an answer that stopped at an unresolved proposal shows instead of a Retry. */
const AWAIT_APPROVAL = new ChatNoticeError(
	"The answer stopped at a proposal",
	"Approve or reject the proposal above to continue.",
);

/** The card a send gets while the page has not yet told the conversation its org. */
const ORG_NOT_READY = new ChatNoticeError(
	"Your organization is still loading",
	"Your organization is still loading. Try again in a moment.",
);

/** The card a continuation refused from a stale revision keeps, with its Retry (§9.1). */
const STALE_RESUME = new ChatNoticeError(
	"The answer was interrupted",
	"This conversation changed while the answer was being continued. Retry to continue it.",
);

/** The error a resumed transcript shows when it ends on a user turn that was never answered.
 * `ChatError` recognises it by type: "No reply arrived" + Retry, and no `elench_error` event. */
const UNANSWERED_TURN = new UnansweredTurnError();

export interface ElenchThreadApi {
	/** False until the initial thread list resolves — the body shows a skeleton meanwhile. */
	ready: boolean;
	threads: AgentThread[];
	activeId: string | null;
	initialMessages: UIMessage[];
	selectThread: (id: string) => void;
	/** The revision `initialMessages` was read at: the base revision of the next send. */
	initialRevision?: number | null;
	/** Reload a thread's transcript and revision in place (a refused turn's recovery). */
	reloadThread?: (id: string) => Promise<unknown>;
	newChat: () => void;
	/** Lazily persist the ephemeral conversation on its first send (storing `firstTurn`, the
	 * user message, with it); returns the new thread. */
	startThread: (title: string, firstTurn?: FirstTurn) => Promise<AgentThread>;
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
	initialRevision,
	reloadThread,
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
	// The org the turn names: the page's, read at request time (ADR 0003 §6.1, §9.1).
	const pageOrg = useCallback(() => useElenchStore.getState().pageOrgId, []);

	// In-app support hub (`/{org}/~/support`), not the marketing contact page. Undefined until
	// the active org slug resolves, which hides the Support affordance rather than linking to
	// a malformed `//~/support`.
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const supportHref = orgSlug ? globalHref(orgSlug, "support") : undefined;

	// Per-message thumbs, hydrated per thread so a rating stays filled across a reload.
	const [feedbackMap, setFeedbackMap] = useState<
		Record<string, "up" | "down">
	>({});
	useEffect(() => {
		if (!activeId) {
			setFeedbackMap({});
			return;
		}
		let cancelled = false;
		void getThreadFeedback(activeId)
			.then((m) => {
				if (!cancelled) setFeedbackMap(m);
			})
			.catch(() => {
				if (!cancelled) setFeedbackMap({});
			});
		return () => {
			cancelled = true;
		};
	}, [activeId]);

	/** Persist a thumbs rating and record it for product analytics (spend stays server-side). */
	const handleFeedback = useCallback(
		(messageId: string, value: "up" | "down") => {
			if (!activeId) return;
			setFeedbackMap((m) => ({ ...m, [messageId]: value }));
			void setMessageFeedback(activeId, messageId, value);
			track("elench_message_feedback", {
				value,
				context: isOrg ? "org" : "project",
			});
		},
		[activeId, isOrg],
	);

	// Transport by context. `api` + `prepareBody` are referentially stable within a
	// mount (the conversation is keyed by ctx/thread upstream, so it remounts cleanly
	// when either changes). prepareBody reads the store FRESH at send time.
	const api = isOrg
		? "/api/agent"
		: `/api/projects/${ctx.kind === "project" ? ctx.projectId : ""}/assistant`;
	const projectId = ctx.kind === "project" ? ctx.projectId : "";
	// The cell target the last request carried (a refusal re-stages it, ADR 0003 §9.3).
	const lastCellTarget = useRef<{ x: number; y: number } | null>(null);
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
							// Kept for the request, so a refused cell prompt can re-stage it.
							cellTarget: (lastCellTarget.current = takePendingCellTarget()),
						};
					}
				: () => {
						const s = useElenchStore.getState();
						return {
							projectId,
							threadId: s.threadId,
							canvas: snapshotCanvas(),
							mentions: s.pendingMentions,
							// Read FRESH from the store, never from the `ctx` this factory closed
							// over: `prepareBody` is memoized on the project id, so a `syncEnvironment`
							// from the topbar switcher would otherwise keep sending the environment
							// the panel was opened on for the rest of the conversation.
							environmentId:
								s.ctx.kind === "project" ? s.ctx.environmentId : null,
							// Where the question was asked from — the route, its surface, and the
							// card on the workspace rail.
							view: snapshotView(),
							deepReasoning: s.deepReasoning,
						};
					},
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
		addToolResult,
		clearError,
		setBaseRevision,
	} = useAgentChat({
		api,
		id: chatId,
		initialMessages,
		initialRevision,
		prepareBody,
		org: pageOrg,
	});

	// ── A refused turn (ADR 0003 §9.3, the composer path) ──────────────────────────────────────
	// The status line a refusal leaves, a turn being answered elsewhere, the stale-revision resume
	// card, and the words to put back into the composer once the reloaded transcript has mounted.
	const [refusalNotice, setRefusalNotice] = useState<string | null>(null);
	const [beingAnswered, setBeingAnswered] = useState(false);
	const [staleResume, setStaleResume] = useState(false);
	const [restoreAt, setRestoreAt] = useState<{ state: string; epoch: number } | null>(null);
	// The composer state of the last send, so a refused turn comes back with its mention pills.
	const lastComposerSend = useRef<{ text: string; state: string } | null>(null);

	// A resumed transcript that ENDS on a user turn is a turn whose reply never landed — most
	// often a first send that failed (AI not configured, budget, provider error): `createThread`
	// stores that message with the row, and only a successful turn writes a reply after it.
	// Show it as the failed turn it is, with the transcript's own error + Retry (`regenerate`
	// re-sends a trailing user turn), until the chat moves on. This used to call
	// `resumeStream()`, which GETs `<api>/<chatId>/stream` — a route that has never existed —
	// so it 404'd and surfaced Next's error page as a misclassified chat error.
	const unanswered =
		error === undefined &&
		!beingAnswered &&
		status === "ready" &&
		messages.length > 0 &&
		messages.length === initialMessages.length &&
		messages.at(-1)?.id === initialMessages.at(-1)?.id &&
		messages.at(-1)?.role === "user";
	const shownError = unanswered ? UNANSWERED_TURN : error;

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

	const beforeSend = useCallback(
		(mentions: Mention[]) => {
			// A new send supersedes whatever the last refusal said.
			setRefusalNotice(null);
			setStaleResume(false);
			// Stage the @-referenced resources so prepareBody sends them with the request.
			setPendingMentions(mentions);
			track("elench_message_sent", {
				context: isOrg ? "org" : "project",
				model: useElenchStore.getState().model,
				project: projectId || undefined,
			});
		},
		[setPendingMentions, isOrg, projectId],
	);
	// The store, read fresh: `startThread` attaches the id before this component re-renders.
	const hasThread = useCallback(() => useElenchStore.getState().threadId != null, []);
	// A thread created on the first send seeds the base revision of that send (ADR 0003 §9.1).
	const startThreadSeeded = useCallback(
		async (title: string, firstTurn?: FirstTurn) => {
			const thread = await startThread(title, firstTurn);
			setBaseRevision(thread.revision);
			return thread;
		},
		[startThread, setBaseRevision],
	);
	// The first send of an ephemeral conversation creates + attaches its thread (title from
	// the text, the user turn stored with the row) BEFORE the message goes out, so prepareBody
	// carries the id and the route's onFinish persists the reply. If that creation fails,
	// NOTHING is sent — a send without a thread is never stored — the failure shows inline, the
	// composer keeps the text (still editable), and Retry re-attempts the thread (see below).
	const {
		send: sendTurn,
		error: sendError,
		retry: retrySend,
		failedState,
		reset: resetSend,
	} = useElenchSend({ hasThread, startThread: startThreadSeeded, sendMessage, beforeSend });
	// No page org yet (the shell has not mounted it): the route would answer `client-outdated`
	// (#5796), so nothing is sent; the text stays where it was typed and the user is told why.
	const [orgNotReady, setOrgNotReady] = useState(false);
	/** Every send of this conversation: refused here, before a thread or a request, without a page org. */
	const onSend = useCallback(
		async (text: string, mentions?: Mention[], state?: string): Promise<boolean> => {
			if (!pageOrg()) {
				setOrgNotReady(true);
				return false;
			}
			setOrgNotReady(false);
			return sendTurn(text, mentions, state);
		},
		[pageOrg, sendTurn],
	);
	/** The composer's send, remembering its editor state so a refused turn comes back intact. */
	const onComposerSend = useCallback(
		(text: string, mentions?: Mention[], state?: string) => {
			if (state !== undefined) lastComposerSend.current = { text, state };
			return onSend(text, mentions, state);
		},
		[onSend],
	);
	// A new chat / resume (a new lineage) starts with no failed send pending.
	useEffect(() => {
		resetSend();
	}, [chatId, resetSend]);
	// Whichever composer is mounted (the modal hero's or the docked one — never both).
	const composerRef = useRef<ElenchComposerHandle>(null);
	// Retry after a failed thread start is the composer's own submit — EXACTLY Enter: it sends
	// what the box holds NOW, edits included, and clears only on a send that went out. Re-sending
	// the failed attempt's snapshot instead sent text the user had since changed, then the
	// composer was remounted (or the landing unmounted) and the edit was gone without a word.
	// When the box holds nothing, a turn that was TYPED in the composer is put back into it and
	// nothing is sent: the user emptied the box, and Retry must not send words they just erased.
	// A turn that never lived in the composer (a suggestion card, a seed prompt, a grid cell) is
	// re-sent as it was — there is no typed text to lose.
	const onRetryStart = useMemo(
		() =>
			retrySend
				? () => {
						void (async () => {
							const composer = composerRef.current;
							const outcome = await composer?.submit();
							if (outcome !== undefined && outcome !== "empty") return;
							if (composer && failedState) composer.restore(failedState);
							else await retrySend();
						})();
					}
				: undefined,
		[retrySend, failedState],
	);
	/**
	 * The composer path of a refused turn (ADR 0003 §9.3): load the stored transcript (which
	 * refreshes the base revision), clear the error, and put text the server (#5796) did not commit back
	 * into the composer with the refusal's notice. From ADR 0001's slice 9 on, a refusal of a
	 * store-owned send will go to the store instead.
	 */
	const onTurnRefused = useCallback(
		async (err: TurnRefusedError) => {
			const { refusal, request } = err;
			clearError();
			const refused = request?.last;
			const threadId = useElenchStore.getState().threadId;
			if (refusal.refusal === "thread-deleted") newChat();
			else if (threadId && reloadThread) await reloadThread(threadId);
			// A continuation refused as answered from an older revision ended partial without this
			// tab seeing it finish: keep its card and Retry, which now carries the current revision.
			setStaleResume(
				refused?.role === "assistant" &&
					refusal.refusal === "turn-answered" &&
					refusal.revision !== null &&
					refusal.revision !== request?.turn.baseRevision,
			);
			setBeingAnswered(refusal.refusal === "turn-in-progress");
			setRefusalNotice(REFUSAL_NOTICE[refusal.refusal] ?? null);
			if (!refusal.textCommitted && refused?.role === "user") {
				const text = turnText(refused);
				const sent = lastComposerSend.current;
				const state =
					sent && sent.text.trim() === text ? sent.state : textToComposerState(text);
				setRestoreAt({ state, epoch: useElenchStore.getState().epoch });
				if (lastCellTarget.current) {
					useWidgetGridStore.getState().setPendingCellTarget(lastCellTarget.current);
				}
			}
		},
		[clearError, newChat, reloadThread],
	);
	useEffect(() => {
		if (error instanceof TurnRefusedError) void onTurnRefused(error);
	}, [error, onTurnRefused]);
	// Put the refused words back once the reloaded transcript (and its composer) has mounted.
	useEffect(() => {
		if (!restoreAt || restoreAt.epoch !== epoch) return;
		composerRef.current?.restore(restoreAt.state);
		setRestoreAt(null);
	}, [restoreAt, epoch]);
	// A turn being answered in another tab: re-read the thread until no claim runs, then load it.
	useEffect(() => {
		if (!beingAnswered || !activeId) return;
		let done = false;
		const timer = setInterval(() => {
			void getThread(activeId).then(async (t) => {
				if (done || t?.inFlight) return;
				done = true;
				clearInterval(timer);
				setBeingAnswered(false);
				setRefusalNotice(null);
				if (reloadThread) await reloadThread(activeId);
			});
		}, IN_FLIGHT_POLL_MS);
		return () => {
			done = true;
			clearInterval(timer);
		};
	}, [beingAnswered, activeId, reloadThread]);

	// The transcript's Retry, chosen by what is last (§9.1); undefined when there is none.
	const retry = retryKind(messages);
	const retryTurn =
		retry.kind === "await-approval"
			? undefined
			: () => {
					setStaleResume(false);
					setRefusalNotice(null);
					if (retry.kind === "regenerate") void regenerate({ messageId: retry.messageId });
					else if (retry.kind === "continue") void sendMessage();
					else void regenerate();
				};

	// The transcript's own error, as the conversation shows it: a refusal is handled above and is
	// never an error card; an answer that stopped at a proposal says to resolve it instead.
	let transcriptError: Error | undefined =
		shownError instanceof TurnRefusedError ? undefined : shownError;
	if (staleResume) transcriptError = STALE_RESUME;
	else if (transcriptError && retry.kind === "await-approval") transcriptError = AWAIT_APPROVAL;
	// A failed send (thread not created / too long) is shown where the transcript's own error
	// would be, and takes precedence over it: it is the newer event.
	const visibleError = (orgNotReady ? ORG_NOT_READY : null) ?? sendError ?? transcriptError;
	const onRetry = orgNotReady
		? () => void composerRef.current?.submit()
		: sendError
			? onRetryStart
			: retryTurn;

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
					composerRef={composerRef}
					composerSeed={failedState}
					notice={
						orgNotReady ? (
							<ChatError error={ORG_NOT_READY} />
						) : sendError ? (
							<ChatError error={sendError} onRetry={onRetryStart} />
						) : undefined
					}
				/>
			) : (
				<AgentChat
					messages={messages}
					status={status}
					error={visibleError}
					onSend={onSend}
					onRetry={onRetry}
					onRegenerate={(messageId) => void regenerate({ messageId })}
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
						<>
							{refusalNotice && (
								<p role="status" className="px-1 pb-2 text-ui-sm text-muted-foreground">
									{refusalNotice}
								</p>
							)}
							<ElenchComposer
								handleRef={composerRef}
								seed={failedState}
								onSend={onComposerSend}
								onStop={() => void stop()}
								showModel={isOrg}
								status={status}
							/>
						</>
					}
					onFeedback={handleFeedback}
					initialFeedback={feedbackMap}
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
