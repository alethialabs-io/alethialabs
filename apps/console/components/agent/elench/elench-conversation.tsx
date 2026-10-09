"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { isToolUIPart, type UIMessage } from "ai";
import { useRouter } from "next/navigation";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { AgentArtifactGallery } from "@/components/agent/agent-artifact-gallery";
import { AgentKnowledgePanel } from "@/components/agent/agent-knowledge-panel";
import { AgentChat } from "@/components/agent/agent-chat";
import {
	ChatError,
	ChatNoticeError,
	UnansweredTurnError,
} from "@/components/agent/chat-error";
import { ChatSkeleton } from "@/components/agent/chat-skeleton";
import { getThread } from "@/app/server/actions/agent";
import { openArtifactOnGrid } from "@/app/server/actions/artifacts";
import {
	getThreadFeedback,
	setMessageFeedback,
} from "@/app/server/actions/agent-feedback";
import { orgRenderToolPart } from "@/components/agent/render-tool-parts/org-tool-parts";
import { projectRenderToolPart } from "@/components/agent/render-tool-parts/project-tool-parts";
import { ChatRouteError, TurnRefusedError, useAgentChat } from "@/components/agent/use-agent-chat";
import { pendingClientToolCalls } from "@/lib/agent/turn-key";
import {
	snapshotCanvas,
	snapshotView,
} from "@/components/project-assistant/use-project-assistant";
import { track } from "@/lib/analytics/track";
import type { AgentThread } from "@/lib/db/schema";
import { keyId, scopeId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { RouteFailure } from "@/lib/stores/elench-drafts/reducer-sending";
import { selectDraft } from "@/lib/stores/elench-drafts/selectors";
import type { DraftUiEffect } from "@/lib/stores/elench-drafts/store";
import type { DraftKey, DraftScope } from "@/lib/stores/elench-drafts/types";
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
import { ElenchComposer, type ElenchComposerHandle } from "./elench-composer";
import { type DraftsTab, useDraftsTab } from "./elench-drafts-root";
import {
	ElenchModalLanding,
	ElenchPanelEmpty,
} from "./elench-empty-landing";
import { ElenchErrorBoundary } from "./elench-error-boundary";
import { ElenchModal } from "./elench-modal";
import { ElenchPanel } from "./elench-panel";
import {
	ElenchDraftContext,
	type ElenchDraftBinding,
	useDraftEntry,
	useElenchSend,
} from "./use-elench-send";
import {
	ORG_SUGGESTIONS,
	PROJECT_SUGGESTIONS,
} from "./elench-suggestions";

const PLACEHOLDER = "Ask Elench, or type @ to tag a resource";

/** How often a turn being answered elsewhere is re-read until it is done (ADR 0003 §9.3). */
const IN_FLIGHT_POLL_MS = 5_000;

/**
 * D9d: a later turn's chat request that has not reached `streaming` after this long is stopped (the
 * route sees a disconnect) and read as an uncertain failure, so its words come back to the box.
 */
const ROUTE_DEADLINE_MS = 60_000;

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

/**
 * What a chat error says about a request that failed before `streaming` (D9d): a typed refusal and
 * an untyped non-2xx both carry their status, which D9d reads (the routes' own pre-hold refusals
 * are certain); anything else (a `fetch` that threw, a stream that broke) is a network failure,
 * which is uncertain.
 */
function routeFailureOf(error: Error): RouteFailure {
	if (error instanceof TurnRefusedError)
		return { kind: "status", status: error.status, refusal: error.refusal };
	if (error instanceof ChatRouteError) return { kind: "status", status: error.status, refusal: null };
	return { kind: "network" };
}

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

/** Subscribes to nothing: the snapshot without a store never changes. */
function subscribeNothing(): () => void {
	return () => undefined;
}

/**
 * The scope the tab's drafts store shows, once its first list has settled (SELECT waits for both:
 * D26 restores a reloaded tab's cached words only into a key the store does not hold yet).
 */
function useListedScope(tab: DraftsTab | null): DraftScope | null {
	const subscribe = useCallback(
		(onChange: () => void) => (tab === null ? subscribeNothing() : tab.store.view.subscribe(onChange)),
		[tab],
	);
	const snapshot = useCallback(() => {
		const scope = tab?.store.view.getState().drafts.scope ?? null;
		return tab !== null && scope !== null && tab.hasListed(scope) ? scope : null;
	}, [tab]);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export interface ElenchThreadApi {
	/** False until the initial thread list resolves — the body shows a skeleton meanwhile. */
	ready: boolean;
	threads: AgentThread[];
	activeId: string | null;
	initialMessages: UIMessage[];
	selectThread: (id: string) => void;
	/** The revision `initialMessages` was read at: the base revision of the next send. */
	initialRevision?: number | null;
	/** Reload a thread's transcript and revision in place (`loadInto`). */
	reloadThread?: (id: string) => Promise<unknown>;
	newChat: () => void;
	/** Persist an empty conversation (an artifact opened in a new chat); returns the new thread. */
	startThread: (title: string) => Promise<AgentThread>;
	deleteThread: (id: string) => void;
}

/**
 * The single Elench conversation. Owns exactly one `useAgentChat` instance — keyed by the
 * ctx+epoch chat lineage token, so a "New chat" / resume recreates the underlying chat
 * (fresh or resumed transcript) WITHOUT remounting this component or its chrome. The
 * modal/panel chrome is branched INTERNALLY and stays mounted across a view flip, the
 * ready gate, and a new chat — so the panel's open animation runs once, the rail never
 * flashes, and minimize/maximize preserves the transcript. Mounted once per open.
 *
 * Every send is the drafts store's (ADR 0001 §7): the composer is a view of the conversation's
 * draft, Enter and every prompt that is not the box's are events, and the store hands back what
 * touches `useChat` (push a turn, take back a turn the route never accepted, load the stored
 * transcript, seed its revision) as UI effects this component runs. This component watches each
 * store-owned turn's request for its hand-off (D9c) or its failure (D9d), and a typed refusal of a
 * store-owned turn goes to the store and nowhere else (ADR 0003 §9.3's one-handler check).
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
	const pageOrgId = useElenchStore((s) => s.pageOrgId);
	const conversationId = useElenchStore((s) => s.conversationId);
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
	// when either changes). prepareBody reads the store FRESH at send time. A turn's mentions
	// and cell target are not body fields: they ride its own message's `metadata`, which is
	// what the routes store and read (ADR 0003 §9.2).
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
							deepReasoning: s.deepReasoning,
						};
					}
				: () => {
						const s = useElenchStore.getState();
						return {
							projectId,
							threadId: s.threadId,
							canvas: snapshotCanvas(),
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
		setMessages,
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

	// ── The conversation's draft (ADR 0001 §7) ─────────────────────────────────────────────────
	// The key is the page's org id, the anchor and the conversation id; while the page's org is not
	// known there is no key, and so nothing to write to.
	const tab = useDraftsTab();
	const anchorProject = ctx.kind === "project" ? ctx.projectId : null;
	const key = useMemo<DraftKey | null>(
		() =>
			pageOrgId === null ? null : { orgId: pageOrgId, projectId: anchorProject, conversationId },
		[pageOrgId, anchorProject, conversationId],
	);
	const binding = useMemo<ElenchDraftBinding | null>(
		() => (tab === null || key === null ? null : { store: tab.store, key }),
		[tab, key],
	);
	const entry = useDraftEntry(binding);
	const send = useElenchSend(binding, status);
	const draftsScope = useListedScope(tab);

	// The status line of a refused regenerate or continuation (ADR 0003 §9.3), which no draft owns.
	const [refusalNotice, setRefusalNotice] = useState<string | null>(null);
	// The turn of the conversation on screen that is being answered in another tab or device (D20):
	// its thread is polled until done. It belongs to that conversation: a switch, a new chat or a
	// delete (each changes `conversationId`) drops it, so a poll never outlives the screen it was for.
	const [beingAnswered, setBeingAnswered] = useState<{ conversationId: string; threadId: string } | null>(null);
	const [answeredFor, setAnsweredFor] = useState(conversationId);
	if (answeredFor !== conversationId) {
		setAnsweredFor(conversationId);
		setBeingAnswered(null);
	}
	const [staleResume, setStaleResume] = useState(false);
	// A send while the page has not told the conversation its org: nothing is sent, and it says why.
	const [orgNotReady, setOrgNotReady] = useState(false);
	// Why a store-owned turn's request failed before `streaming` when the route said more than a
	// typed refusal (a 402 budget, a 503, a 5xx, the network): shown with the chat's own error card,
	// whose Retry is Enter on the box, until the next send of this conversation.
	const [routeError, setRouteError] = useState<Error | null>(null);
	// Threads this mount started (D12), shown in the rail before the next list.
	const [started, setStarted] = useState<AgentThread[]>([]);
	const shownThreads = useMemo(
		() => [...started.filter((t) => !threads.some((x) => x.id === t.id)), ...threads],
		[started, threads],
	);

	// A selection whose transcript the thread hook already loaded is marked, so the store's load of
	// it (D4) is answered at once instead of loading it again.
	const selecting = useRef<string | null>(null);

	const hydrateGrid = useWidgetGridStore((s) => s.hydrate);
	const resetGrid = useWidgetGridStore((s) => s.reset);
	useEffect(() => {
		if (activeId) void hydrateGrid(activeId);
		else resetGrid();
	}, [activeId, hydrateGrid, resetGrid]);
	useWidgetAutoPin(messages, activeId);

	/** Answers the store's load of `key`: the transcript is in `useChat` (D4, D9a, D13, D17, D22). */
	const loaded = useCallback(
		(loadedKey: DraftKey) =>
			tab?.store.dispatch({ type: "ENTRY", key: loadedKey, event: { type: "TRANSCRIPT_LOADED" } }),
		[tab],
	);

	/** D12: the conversation's thread now exists under its id; show it in the rail before a list. */
	const attachStarted = useCallback((id: string) => {
		useElenchStore.getState().attachThread(id);
		void getThread(id)
			.then((t) => {
				if (t) setStarted((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
			})
			.catch(() => undefined);
	}, []);

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

	/** One UI effect of the store, for this conversation's key (§7.2). */
	const runEffect = useCallback(
		(e: DraftUiEffect) => {
			if (e.type === "place-artifacts") {
				// D12: the pending Open-in-new-chat placements land on the conversation's new thread.
				for (const artifactId of e.artifacts)
					void materializeOnto(artifactId, e.key.conversationId).catch(() =>
						toast.error("An artifact could not be placed in the new conversation."),
					);
				return;
			}
			if (key === null || keyId(e.key) !== keyId(key)) return; // not the conversation on screen
			switch (e.type) {
				case "send-message": {
					// D9b / D10y / D12: the turn goes out under the id the store minted, in the `parts`
					// form (§5.3 item 1), with its pills and cell on its own message, the one place the
					// routes read them from (ADR 0003 §9.2).
					setRefusalNotice(null);
					setRouteError(null);
					setStaleResume(false);
					setOrgNotReady(false);
					track("elench_message_sent", {
						context: isOrg ? "org" : "project",
						model: useElenchStore.getState().model,
						project: projectId || undefined,
					});
					void sendMessage({
						id: e.turnId,
						role: "user",
						parts: [{ type: "text", text: e.text }],
						metadata: { mentions: e.mentions, cellTarget: e.cellTarget },
					});
					return;
				}
				case "remove-optimistic":
					// D9d / D10f: the route never accepted this turn, so it leaves the transcript.
					setMessages((ms) => ms.filter((m) => m.id !== e.turnId));
					return;
				case "load-transcript": {
					const id = keyId(e.key);
					if (selecting.current === id || !reloadThread) {
						queueMicrotask(() => loaded(e.key));
						return;
					}
					void reloadThread(e.key.conversationId)
						.then(() => loaded(e.key))
						.catch(() => undefined);
					return;
				}
				case "thread-revision":
					// D12: the first turn is stored; the transport's next base revision is that row's.
					setBaseRevision(e.revision);
					attachStarted(e.key.conversationId);
					return;
				case "poll-thread":
					// D20: the turn is being answered elsewhere; poll its conversation until it is done.
					setBeingAnswered({ conversationId: e.key.conversationId, threadId: e.key.conversationId });
					return;
				case "offer-undo-discard":
					// The Undo toast of a Discard is slice 11's; nothing offers a Discard before it.
					return;
			}
		},
		[
			key,
			isOrg,
			projectId,
			materializeOnto,
			sendMessage,
			setMessages,
			reloadThread,
			loaded,
			setBaseRevision,
			attachStarted,
		],
	);
	const runEffectRef = useRef(runEffect);
	useEffect(() => {
		runEffectRef.current = runEffect;
	}, [runEffect]);
	useEffect(() => (tab === null ? undefined : tab.subscribeUi((e) => runEffectRef.current(e))), [tab]);

	// D4: the store's active key follows the conversation on screen, once the store shows its scope.
	// After the subscription above, so the load the selection asks for reaches this conversation.
	useEffect(() => {
		if (tab === null || key === null || draftsScope === null) return;
		if (scopeId(draftsScope) !== scopeId(key)) return;
		const drafts = tab.store.view.getState().drafts;
		const id = keyId(key);
		if (drafts.activeKey[scopeId(key)] === key.conversationId && drafts.entries[id] !== undefined) return;
		const stored = activeId === key.conversationId;
		selecting.current = stored ? id : null;
		tab.store.dispatch({ type: "SELECT", key, thread: stored ? "listed" : "none" });
		selecting.current = null;
	}, [tab, key, draftsScope, activeId]);

	// D18: when the store forks a send's words into a new conversation, the screen follows them. Only
	// a move of the store's own (a selection here sets it to the conversation already on screen).
	const scopeOfKey = key === null ? null : scopeId(key);
	useEffect(() => {
		if (tab === null || scopeOfKey === null) return;
		let before = tab.store.view.getState().drafts.activeKey[scopeOfKey];
		return tab.store.view.subscribe((s) => {
			const now = s.drafts.activeKey[scopeOfKey];
			if (now === before) return;
			before = now;
			if (now === undefined || now === useElenchStore.getState().conversationId) return;
			newChat();
			useElenchStore.getState().followConversation(now);
		});
	}, [tab, scopeOfKey, newChat]);

	// ── The hand-off of a store-owned turn (D9c, D9d) ──────────────────────────────────────────
	const sending = entry?.sending ?? null;
	const routingTurn = sending !== null && sending.phase === "routing" ? sending.turnId : null;
	/** Dispatches one send event of the conversation's key. */
	const routeEvent = useCallback(
		(event: { type: "ROUTE_HANDOFF"; turnId: string } | { type: "ROUTE_FAILED"; turnId: string; failure: RouteFailure }) => {
			if (binding !== null) binding.store.dispatch({ type: "ENTRY", key: binding.key, event });
		},
		[binding],
	);
	// Whether the routing turn's request was seen in flight (so a later `ready` with no answer is a Stop).
	const routeBusy = useRef<string | null>(null);
	useEffect(() => {
		if (routingTurn === null) {
			routeBusy.current = null;
			return;
		}
		const turnAt = messages.findLastIndex((m) => m.role === "user" && m.id === routingTurn);
		if (turnAt === -1) return;
		const answered = messages.slice(turnAt + 1).some((m) => m.role === "assistant");
		if (status === "streaming" || answered) {
			routeEvent({ type: "ROUTE_HANDOFF", turnId: routingTurn });
			return;
		}
		if (status === "submitted") {
			routeBusy.current = routingTurn;
			return;
		}
		if (status === "ready" && routeBusy.current === routingTurn)
			routeEvent({ type: "ROUTE_FAILED", turnId: routingTurn, failure: { kind: "stop" } });
	}, [routingTurn, status, messages, routeEvent]);
	// A failure before `streaming` that is not a typed refusal (those are read by `onTurnRefused`).
	useEffect(() => {
		if (routingTurn === null || error === undefined || error instanceof TurnRefusedError) return;
		clearError();
		setRouteError(error);
		routeEvent({ type: "ROUTE_FAILED", turnId: routingTurn, failure: routeFailureOf(error) });
	}, [routingTurn, error, clearError, routeEvent]);
	// D9d's deadline: stop the request, so the route sees a disconnect, and read it as uncertain.
	useEffect(() => {
		if (routingTurn === null) return;
		const timer = setTimeout(() => {
			void stop();
			routeEvent({ type: "ROUTE_FAILED", turnId: routingTurn, failure: { kind: "deadline" } });
		}, ROUTE_DEADLINE_MS);
		return () => clearTimeout(timer);
	}, [routingTurn, stop, routeEvent]);

	/**
	 * A typed refusal (ADR 0003 §9.3). Every send of a user's words is the drafts store's (a composer
	 * send, D9d, or an external one, D10f), so the refusal of one goes to the store and NOTHING else
	 * runs: the store decides where the words are and says why, loads the transcript, and asks for the
	 * poll of a turn being answered elsewhere (D20). Nothing here ever puts words back into the box.
	 * The only requests the store never sends are a regenerate and a continuation, whose words are
	 * already in the stored transcript: for those the transcript is loaded (which refreshes the base
	 * revision) and the refusal's status line shown. A refused send the store no longer holds (its
	 * deadline already released it) has been answered by the store, so it is only cleared.
	 */
	const onTurnRefused = useCallback(
		async (err: TurnRefusedError) => {
			const { refusal, request } = err;
			clearError();
			const turnId = request?.turn.turnId ?? refusal.turnId;
			if (binding !== null && turnId !== null) {
				const owned = selectDraft(binding.store.view.getState(), binding.key)?.sending;
				if (owned?.turnId === turnId) {
					routeEvent({ type: "ROUTE_FAILED", turnId, failure: routeFailureOf(err) });
					return;
				}
			}
			const refused = request?.last;
			const storeNeverSends =
				request?.turn.trigger === "regenerate-message" || refused?.role === "assistant";
			if (!storeNeverSends) return;
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
			const onScreen = useElenchStore.getState().conversationId;
			setBeingAnswered(
				refusal.refusal === "turn-in-progress" && threadId ? { conversationId: onScreen, threadId } : null,
			);
			setRefusalNotice(REFUSAL_NOTICE[refusal.refusal] ?? null);
		},
		[clearError, binding, routeEvent, newChat, reloadThread],
	);
	useEffect(() => {
		if (error instanceof TurnRefusedError) void onTurnRefused(error);
	}, [error, onTurnRefused]);
	// Whichever composer is mounted (the modal hero's or the docked one — never both).
	const composerRef = useRef<ElenchComposerHandle>(null);
	// A turn being answered in another tab or device (D20): re-read its thread with `getThread` until
	// no claim runs (`inFlight` is null), then retire the "Being answered" line and load the thread,
	// but only while it is still the conversation on screen: the load never moves the view.
	useEffect(() => {
		if (beingAnswered === null || beingAnswered.conversationId !== conversationId) return;
		const { threadId: polled } = beingAnswered;
		let done = false;
		const timer = setInterval(() => {
			void getThread(polled).then(async (t) => {
				if (done || t?.inFlight) return;
				done = true;
				clearInterval(timer);
				setBeingAnswered(null);
				setRefusalNotice(null);
				if (binding !== null && binding.key.conversationId === conversationId) {
					const id = keyId(binding.key);
					const said = binding.store.view
						.getState()
						.notices.filter((n) => n.notice === "being-answered" && keyId(n.key) === id)
						.map((n) => n.id);
					if (said.length > 0) binding.store.ackNotices(said);
				}
				if (reloadThread && useElenchStore.getState().conversationId === conversationId) {
					await reloadThread(polled);
				}
			});
		}, IN_FLIGHT_POLL_MS);
		return () => {
			done = true;
			clearInterval(timer);
		};
	}, [beingAnswered, conversationId, binding, reloadThread]);

	// A resumed transcript that ENDS on a user turn is a turn whose reply never landed — most
	// often a first send whose answer failed (AI not configured, budget, provider error):
	// `startConversation` stores that message with the row, and only a successful turn writes a
	// reply after it. Show it as the failed turn it is, with the transcript's own error + Retry
	// (`regenerate` re-sends a trailing user turn), until the chat moves on.
	const unanswered =
		error === undefined &&
		beingAnswered === null &&
		status === "ready" &&
		messages.length > 0 &&
		messages.length === initialMessages.length &&
		messages.at(-1)?.id === initialMessages.at(-1)?.id &&
		messages.at(-1)?.role === "user";
	const shownError = unanswered ? UNANSWERED_TURN : error;

	/** A prompt that is not the box's (a suggestion card, Try now): D10x / D10y. */
	const sendPrompt = useCallback(
		(text: string) => {
			setOrgNotReady(!send.submitExternal({ text, origin: "suggestion" }));
		},
		[send],
	);
	/** Enter on the box, for the cards' Retry: nothing is sent without a draft to send from. */
	const submitBox = useCallback(() => {
		setRouteError(null);
		setOrgNotReady(!send.submit());
	}, [send]);

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
	const visibleError = orgNotReady ? ORG_NOT_READY : (routeError ?? transcriptError);
	const onRetry = orgNotReady || routeError !== null ? submitBox : retryTurn;

	/**
	 * Sends an external prompt (D10x / D10y) and answers whether the store TOOK it: a token-less send
	 * of this conversation now exists. A send the store refused (another send is under way, D10z;
	 * the transcript is still loading, D9a; the chat is busy, R3) changes nothing, so its caller
	 * keeps the prompt and tries again when the draft or the chat moves on.
	 */
	const takeExternal = useCallback(
		(prompt: Parameters<typeof send.submitExternal>[0]): boolean => {
			if (binding === null) return false;
			const before = selectDraft(binding.store.view.getState(), binding.key)?.sending ?? null;
			send.submitExternal(prompt);
			const after = selectDraft(binding.store.view.getState(), binding.key)?.sending ?? null;
			return after !== null && after !== before && after.token === null;
		},
		[binding, send],
	);

	// Auto-send a staged seed prompt once into an otherwise-empty conversation (D10x). It stays
	// staged until the store takes it.
	useEffect(() => {
		if (!seedPrompt || messages.length > 0 || entry === null) return;
		if (takeExternal({ text: seedPrompt, origin: "seed" })) setSeedPrompt(null);
	}, [seedPrompt, messages.length, entry, status, takeExternal, setSeedPrompt]);

	// Empty-cell prompt dispatch: a submitted cell composer is an external send (D10y, or D10x into
	// a new conversation) that carries its cell IN THE EVENT, so the turn's own message names the
	// cell, and no later turn can carry it (ADR 0003 §9.2, §9.4 change 3). The request is
	// cleared only once the store took the send: a prompt asked while another send runs, or before
	// the transcript is loaded, waits instead of being lost.
	const pendingCellRequest = useWidgetGridStore((s) => s.pendingCellRequest);
	useEffect(() => {
		if (!pendingCellRequest || entry === null) return;
		const taken = takeExternal({
			text: pendingCellRequest.text,
			cellTarget: { x: pendingCellRequest.x, y: pendingCellRequest.y },
			origin: "cell",
		});
		if (taken) useWidgetGridStore.getState().clearPendingCellRequest();
	}, [pendingCellRequest, entry, status, takeExternal]);

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

	/** Delete a thread, including one this mount started (it is not in the hook's list yet). */
	const onDeleteThread = useCallback(
		(id: string) => {
			setStarted((prev) => prev.filter((t) => t.id !== id));
			deleteThread(id);
		},
		[deleteThread],
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
			? (shownThreads.find((t) => t.id === activeId)?.title ?? "New chat")
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
					onSend={sendPrompt}
					suggestions={suggestions}
					recents={shownThreads}
					onOpenThread={selectThread}
					showModel={isOrg}
					context={isOrg ? "org" : "project"}
					status={status}
					composerRef={composerRef}
					notice={orgNotReady ? <ChatError error={ORG_NOT_READY} /> : undefined}
				/>
			) : (
				<AgentChat
					messages={messages}
					status={status}
					error={visibleError}
					onSend={sendPrompt}
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
								onSend={sendPrompt}
								suggestions={suggestions}
								supportHref={supportHref}
							/>
						) : undefined
					}
				/>
			)}
		</ElenchErrorBoundary>
	);

	const chrome =
		view === "modal" ? (
			<ElenchModal
				isOrg={isOrg}
				threads={shownThreads}
				activeId={activeId}
				isEmpty={isEmpty}
				title={convoTitle}
				onSelectThread={selectThread}
				onNewChat={newChat}
				onDeleteThread={onDeleteThread}
				gallery={galleryNode}
				knowledge={knowledgeNode}
			>
				{body}
			</ElenchModal>
		) : (
			<ElenchPanel
				isOrg={isOrg}
				threads={shownThreads}
				activeId={activeId}
				onSelectThread={selectThread}
				onNewChat={newChat}
			>
				{body}
			</ElenchPanel>
		);

	return <ElenchDraftContext.Provider value={binding}>{chrome}</ElenchDraftContext.Provider>;
}
