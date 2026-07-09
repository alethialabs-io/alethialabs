"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createThread,
	deleteThread as deleteThreadAction,
	getThread,
	listThreads,
} from "@/app/server/actions/agent";
import { track } from "@/lib/analytics/track";
import type { AgentThread } from "@/lib/db/schema";
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
	const attachStore = useElenchStore((s) => s.attachThread);
	const newChatStore = useElenchStore((s) => s.newChat);

	// The project this surface is scoped to (undefined in org context) — threads are
	// listed/created against it so a project's conversations persist independently.
	const projectId = ctx.kind === "project" ? ctx.projectId : undefined;
	const [threads, setThreads] = useState<AgentThread[]>([]);
	const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
	const initialized = useRef(false);
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
			selectStore(id);
		},
		[selectStore],
	);

	// Initial load: list threads (org-level or this project's) and resume the most recent.
	// An empty list resolves to an EMPTY ephemeral conversation — nothing is persisted until
	// the first send (see `startThread`).
	useEffect(() => {
		if (!open || initialized.current) return;
		initialized.current = true;
		let cancelled = false;
		(async () => {
			const list = await listThreads(projectId);
			if (cancelled) return;
			setThreads(list);
			if (threadId) {
				await loadInto(threadId);
			} else if (list.length > 0) {
				await loadInto(list[0].id);
			}
			// else: leave threadId null + initialMessages empty → the ephemeral landing.
			if (!cancelled) setInitialResolved(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [open, projectId, threadId, loadInto]);

	// Reset when the surface closes so reopening re-resumes cleanly.
	useEffect(() => {
		if (!open) {
			initialized.current = false;
			setInitialResolved(false);
		}
	}, [open]);

	/** Resume a persisted thread (loads its transcript first). */
	const selectThread = useCallback(
		(id: string) => {
			void loadInto(id);
		},
		[loadInto],
	);

	/** Reset to a fresh EPHEMERAL conversation — clears the transcript and bumps the chat
	 * lineage (via the store's `newChat`). Persists nothing; the thread is created lazily on
	 * the first send. */
	const newChat = useCallback(() => {
		setInitialMessages([]);
		newChatStore();
	}, [newChatStore]);

	/** Lazily persist the current ephemeral conversation on its first message: inserts the
	 * thread (title derived from `firstMessage`), adds it to the rail, and attaches its id to
	 * the store WITHOUT bumping the epoch — so the in-flight send rides the new id and the
	 * chat instance (with the just-sent message) is not recreated. */
	const startThread = useCallback(
		async (firstMessage: string): Promise<AgentThread> => {
			const t = await createThread(firstMessage, projectId);
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
		selectThread,
		newChat,
		startThread,
		deleteThread,
	};
}
