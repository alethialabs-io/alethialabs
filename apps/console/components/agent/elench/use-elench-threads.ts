"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { createStore } from "zustand/vanilla";
import {
	createThread,
	deleteThread as deleteThreadAction,
	type FirstTurn,
	getThread,
	listThreads,
} from "@/app/server/actions/agent";
import { countDraftsOfConversation } from "@/app/server/actions/elench-drafts";
import { track } from "@/lib/analytics/track";
import type { AgentThread } from "@/lib/db/schema";
import type { DraftThreadStatus } from "@/lib/elench/draft-outcomes";
import { initialDraftsStore } from "@/lib/stores/elench-drafts/reducer";
import { keyId, scopeId, shownContent } from "@/lib/stores/elench-drafts/reducer-drafting";
import { isUnacknowledged, selectUnsent } from "@/lib/stores/elench-drafts/selectors";
import type { DraftsView } from "@/lib/stores/elench-drafts/store";
import type { DraftEntry, DraftScope } from "@/lib/stores/elench-drafts/types";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { type DraftsTab, useDraftsTab } from "./elench-drafts-root";

/**
 * Why the initial resolution could not load what it was resuming (G10): `listThreads` or the
 * resume's `getThread` rejected. The surface is no longer on its skeleton; `retryLoad` runs the
 * resolution again.
 */
export interface ElenchThreadsLoadError {
	/** Which round trip failed. */
	step: "list" | "resume";
	/** The conversation the resume was for, when it was the resume that failed. */
	conversationId: string | null;
}

/** The drafts scope the surface shows: the page's org and the conversation's anchor (ADR 0001 §2). */
function useSurfaceScope(): DraftScope | null {
	const pageOrgId = useElenchStore((s) => s.pageOrgId);
	const projectId = useElenchStore((s) => (s.ctx.kind === "project" ? s.ctx.projectId : null));
	return useMemo(
		() => (pageOrgId === null ? null : { orgId: pageOrgId, projectId }),
		[pageOrgId, projectId],
	);
}

/** The entry of `conversationId` in `scope`, when this tab holds one. */
function entryOf(tab: DraftsTab | null, scope: DraftScope | null, conversationId: string): DraftEntry | null {
	if (tab === null || scope === null) return null;
	return tab.store.view.getState().drafts.entries[keyId({ ...scope, conversationId })] ?? null;
}

/** True when the conversation has no stored transcript to load: never sent, reaped, or deleted (G21). */
function hasNoThread(entry: DraftEntry | null): boolean {
	return entry !== null && (entry.thread === "none" || entry.thread === "deleted");
}

/**
 * Thread orchestration for the Elench surface, in BOTH contexts: lists the owner's threads (for the
 * modal rail and the panel switcher), resumes the conversation the user was last on in this scope
 * (the drafts store's `activeKey[scope]`, ADR 0001 D23 and §7.3; else the most recent thread; else
 * an EMPTY conversation), and loads a thread's transcript BEFORE switching so the chat recreates
 * with the right `initialMessages`. A conversation with no stored thread (never sent, or its thread
 * was reaped) is opened without `getThread` (G21): its words are its draft. A failed list or resume
 * leaves the skeleton with `loadError` set instead of wedging it (G10). Org context lists org-level
 * threads (project_id IS NULL); project context lists threads scoped to the project id.
 */
export function useElenchThreads() {
	const open = useElenchStore((s) => s.open);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const selectStore = useElenchStore((s) => s.selectThread);
	const resumeStore = useElenchStore((s) => s.resumeThread);
	const attachStore = useElenchStore((s) => s.attachThread);
	const newChatStore = useElenchStore((s) => s.newChat);
	const tab = useDraftsTab();
	const scope = useSurfaceScope();

	// The project this surface is scoped to (undefined in org context) — threads are
	// listed/created against it so a project's conversations persist independently.
	const projectId = ctx.kind === "project" ? ctx.projectId : undefined;
	const [threads, setThreads] = useState<AgentThread[]>([]);
	const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
	// The revision `initialMessages` was read at (ADR 0003 §9.1): the transport's base revision
	// for the next send. Null for an ephemeral conversation; `startThread`'s caller seeds it.
	const [initialRevision, setInitialRevision] = useState<number | null>(null);
	// Whether the initial resolution (list → resume/create) has settled. Until it has,
	// the surface must NOT mount the keyed conversation: threadId is still null, so mounting
	// now and flipping it to the resumed thread would remount the whole chat (the open flash).
	const [initialResolved, setInitialResolved] = useState(false);
	const [loadError, setLoadError] = useState<ElenchThreadsLoadError | null>(null);
	// Bumped by `retryLoad`, so the resolution effect runs again for the same open and context.
	const [loadAttempt, setLoadAttempt] = useState(0);

	/** Load a thread's transcript, then switch to it (order matters — the conversation
	 * is keyed by threadId, so messages must be staged before the key flips). */
	const loadInto = useCallback(
		async (id: string) => {
			const full = await getThread(id);
			setInitialMessages(full?.messages ?? []);
			setInitialRevision(full?.revision ?? null);
			selectStore(id);
			return full;
		},
		[selectStore],
	);

	// The thread to resume, mirrored into a ref so the initial-load effect can read it
	// WITHOUT taking it as a dependency (see the effect below). Declared first so it is
	// populated before that effect runs on mount.
	const resumeIdRef = useRef<string | null>(threadId);
	useEffect(() => {
		resumeIdRef.current = threadId;
	}, [threadId]);

	// The conversation this tab last showed in the scope (ADR 0001 §7.3): the store's in-memory
	// `activeKey[scope]`, else this tab's `sessionStorage` mirror of it (a reload). Read while
	// RENDERING the open (or the context change), because the conversation mounted in the same
	// commit selects its own key in an effect that runs before this hook's (a child's effects run
	// first), and that selection overwrites both. Captured once per (open, scope).
	const remembered = useMemo(() => {
		if (!open || tab === null || scope === null) return null;
		return tab.store.view.getState().drafts.activeKey[scopeId(scope)] ?? tab.store.readActive(scope);
	}, [open, tab, scope]);

	// Initial load: list threads (org-level or this project's) and resume the conversation the user
	// was last on here; else the most recent thread; else an EMPTY ephemeral conversation —
	// nothing is persisted until the first send.
	//
	// `threadId` must NOT be a dep here: resuming calls `resumeStore(id)`, which changes the
	// store's threadId — as a dep that re-ran this effect, and its cleanup flipped `cancelled`
	// so `setInitialResolved(true)` never landed, wedging the body on its loading skeleton.
	//
	// The resume goes through `resumeThread`, NOT `selectThread`: the rail is interactive while
	// these two round trips are in flight, and `selectThread` resets `mainView` to the chat — a
	// click on Artifacts/Knowledge in that window was silently snapped back (#5677). The same
	// window allows a user-initiated thread pick or "New chat", both of which bump `epoch`; the
	// epoch captured before the list is compared after EACH round trip, and a changed one means
	// the user has already chosen, so the resume stands down rather than overriding them.
	//
	// A context switch on an OPEN surface changes `projectId`; the cleanup stands the old context's
	// load down and this body runs again for the new one, exactly as opening from closed in that
	// context would (#5680), and resumes the new scope's own remembered conversation (D23).
	//
	// `cancelled` is checked after EACH round trip: closing the surface also runs the cleanup, and a
	// transcript that arrives after the close must not write the resume into a store nobody is
	// looking at (#5680).
	//
	// Either round trip may reject (G10). A rejected list leaves the rail as it was; a rejected
	// resume leaves the conversation on screen as it was. Both set `loadError` and still resolve,
	// so the body leaves its skeleton.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const startEpoch = useElenchStore.getState().epoch;
		/** True once the user has picked a thread or started a new chat since the load began. */
		const userActed = () => useElenchStore.getState().epoch !== startEpoch;
		/** Shows a conversation that has no stored thread, without resetting the main view. */
		const openThreadless = (id: string) => {
			setInitialMessages([]);
			setInitialRevision(null);
			const s = useElenchStore.getState();
			if (s.conversationId === id && s.threadId === null) return;
			useElenchStore.setState({ threadId: null, conversationId: id, epoch: s.epoch + 1 });
		};
		(async () => {
			setLoadError(null);
			let list: AgentThread[] | null = null;
			try {
				list = await listThreads(projectId);
			} catch {
				if (cancelled) return;
				setLoadError({ step: "list", conversationId: null });
			}
			if (cancelled) return;
			if (list !== null) setThreads(list);
			const resume = remembered ?? resumeIdRef.current ?? list?.[0]?.id ?? null;
			if (resume !== null && !userActed()) {
				const listed = list?.some((t) => t.id === resume) ?? false;
				if (!listed && hasNoThread(entryOf(tab, scope, resume))) {
					openThreadless(resume);
				} else {
					try {
						const full = await getThread(resume);
						if (cancelled) return;
						if (!userActed()) {
							if (full === null) openThreadless(resume);
							else {
								setInitialMessages(full.messages);
								setInitialRevision(full.revision);
								resumeStore(resume);
							}
						}
					} catch {
						if (cancelled) return;
						setLoadError({ step: "resume", conversationId: resume });
					}
				}
			} else if (resume === null && !userActed()) {
				// Nothing to resume → the empty landing. Clear the transcript a previous context (or
				// a previous open) staged, or the new conversation would be seeded with it.
				setInitialMessages([]);
				setInitialRevision(null);
			}
			setInitialResolved(true);
		})();
		return () => {
			cancelled = true;
			// Besides unmount (where the reset is moot), the cleanup runs on the events that
			// invalidate this resolution — the surface closing, the context switching, a retry — so
			// the body is back on its skeleton until the next load settles.
			setInitialResolved(false);
		};
	}, [open, projectId, resumeStore, tab, scope, remembered, loadAttempt]);

	/** Runs the initial resolution again after it failed (G10). */
	const retryLoad = useCallback(() => setLoadAttempt((n) => n + 1), []);

	/** Reset to a fresh EPHEMERAL conversation — clears the transcript and bumps the chat
	 * lineage (via the store's `newChat`). Persists nothing; the thread is created lazily on
	 * the first send. Also collapses the split pane: the fresh chat has no widgets, and the
	 * empty state hides the grid toggle — leaving it open would strand the grid with no way
	 * to close it. */
	const newChat = useCallback(() => {
		setInitialMessages([]);
		setInitialRevision(null);
		useArtifactStore.getState().closeGrid();
		useArtifactStore.getState().close();
		newChatStore();
	}, [newChatStore]);

	/**
	 * Open a conversation: a stored thread loads its transcript first; one this tab's drafts know has
	 * no stored thread (an Unsent entry that was never sent, or whose thread was reaped or deleted)
	 * opens at once under its own id, with no `getThread` (G21).
	 */
	const selectThread = useCallback(
		(id: string) => {
			const listed = threads.some((t) => t.id === id);
			if (!listed && hasNoThread(entryOf(tab, scope, id))) {
				newChat();
				useElenchStore.getState().followConversation(id);
				return;
			}
			void loadInto(id).catch(() => setLoadError({ step: "resume", conversationId: id }));
		},
		[threads, tab, scope, newChat, loadInto],
	);

	/** Lazily persist the current ephemeral conversation on its first message: inserts the
	 * thread (title derived from `title`), adds it to the rail, and attaches its id to the
	 * store WITHOUT bumping the epoch — so the in-flight send rides the new id and the chat
	 * instance (with the just-sent message) is not recreated. `firstTurn` is the user message
	 * itself, stored with the row so it survives a turn that fails before any reply exists;
	 * omitted (an artifact opened in a new chat), the thread starts with no transcript. */
	const startThread = useCallback(
		async (title: string, firstTurn?: FirstTurn): Promise<AgentThread> => {
			const t = await createThread(title, projectId, firstTurn);
			track("elench_thread_created", { context: projectId ? "project" : "org" });
			setThreads((prev) => [t, ...prev]);
			attachStore(t.id);
			return t;
		},
		[projectId, attachStore],
	);

	/** Delete a thread; reselect a neighbor (or reset to ephemeral) if it was active. */
	const deleteThread = useCallback(
		async (id: string) => {
			await deleteThreadAction(id);
			const remaining = threads.filter((t) => t.id !== id);
			setThreads(remaining);
			if (threadId === id) {
				if (remaining.length > 0) await loadInto(remaining[0].id);
				else newChat();
			}
		},
		[threads, threadId, loadInto, newChat],
	);

	return {
		// Ready once the initial list → resume settles (both contexts). The surface renders
		// a skeleton until then, inside the same chrome — so the chat resolves in place with
		// no open→resume flash and the panel's open animation runs exactly once.
		ready: initialResolved,
		threads,
		activeId: threadId,
		initialMessages,
		initialRevision,
		/** Why the initial resolution failed, or null (G10). */
		loadError,
		retryLoad,
		selectThread,
		/** Reload a thread's transcript (and its revision) in place of the current one. */
		reloadThread: loadInto,
		newChat,
		startThread,
		deleteThread,
	};
}

// ── The Unsent group (ADR 0001 decision 3, §7.4) ────────────────────────────────────────────────

/** What is true of an Unsent conversation beyond holding words that were never sent. */
export type UnsentNote =
	/** A send of it is in flight in this tab, or another tab or device holds its claim. */
	| "sending"
	/** A send of it failed; the words are back in its box. */
	| "not-sent"
	/** The server has not acknowledged what this tab holds for it (§7.4). */
	| "not-saved"
	/** Its thread existed once and has since been reaped (AC15). */
	| "unavailable"
	/** Its thread was deleted. */
	| "deleted";

/** What an Unsent entry says about itself, in the rail and in the switcher alike. */
export const UNSENT_NOTE_TEXT: Record<UnsentNote, string> = {
	sending: "Sending…",
	"not-sent": "Not sent",
	"not-saved": "Not saved",
	unavailable: "No longer available",
	deleted: "Conversation deleted",
};

/** The note an Unsent entry with nothing pressing to say shows: it is a draft. */
export function unsentNoteText(note: UnsentNote | null): string {
	return note === null ? "Draft" : UNSENT_NOTE_TEXT[note];
}

/** One row of the Unsent group: a conversation of the surface's scope that holds unsent words. */
export interface UnsentConversation {
	conversationId: string;
	/** The thread's title, else the first line of the words, else what it holds. */
	label: string;
	note: UnsentNote | null;
	thread: DraftThreadStatus;
	/** The conversation on screen. */
	active: boolean;
}

/** The view a surface without a drafts store reads: no entries, ever. */
const NO_DRAFTS = createStore<DraftsView>(() => ({
	drafts: initialDraftsStore(null),
	uncached: {},
	notices: [],
}));

const NONE: DraftEntry[] = [];

/** The words an Unsent row is named by: what is being sent, else what the box shows. */
function wordsOf(entry: DraftEntry): { text: string; artifacts: number } {
	if (entry.sending !== null && entry.sending.text.trim() !== "")
		return { text: entry.sending.text, artifacts: 0 };
	const c = shownContent(entry);
	return { text: c.text, artifacts: c.artifacts.length };
}

/** The label of one Unsent row (see `UnsentConversation.label`). */
function labelOf(entry: DraftEntry, title: string | null): string {
	if (title !== null && title.trim() !== "") return title;
	const { text, artifacts } = wordsOf(entry);
	const line = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l !== "");
	if (line !== undefined) return line;
	if (artifacts === 1) return "New chat with an artifact";
	if (artifacts > 1) return `New chat with ${artifacts} artifacts`;
	return "New chat";
}

/** The note of one Unsent row, the most pressing first. */
function noteOf(entry: DraftEntry): UnsentNote | null {
	if (entry.claiming !== null || entry.sending !== null || entry.server?.state === "sending")
		return "sending";
	if (entry.thread === "none" && entry.server?.threadSeen === true) return "unavailable";
	if (entry.thread === "deleted") return "deleted";
	if (entry.pendingFailedSend !== null || (entry.server?.failedSend ?? null) !== null)
		return "not-sent";
	if (isUnacknowledged(entry)) return "not-saved";
	return null;
}

/**
 * The Unsent group of the surface's scope (ADR 0001 §7.4): every conversation this tab's drafts
 * store holds unsent words for, in the store's stable order. `threads` names the listed ones by
 * their rail title. Empty without a drafts store (a surface outside the drafts root).
 */
export function useUnsentConversations(threads: readonly AgentThread[]): UnsentConversation[] {
	const tab = useDraftsTab();
	const scope = useSurfaceScope();
	const conversationId = useElenchStore((s) => s.conversationId);
	const entries = useStore(
		tab?.store.view ?? NO_DRAFTS,
		useShallow((s: DraftsView) => (scope === null ? NONE : selectUnsent(s, scope))),
	);
	return useMemo(
		() =>
			entries.map((e) => {
				const id = e.key.conversationId;
				const title = threads.find((t) => t.id === id)?.title ?? e.server?.title ?? null;
				return {
					conversationId: id,
					label: labelOf(e, title),
					note: noteOf(e),
					thread: e.thread,
					active: id === conversationId,
				};
			}),
		[entries, threads, conversationId],
	);
}

/** What the delete confirm says about a conversation's drafts (§6.3). */
export interface ConversationDraftFacts {
	/** The caller's drafts of the conversation, across every org. */
	count: number;
	/** In how many orgs. */
	orgs: number;
	/** A message of it is being sent right now, as far as this tab knows (R8). */
	sending: boolean;
}

/**
 * The delete confirm's count (§6.3): `countDraftsOfConversation` for the conversation, and whether
 * this tab knows of a message of it being sent (its own claim or send, or a row the last
 * `listDrafts` returned as `sending`). Resolves null when the count was refused or failed.
 */
export function useConversationDraftFacts(): (id: string) => Promise<ConversationDraftFacts | null> {
	const tab = useDraftsTab();
	const pageOrgId = useElenchStore((s) => s.pageOrgId);
	return useCallback(
		async (id: string) => {
			const sending =
				tab !== null &&
				Object.values(tab.store.view.getState().drafts.entries).some(
					(e) =>
						e.key.conversationId === id &&
						(e.claiming !== null ||
							e.sending !== null ||
							e.server?.state === "sending" ||
							e.conflict?.kind === "claimed"),
				);
			try {
				const result = await countDraftsOfConversation(
					pageOrgId === null ? { id } : { id, orgHint: pageOrgId },
				);
				if (result.outcome !== "ok") return null;
				return { count: result.count, orgs: result.orgs, sending };
			} catch {
				return null;
			}
		},
		[tab, pageOrgId],
	);
}
