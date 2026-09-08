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
			 * The environment the user is looking at (`?environment_id=`), or null for the project's
			 * default. The assistant's plan/deploy proposals and its Environment knowledge block are
			 * scoped to THIS — before it existed the project route planned and deployed the default
			 * environment whatever the topbar switcher said. Re-scoped in place by `syncEnvironment`;
			 * never part of the conversation lineage (threads are project-scoped).
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
function withKnownEnvironment(next: ElenchCtx, current: ElenchCtx): ElenchCtx {
	if (next.kind !== "project" || current.kind !== "project") return next;
	if (next.projectId !== current.projectId) return next;
	if (next.environmentId !== null) return next;
	return { ...next, environmentId: current.environmentId };
}

/** True when two contexts address the same conversation lineage. */
function sameCtx(a: ElenchCtx, b: ElenchCtx): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "project" && b.kind === "project")
		return a.projectId === b.projectId;
	return true;
}

interface ElenchState {
	/** Whether the surface is on screen at all. */
	open: boolean;
	/** Modal (fullscreen) vs panel (docked drawer). Flipping never remounts the chat. */
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

	/** Open as a docked panel in the given context. */
	openPanel: (ctx: ElenchCtx) => void;
	/** Open as a fullscreen modal in the given context. */
	openModal: (ctx: ElenchCtx) => void;
	/** Modal → panel (same conversation). */
	minimize: () => void;
	/** Panel → modal (same conversation). */
	maximize: () => void;
	/** Hide the surface (keeps ctx/thread cached for the next open). */
	close: () => void;
	/** Toggle the panel in the given context (used by the canvas AI button / ⌘K). */
	togglePanel: (ctx: ElenchCtx) => void;
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
	 * Attach a lazily-created thread id WITHOUT bumping `epoch` — used on the first send of an
	 * ephemeral conversation so the new id rides subsequent requests while the in-flight chat
	 * (and its just-sent message) survives intact.
	 */
	attachThread: (id: string) => void;
	/** Start a fresh conversation (ephemeral — nothing is persisted until the first send). */
	newChat: () => void;
	/** Stage a prompt to auto-send once into the next conversation. */
	setSeedPrompt: (prompt: string | null) => void;
	/** Record the resources @-referenced in the message about to be sent. */
	setPendingMentions: (mentions: Mention[]) => void;
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
	epoch: 0,
	seedPrompt: null,
	pendingMentions: [],
	railOpen: true,
	mainView: "chat",

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
			epoch: fresh ? cur.epoch + 1 : cur.epoch,
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
			epoch: fresh ? cur.epoch + 1 : cur.epoch,
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
		set((s) => ({ threadId: id, epoch: s.epoch + 1, mainView: "chat" as const })),
	attachThread: (id) => set({ threadId: id }),
	newChat: () =>
		set((s) => ({
			threadId: null,
			epoch: s.epoch + 1,
			mainView: "chat" as const,
		})),
	setSeedPrompt: (seedPrompt) => set({ seedPrompt }),
	setPendingMentions: (pendingMentions) => set({ pendingMentions }),
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
