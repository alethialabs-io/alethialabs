"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import type { AgentMode } from "@/lib/ai/tools";
import type { Mention } from "@/lib/ai/mentions";
import { track } from "@/lib/analytics/track";
import { AI_MODELS } from "@/lib/config/ai";

/**
 * Where Elench is anchored. Determines the streaming route, tool-set, thread
 * persistence, and the tool-render lanes — captured at open time and fixed until
 * the surface is reopened in a different context.
 */
export type ElenchCtx =
	| { kind: "org" }
	| {
			kind: "project";
			projectId: string;
			/**
			 * The slug for the project the CONVERSATION is anchored to, captured when the panel was
			 * opened. The scope chip used to read the slug out of the current pathname, so navigating
			 * to another project relabelled a conversation that was still anchored to the first one —
			 * a confidently wrong scope in the component whose job is to state the scope.
			 */
			projectSlug?: string;
			/**
			 * The environment the user is looking at (`?environment_id=`), or null for the project's
			 * DEFAULT. The assistant's plan/deploy proposals and its Environment knowledge block are
			 * scoped to THIS — before it existed the project route planned and deployed the default
			 * environment whatever the topbar switcher said. Re-scoped in place by `syncEnvironment`;
			 * never part of the conversation lineage (threads are project-scoped).
			 *
			 * `null` is an ANSWER, not an absence, and the difference is what `ElenchCtxRequest`
			 * exists to carry: a caller that reads the URL and finds no `?environment_id=` is saying
			 * "the default", and the panel must re-scope to it.
			 */
			environmentId: string | null;
	  };

/** Pure presentation: fullscreen dialog vs docked drawer. Orthogonal to `ctx`. */
export type ElenchView = "modal" | "panel";

/** Which surface the modal's main region is showing (mutually exclusive). */
export type ElenchMainView = "chat" | "artifacts" | "knowledge";

/**
 * The context to open with, given what the caller knows.
 *
 * A caller that cannot see the environment passes `null`, and that must not silently re-scope a
 * conversation that IS scoped: the topbar's Ask AI button knows the project from the route but not
 * always the environment, so toggling the panel closed and open again would have dropped the
 * environment the user had switched to and sent the next turn against the project default.
 * `null` means "I don't know"; only a real id re-scopes.
 */
/**
 * What an OPENER asks for. It differs from `ElenchCtx` in one place and that place was a defect:
 * `environmentId` may be omitted, meaning "I cannot see one from here".
 *
 * `null` and `undefined` were the same value before, and they are opposite answers. A caller that
 * read the URL and found no `?environment_id=` is saying THE DEFAULT; a caller with no way to know
 * — the create form, an org route — is saying nothing. Collapsing them meant the panel could never
 * be scoped back to the default: switch to prod, open Ask AI, click Jobs (which drops the query
 * string), open Ask AI again, and the assistant kept planning against production while the topbar
 * said otherwise. Reopening never fixed it. Found in review.
 */
export type ElenchCtxRequest =
	| { kind: "org" }
	| { kind: "project"; projectId: string; projectSlug?: string; environmentId?: string | null };

/** Fill in an environment only when the caller had no view of one. See `ElenchCtxRequest`. */
function withKnownEnvironment(next: ElenchCtxRequest, current: ElenchCtx): ElenchCtx {
	if (next.kind !== "project") return next;
	const asked = "environmentId" in next ? (next.environmentId ?? null) : undefined;
	if (asked !== undefined) return { ...next, environmentId: asked };
	if (current.kind === "project" && current.projectId === next.projectId) {
		return { ...next, environmentId: current.environmentId };
	}
	return { ...next, environmentId: null };
}

/**
 * True when two contexts address the same conversation lineage. The second side is a REQUEST,
 * because `togglePanel` asks this before the request has been resolved into a context — and it can
 * answer from `kind` and `projectId` alone, which both carry. The environment is deliberately not
 * part of it: threads are project-scoped, so switching environment re-scopes in place rather than
 * starting a new conversation.
 */
function sameCtx(a: ElenchCtx, b: ElenchCtxRequest): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "project" && b.kind === "project")
		return a.projectId === b.projectId;
	return true;
}

interface ElenchState {
	/** Whether the surface is on screen at all. */
	open: boolean;
	/**
	 * Modal (fullscreen) vs panel (docked drawer). Flipping keeps the transcript (the one `useChat`
	 * instance of the conversation); it DOES remount the composer, whose words live in the drafts
	 * store (ADR 0001), so a flip loses none of them.
	 */
	view: ElenchView;
	/** Org vs project anchor. Selects transport + tools. */
	ctx: ElenchCtx;
	/** Org agent mode: "ask" (read-only) vs "act" (may propose plan/deploy). */
	mode: AgentMode;
	/** Selected org model id (allowlisted in AI_MODELS). */
	model: string;
	/**
	 * Per-message "deep reasoning" opt-in — rides the request as `deepReasoning`. Only meaningful
	 * on the `ai_max` tier, where it swaps the planning advisor from Sonnet to Opus for that turn.
	 */
	deepReasoning: boolean;
	/** Active org thread id; null = a fresh (not-yet-persisted) conversation. */
	threadId: string | null;
	/**
	 * The conversation on screen (ADR 0001 §2): minted here by the client at New chat and whenever
	 * the context changes, and the thread id itself once a thread is selected or resumed. From the
	 * first send it IS the thread's id (`startConversation` stores the thread under it), and it keys
	 * the conversation's draft.
	 */
	conversationId: string;
	/**
	 * Bumped on every "new chat" so the conversation key changes even when
	 * `threadId` stays null (project conversations are ephemeral, keyed by epoch).
	 */
	epoch: number;
	/**
	 * A prompt handed off from elsewhere (e.g. the create-project hero's `?prompt=`),
	 * auto-sent once into a fresh conversation then cleared.
	 */
	seedPrompt: string | null;
	/** Resources @-referenced in the latest sent message (ride with the request). */
	pendingMentions: Mention[];
	/**
	 * Whether the modal's thread rail is expanded. Lives here (not in `ElenchModal`'s local
	 * state) so it survives a minimize→maximize round-trip — the modal remounts on every view
	 * flip, which would otherwise reset the rail to open.
	 */
	railOpen: boolean;
	/**
	 * What the modal's main region shows: the conversation, the Artifacts library, or the
	 * Knowledge panel (custom instructions + pinned knowledge for the current scope). One
	 * enum rather than a bag of booleans, so two panels can never be "open" at once.
	 */
	mainView: ElenchMainView;
	/**
	 * The org the page names: `currentActor().orgId` of the `[org]` layout (ADR 0003 §6.1), so the
	 * user id in community. The chat transport reads it at REQUEST time as the turn's `orgId`;
	 * null until the shell has mounted.
	 */
	pageOrgId: string | null;

	/** Open as a docked panel in the given context. */
	openPanel: (ctx: ElenchCtxRequest) => void;
	/** Open as a fullscreen modal in the given context. */
	openModal: (ctx: ElenchCtxRequest) => void;
	/** Modal → panel (same conversation). */
	minimize: () => void;
	/** Panel → modal (same conversation). */
	maximize: () => void;
	/** Hide the surface (keeps ctx/thread cached for the next open). */
	close: () => void;
	/** Toggle the panel in the given context (used by the canvas AI button / ⌘K). */
	togglePanel: (ctx: ElenchCtxRequest) => void;
	/**
	 * Re-scope an OPEN project conversation to another environment of the same project — the
	 * topbar switcher, Shift+Tab and a deep link all land here. Keeps the thread and the epoch:
	 * the environment is request context (the prompt is rebuilt per turn), not a new lineage.
	 * A no-op when the surface is closed, anchored to the org, or on another project.
	 */
	syncEnvironment: (projectId: string, environmentId: string | null) => void;

	setMode: (mode: AgentMode) => void;
	setModel: (model: string) => void;
	/** Toggle the per-message deep-reasoning (Opus) opt-in. */
	setDeepReasoning: (deepReasoning: boolean) => void;
	/** Expand/collapse the modal thread rail. */
	setRailOpen: (open: boolean) => void;
	/** Show/hide the Artifacts gallery in the modal's main region. */
	/** Switch the modal's main region (chat / artifacts / knowledge). */
	setMainView: (view: ElenchMainView) => void;
	/**
	 * Resume a persisted thread: point at it AND bump `epoch` so the chat lineage token
	 * changes, recreating the underlying chat with the resumed transcript (no chrome remount).
	 */
	selectThread: (id: string | null) => void;
	/**
	 * The INITIAL-LOAD resume of a persisted thread: point at it and bump `epoch`, exactly like
	 * `selectThread`, but leave `mainView` alone. The resume lands after two server round trips,
	 * and the rail (Artifacts, Knowledge) is clickable while it is in flight, so resetting the
	 * view here silently overrode a click the user made in that window (#5677). Opening from
	 * closed already lands on the chat (`openPanel`/`openModal`), so nothing is lost by not
	 * resetting it again. A user-initiated pick uses `selectThread`, which still resets.
	 */
	resumeThread: (id: string) => void;
	/**
	 * Attach a lazily-created thread id WITHOUT bumping `epoch` — used once a conversation's first
	 * turn is stored, so the id rides subsequent requests while the in-flight chat (and its
	 * just-sent message) survives intact. The id becomes the conversation id too: it is already,
	 * for a thread `startConversation` stored under it.
	 */
	attachThread: (id: string) => void;
	/**
	 * Start a fresh conversation under a newly minted conversation id (ephemeral: nothing is
	 * persisted until its draft is saved or its first message sent).
	 */
	newChat: () => void;
	/**
	 * Show `id` as the conversation on screen, right after `newChat`: the drafts store moved the
	 * words of a send it could not deliver into this new conversation (ADR 0001 D18).
	 */
	followConversation: (id: string) => void;
	/** Stage a prompt to auto-send once into the next conversation. */
	setSeedPrompt: (prompt: string | null) => void;
	/** Record the resources @-referenced in the message about to be sent. */
	setPendingMentions: (mentions: Mention[]) => void;
	/** Record the page's org (the `[org]` layout's `currentActor().orgId`). */
	setPageOrgId: (orgId: string | null) => void;
}

/**
 * A fresh conversation id (ADR 0001 §2): 122 random bits, never put in a URL, a log line or an
 * analytics event before its first send commits (ADR 0001 Q1's security note).
 */
function mintConversationId(): string {
	return crypto.randomUUID();
}

/**
 * The single Elench surface store. One conversation is presented as either a
 * fullscreen modal (with thread rail + artifact panel for the org context) or a
 * docked drawer; minimize/maximize only flip `view`, so the underlying
 * `useAgentChat` instance survives with its messages intact. Replaces the legacy
 * `use-assistant-store` (the project assistant is now this surface in panel view).
 */
export const useElenchStore = create<ElenchState>((set, get) => ({
	open: false,
	view: "panel",
	ctx: { kind: "org" },
	mode: "ask",
	model: AI_MODELS[0].id,
	deepReasoning: false,
	threadId: null,
	conversationId: mintConversationId(),
	epoch: 0,
	seedPrompt: null,
	pendingMentions: [],
	railOpen: true,
	mainView: "chat",
	pageOrgId: null,

	openPanel: (raw) => {
		const cur = get();
		const ctx = withKnownEnvironment(raw, cur.ctx);
		// Switching context starts a fresh conversation (org tools must not bleed
		// into a project conversation and vice-versa).
		const fresh = !sameCtx(cur.ctx, ctx);
		track("elench_chat_opened", { context: ctx.kind, view: "panel" });
		set({
			open: true,
			view: "panel",
			ctx,
			threadId: fresh ? null : cur.threadId,
			conversationId: fresh ? mintConversationId() : cur.conversationId,
			epoch: fresh ? cur.epoch + 1 : cur.epoch,
			// Opening from closed lands on the conversation (the initial resume no longer resets
			// the view — see `resumeThread`); an already-open surface keeps what it shows.
			mainView: cur.open ? cur.mainView : "chat",
		});
	},

	openModal: (raw) => {
		const cur = get();
		const ctx = withKnownEnvironment(raw, cur.ctx);
		const fresh = !sameCtx(cur.ctx, ctx);
		track("elench_chat_opened", { context: ctx.kind, view: "modal" });
		set({
			open: true,
			view: "modal",
			ctx,
			threadId: fresh ? null : cur.threadId,
			conversationId: fresh ? mintConversationId() : cur.conversationId,
			epoch: fresh ? cur.epoch + 1 : cur.epoch,
			// Opening from closed lands on the conversation (the initial resume no longer resets
			// the view — see `resumeThread`); an already-open surface keeps what it shows.
			mainView: cur.open ? cur.mainView : "chat",
		});
	},

	// The gallery is a modal-only surface — collapsing to the panel always leaves it.
	minimize: () => set({ view: "panel", mainView: "chat" }),
	maximize: () => set({ view: "modal" }),
	close: () => set({ open: false }),

	togglePanel: (ctx) => {
		const cur = get();
		if (cur.open && sameCtx(cur.ctx, ctx)) set({ open: false });
		else get().openPanel(ctx);
	},

	syncEnvironment: (projectId, environmentId) => {
		const cur = get();
		if (!cur.open || cur.ctx.kind !== "project" || cur.ctx.projectId !== projectId)
			return;
		if (cur.ctx.environmentId === environmentId) return;
		set({ ctx: { ...cur.ctx, environmentId } });
	},

	setMode: (mode) => set({ mode }),
	setModel: (model) => set({ model }),
	setDeepReasoning: (deepReasoning) => set({ deepReasoning }),
	setRailOpen: (railOpen) => set({ railOpen }),
	setMainView: (mainView) => set({ mainView }),
	// Selecting a thread / starting a new chat returns to the conversation view.
	selectThread: (id) =>
		set((s) => ({
			threadId: id,
			conversationId: id ?? mintConversationId(),
			epoch: s.epoch + 1,
			mainView: "chat" as const,
		})),
	// The initial resume: same lineage bump as `selectThread`, but the view is left as it is.
	resumeThread: (id) => set((s) => ({ threadId: id, conversationId: id, epoch: s.epoch + 1 })),
	attachThread: (id) => set({ threadId: id, conversationId: id }),
	newChat: () =>
		set((s) => ({
			threadId: null,
			conversationId: mintConversationId(),
			epoch: s.epoch + 1,
			mainView: "chat" as const,
		})),
	followConversation: (id) => set({ conversationId: id }),
	setSeedPrompt: (seedPrompt) => set({ seedPrompt }),
	setPendingMentions: (pendingMentions) => set({ pendingMentions }),
	setPageOrgId: (pageOrgId) => set({ pageOrgId }),
}));

/**
 * The chat lineage token — a stable id for the underlying `useChat` instance, derived from
 * the context anchor + `epoch` (NOT the live `threadId`). It changes on new-chat / resume
 * (both bump `epoch`), recreating the chat with fresh/loaded messages, but stays put on a
 * lazy thread-attach and on a modal↔panel `view` flip — so an in-flight send survives and
 * the chrome never remounts.
 */
export function elenchChatId(ctx: ElenchCtx, epoch: number): string {
	const anchor = ctx.kind === "project" ? `project:${ctx.projectId}` : "org";
	return `${anchor}:${epoch}`;
}
