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
	renameThread,
} from "@/app/server/actions/agent";
import type { AgentThread } from "@/lib/db/schema";
import { useElenchStore } from "@/lib/stores/use-elench-store";

/**
 * Thread orchestration for the Elench surface, in BOTH contexts: lists the owner's
 * threads (for the modal rail + panel switcher), resumes the most recent on open (or
 * starts a fresh one), and loads a thread's transcript BEFORE switching so the keyed
 * conversation mounts with the right `initialMessages`. Org context lists org-level
 * threads (project_id IS NULL); project context lists + creates threads scoped to the
 * project id, so project conversations persist and resume just like org ones. Lifted
 * from the former `AgentPage`.
 */
export function useElenchThreads() {
	const open = useElenchStore((s) => s.open);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const selectStore = useElenchStore((s) => s.selectThread);

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

	// Initial load: list threads (org-level or this project's), resume the most recent,
	// or create a fresh one.
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
			} else {
				const t = await createThread(undefined, projectId);
				if (cancelled) return;
				setThreads([t]);
				setInitialMessages([]);
				selectStore(t.id);
			}
			if (!cancelled) setInitialResolved(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [open, projectId, threadId, loadInto, selectStore]);

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

	/** Start a fresh conversation — a new persisted thread in the current scope
	 * (org-level or project-scoped). */
	const newChat = useCallback(async () => {
		const t = await createThread(undefined, projectId);
		setThreads((prev) => [t, ...prev]);
		setInitialMessages([]);
		selectStore(t.id);
	}, [projectId, selectStore]);

	/** Delete a thread; reselect a neighbor (or start fresh) if it was active. */
	const deleteThread = useCallback(
		async (id: string) => {
			await deleteThreadAction(id);
			const remaining = threads.filter((t) => t.id !== id);
			setThreads(remaining);
			if (threadId === id) {
				if (remaining.length > 0) await loadInto(remaining[0].id);
				else await newChat();
			}
		},
		[threads, threadId, loadInto, newChat],
	);

	/** Name a fresh thread from its first user message (optimistic + persisted). */
	const handleFirstMessage = useCallback((id: string, text: string) => {
		const title = text.trim().slice(0, 60) || "New chat";
		setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
		void renameThread(id, title);
	}, []);

	return {
		// Ready once the initial list → resume/create settles (both contexts). The surface
		// gates the keyed conversation on this so it mounts exactly once, with the right
		// thread — no empty→resumed flash.
		ready: initialResolved,
		threads,
		activeId: threadId,
		initialMessages,
		selectThread,
		newChat,
		deleteThread,
		handleFirstMessage,
	};
}
