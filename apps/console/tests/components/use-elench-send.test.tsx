// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `useElenchSend` (ADR 0001 slice 9) only dispatches: Enter is `SUBMIT`, and a prompt that is not
// the box's (a suggestion, a seed, an empty-cell prompt) is `SUBMIT_EXTERNAL` with its cell IN THE
// EVENT. It holds no message, no pending turn and no failure of its own, so it can lose none; R3's
// guard (`status ∈ {ready, error}`) is read at the moment of the send.

import { renderHook } from "@testing-library/react";
import type { ChatStatus } from "ai";
import { describe, expect, it, vi } from "vitest";
import { chatReady, useElenchSend } from "@/components/agent/elench/use-elench-send";
import type { DraftsStoreHandle } from "@/lib/stores/elench-drafts/store";
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
