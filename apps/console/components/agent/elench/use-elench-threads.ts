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
 * Org-thread orchestration for the Elench surface: lists the owner's threads (for the
 * modal rail + panel switcher), resumes the most recent on open (or starts a fresh
 * one), and loads a thread's transcript BEFORE switching so the keyed conversation
 * mounts with the right `initialMessages`. Project context is ephemeral — no threads,
 * empty transcript. Lifted from the former `AgentPage`.
 */
export function useElenchThreads() {
	const open = useElenchStore((s) => s.open);
	const ctx = useElenchStore((s) => s.ctx);
	const threadId = useElenchStore((s) => s.threadId);
	const selectStore = useElenchStore((s) => s.selectThread);
	const newChatStore = useElenchStore((s) => s.newChat);

	const isOrg = ctx.kind === "org";
	const [threads, setThreads] = useState<AgentThread[]>([]);
	const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
	const initialized = useRef(false);

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

	// Initial load: list threads, resume the most recent, or create a fresh one.
	useEffect(() => {
		if (!open || !isOrg || initialized.current) return;
		initialized.current = true;
		let cancelled = false;
		(async () => {
			const list = await listThreads();
			if (cancelled) return;
			setThreads(list);
			if (threadId) {
				await loadInto(threadId);
			} else if (list.length > 0) {
				await loadInto(list[0].id);
			} else {
				const t = await createThread();
				if (cancelled) return;
				setThreads([t]);
				setInitialMessages([]);
				selectStore(t.id);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, isOrg, threadId, loadInto, selectStore]);

	// Reset when the surface closes so reopening re-resumes cleanly.
	useEffect(() => {
		if (!open) initialized.current = false;
	}, [open]);

	/** Resume a persisted thread (loads its transcript first). */
	const selectThread = useCallback(
		(id: string) => {
			void loadInto(id);
		},
		[loadInto],
	);

	/** Start a fresh conversation. Org → a new persisted thread; project → ephemeral. */
	const newChat = useCallback(async () => {
		if (!isOrg) {
			newChatStore();
			return;
		}
		const t = await createThread();
		setThreads((prev) => [t, ...prev]);
		setInitialMessages([]);
		selectStore(t.id);
	}, [isOrg, newChatStore, selectStore]);

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
		threads,
		activeId: threadId,
		initialMessages,
		selectThread,
		newChat,
		deleteThread,
		handleFirstMessage,
	};
}
