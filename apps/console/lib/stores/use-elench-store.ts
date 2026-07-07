"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import type { AgentMode } from "@/lib/ai/tools";
import type { Mention } from "@/lib/ai/mentions";
import { AI_MODELS } from "@/lib/config/ai";

/**
 * Where Elench is anchored. Determines the streaming route, tool-set, thread
 * persistence, and the tool-render lanes — captured at open time and fixed until
 * the surface is reopened in a different context.
 */
export type ElenchCtx = { kind: "org" } | { kind: "project"; projectId: string };

/** Pure presentation: fullscreen dialog vs docked drawer. Orthogonal to `ctx`. */
export type ElenchView = "modal" | "panel";

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

	setMode: (mode: AgentMode) => void;
	setModel: (model: string) => void;
	/** Expand/collapse the modal thread rail. */
	setRailOpen: (open: boolean) => void;
	/** Resume a persisted org thread. */
	selectThread: (id: string | null) => void;
	/** Start a fresh conversation (org: unnamed thread; project: new ephemeral). */
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
	threadId: null,
	epoch: 0,
	seedPrompt: null,
	pendingMentions: [],
	railOpen: true,

	openPanel: (ctx) => {
		const cur = get();
		// Switching context starts a fresh conversation (org tools must not bleed
		// into a project conversation and vice-versa).
		const fresh = !sameCtx(cur.ctx, ctx);
		set({
			open: true,
			view: "panel",
			ctx,
			threadId: fresh ? null : cur.threadId,
			epoch: fresh ? cur.epoch + 1 : cur.epoch,
		});
	},

	openModal: (ctx) => {
		const cur = get();
		const fresh = !sameCtx(cur.ctx, ctx);
		set({
			open: true,
			view: "modal",
			ctx,
			threadId: fresh ? null : cur.threadId,
			epoch: fresh ? cur.epoch + 1 : cur.epoch,
		});
	},

	minimize: () => set({ view: "panel" }),
	maximize: () => set({ view: "modal" }),
	close: () => set({ open: false }),

	togglePanel: (ctx) => {
		const cur = get();
		if (cur.open && sameCtx(cur.ctx, ctx)) set({ open: false });
		else get().openPanel(ctx);
	},

	setMode: (mode) => set({ mode }),
	setModel: (model) => set({ model }),
	setRailOpen: (railOpen) => set({ railOpen }),
	selectThread: (id) => set({ threadId: id }),
	newChat: () => set((s) => ({ threadId: null, epoch: s.epoch + 1 })),
	setSeedPrompt: (seedPrompt) => set({ seedPrompt }),
	setPendingMentions: (pendingMentions) => set({ pendingMentions }),
}));

/** Stable key for the conversation lineage — excludes `view` (so a modal↔panel
 * flip never remounts the chat) and includes ctx + thread + epoch. */
export function elenchConversationKey(
	ctx: ElenchCtx,
	threadId: string | null,
	epoch: number,
): string {
	const anchor = ctx.kind === "project" ? `project:${ctx.projectId}` : "org";
	return `${anchor}:${threadId ?? "ephemeral"}:${epoch}`;
}
