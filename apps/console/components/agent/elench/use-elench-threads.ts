"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createThread,
	deleteThread as deleteThreadAction,
	type FirstTurn,
	getThread,
	listThreads,
} from "@/app/server/actions/agent";
import { track } from "@/lib/analytics/track";
import type { AgentThread } from "@/lib/db/schema";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";
import { useElenchStore } from "@/lib/stores/use-elench-store";

/**
 * Thread orchestration for the Elench surface, in BOTH contexts: lists the owner's
 * threads (for the modal rail + panel switcher), resumes the most recent on open (or
 * falls back to an EMPTY ephemeral conversation), and loads a thread's transcript
 * BEFORE switching so the chat recreates with the right `initialMessages`. Nothing is
 * persisted until the first send — `startThread` lazily inserts the thread then, so a
 * "New chat" never litters the rail with empty rows. Org context lists org-level threads
 * (project_id IS NULL); project context lists + creates threads scoped to the project id.
 */
export function useElenchThreads() {
	const open = useElenchStore((s) => s.open);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const selectStore = useElenchStore((s) => s.selectThread);
	const resumeStore = useElenchStore((s) => s.resumeThread);
	const attachStore = useElenchStore((s) => s.attachThread);
	const newChatStore = useElenchStore((s) => s.newChat);

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

	// Initial load: list threads (org-level or this project's) and resume the most recent.
	// An empty list resolves to an EMPTY ephemeral conversation — nothing is persisted until
	// the first send (see `startThread`).
	//
	// `threadId` must NOT be a dep here: resuming calls `resumeStore(id)`, which changes the
	// store's threadId — as a dep that re-ran this effect, and its cleanup flipped `cancelled`
	// so `setInitialResolved(true)` never landed, wedging the body on its loading skeleton.
	// It only reproduces once a thread exists (an empty list never resumes), which is how it
	// survived until the AI e2e suite drove a second conversation.
	//
	// The resume goes through `resumeThread`, NOT `selectThread`: the rail is interactive while
	// these two round trips are in flight, and `selectThread` resets `mainView` to the chat — a
	// click on Artifacts/Knowledge in that window was silently snapped back (#5677). The same
	// window allows a user-initiated thread pick or "New chat", both of which bump `epoch`; the
	// epoch captured before the list is compared after EACH round trip, and a changed one means
	// the user has already chosen, so the resume stands down rather than overriding them.
	//
	// The effect runs once per (open, context) — `resumeStore` is a stable zustand action, so
	// it never re-runs on its own account — and there is deliberately no "already loaded" flag.
	// A context switch on an OPEN surface (`openPanel`/`openModal` with another project, or org ↔
	// project) changes `projectId`; the cleanup stands the old context's load down and this body
	// runs again for the new one, exactly as opening from closed in that context would: skeleton,
	// list, resume the newest, else the empty landing (#5680). A once-per-open flag used to make
	// that re-run return early, so a switch mid-load left the body on its skeleton forever, and a
	// switch after the load kept the previous context's threads in the rail.
	//
	// `cancelled` is checked after EACH round trip, not only the first: closing the surface also
	// runs the cleanup, and a transcript that arrives after the close must not write the resume
	// into a store nobody is looking at (#5680). Closing does not bump `epoch`, so the user-acted
	// guard alone let it through.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const startEpoch = useElenchStore.getState().epoch;
		/** True once the user has picked a thread or started a new chat since the load began. */
		const userActed = () => useElenchStore.getState().epoch !== startEpoch;
		(async () => {
			const list = await listThreads(projectId);
			if (cancelled) return;
			setThreads(list);
			const resume = resumeIdRef.current ?? list[0]?.id;
			if (resume && !userActed()) {
				const full = await getThread(resume);
				if (cancelled) return;
				if (!userActed()) {
					setInitialMessages(full?.messages ?? []);
					setInitialRevision(full?.revision ?? null);
					resumeStore(resume);
				}
			} else if (!resume && !userActed()) {
				// Nothing to resume → the empty landing. Clear the transcript a previous context (or
				// a previous open) staged, or the new conversation would be seeded with it.
				setInitialMessages([]);
				setInitialRevision(null);
			}
			setInitialResolved(true);
		})();
		return () => {
			cancelled = true;
			// Besides unmount (where the reset is moot), the cleanup runs on the two events that
			// invalidate this resolution — the surface closing and the context switching — so the body is back on its skeleton
			// until the next load settles: a reopen re-resumes cleanly, and a switch shows the
			// new context the way a fresh open there would.
			setInitialResolved(false);
		};
	}, [open, projectId, resumeStore]);

	/** Resume a persisted thread (loads its transcript first). */
	const selectThread = useCallback(
		(id: string) => {
			void loadInto(id);
		},
		[loadInto],
	);

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
		selectThread,
		/** Reload a thread's transcript (and its revision) in place of the current one. */
		reloadThread: loadInto,
		newChat,
		startThread,
		deleteThread,
	};
}
