// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useElenchSend` (ADR 0001 slice 9) only dispatches: Enter is `SUBMIT`, and a prompt that is not
// the box's (a suggestion, a seed, an empty-cell prompt) is `SUBMIT_EXTERNAL` with its cell IN THE
// EVENT. It holds no message, no pending turn and no failure of its own, so it can lose none; R3's
// guard (`status ∈ {ready, error}`) is read at the moment of the send.

import { renderHook } from "@testing-library/react";
import type { ChatStatus } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatReady, useElenchSend } from "@/components/agent/elench/use-elench-send";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import { createDraftsStore, type DraftsStoreHandle, type DraftsTransport } from "@/lib/stores/elench-drafts/store";
import type { DraftKey } from "@/lib/stores/elench-drafts/types";

const KEY: DraftKey = {
	orgId: "00000000-0000-4000-8000-00000000000a",
	projectId: null,
	conversationId: "00000000-0000-4000-8000-0000000000c1",
};

/** A store whose only live part is `dispatch`, recorded. */
function recordingStore(): { store: DraftsStoreHandle; dispatch: ReturnType<typeof vi.fn> } {
	const dispatch = vi.fn();
	const store = {
		dispatch,
		ackNotices: vi.fn(),
		view: { getState: () => ({ notices: [] }) },
	} as unknown as DraftsStoreHandle;
	return { store, dispatch };
}

describe("useElenchSend", () => {
	it("Enter dispatches SUBMIT for the conversation's key, and nothing else runs", () => {
		const { store, dispatch } = recordingStore();
		const { result } = renderHook(() => useElenchSend({ store, key: KEY }, "ready"));
		expect(result.current.submit()).toBe(true);
		expect(dispatch).toHaveBeenCalledExactlyOnceWith({
			type: "ENTRY",
			key: KEY,
			event: { type: "SUBMIT", chatReady: true },
		});
	});

	it("an external prompt dispatches SUBMIT_EXTERNAL with its cell in the event", () => {
		const { store, dispatch } = recordingStore();
		const { result } = renderHook(() => useElenchSend({ store, key: KEY }, "error"));
		result.current.submitExternal({ text: "cpu by node", cellTarget: { x: 2, y: 1 }, origin: "cell" });
		expect(dispatch).toHaveBeenCalledExactlyOnceWith({
			type: "ENTRY",
			key: KEY,
			event: {
				type: "SUBMIT_EXTERNAL",
				text: "cpu by node",
				mentions: [],
				cellTarget: { x: 2, y: 1 },
				origin: "cell",
				chatReady: true,
			},
		});
	});

	it("reads R3's guard from the chat's status at the moment of the send", () => {
		const { store, dispatch } = recordingStore();
		const { result, rerender } = renderHook(({ status }: { status: ChatStatus }) => useElenchSend({ store, key: KEY }, status), {
			initialProps: { status: "streaming" },
		});
		result.current.submit();
		rerender({ status: "ready" });
		result.current.submit();
		expect(dispatch.mock.calls.map((c) => c[0].event.chatReady)).toEqual([false, true]);
		expect(["ready", "error", "submitted", "streaming"].map((s) => chatReady(s as ChatStatus))).toEqual([true, true, false, false]);
	});

	it("without a draft to send from (no store yet, or no page org) it sends nothing and says so", () => {
		const { result } = renderHook(() => useElenchSend(null, "ready"));
		expect(result.current.submit()).toBe(false);
		expect(result.current.submitExternal({ text: "hi", origin: "suggestion" })).toBe(false);
	});
});

// ── ADR 0001 §11.2 #23: a send acknowledges ITS conversation's notices, by id, and no other ──────

const OTHER: DraftKey = { ...KEY, conversationId: "00000000-0000-4000-8000-0000000000c2" };

/**
 * A real drafts store whose every save fails on the network, so a typed key raises one notice
 * (G19). Every other action never answers; the list answers empty at once.
 */
function failingStore(): DraftsStoreHandle {
	const never = (): Promise<never> => new Promise<never>(() => undefined);
	const transport: DraftsTransport = {
		listDrafts: async () => ({ outcome: "ok", orgId: KEY.orgId, drafts: [] }),
		saveDraft: () => Promise.reject(new TypeError("Failed to fetch")),
		restoreDraft: never,
		discardDraft: never,
		claimDraft: never,
		consumeDraft: never,
		releaseClaim: never,
		startConversation: never,
	};
	let n = 0;
	return createDraftsStore({
		viewerId: "00000000-0000-4000-8000-0000000000aa",
		transport,
		heartbeat: never,
		storage: () => null,
		tabId: "tab-1",
		mint: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
	});
}

/** Opens `key` as a new conversation, types `text` into it, and lets its save fail. */
async function typeAndFail(store: DraftsStoreHandle, key: DraftKey, text: string): Promise<void> {
	store.dispatch({ type: "SELECT", key, thread: "none" });
	const entry = store.view.getState().drafts.entries[keyId(key)];
	if (entry === undefined) throw new Error("no entry");
	store.dispatch({ type: "ENTRY", key, event: { type: "EDIT", epoch: entry.epoch, content: { text, mentions: [] } } });
	await vi.advanceTimersByTimeAsync(800);
	await vi.advanceTimersByTimeAsync(0);
}

describe("useElenchSend › notices", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("Enter acknowledges only this conversation's notices; another conversation's stay", async () => {
		vi.useFakeTimers();
		const store = failingStore();
		store.load({ orgId: KEY.orgId, projectId: null });
		await vi.advanceTimersByTimeAsync(0);
		await typeAndFail(store, KEY, "deploy");
		await typeAndFail(store, OTHER, "rollback");
		expect(store.view.getState().notices.map((n) => n.key.conversationId).sort()).toEqual(
			[KEY.conversationId, OTHER.conversationId].sort(),
		);
		const { result } = renderHook(() => useElenchSend({ store, key: KEY }, "ready"));
		result.current.submit();
		expect(store.view.getState().notices.map((n) => n.key.conversationId)).toEqual([OTHER.conversationId]);
		store.dispose();
	});
});
