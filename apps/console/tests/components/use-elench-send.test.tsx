// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench send path sends a message ONLY once the conversation has a thread (#5423 review).
// Both chat routes persist a reply in `onFinish` only when the request carries a thread id, so
// the old `catch { send anyway }` produced a conversation that looked normal and was gone on
// reload — and every later turn went out thread-less too. Here: a thread that cannot be created
// sends nothing, keeps the message (resolves false → the composer keeps its text) and surfaces
// a ThreadStartError; Retry re-attempts the thread under the SAME first-turn id, which is what
// makes `createThread`'s idempotency (tests/actions/agent.test.ts) collapse a committed-but-lost
// insert into one thread with one stored turn.

import { act, renderHook } from "@testing-library/react";
import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { FirstTurn } from "@/app/server/actions/agent";
import { ThreadStartError } from "@/components/agent/chat-error";
import { useElenchSend } from "@/components/agent/elench/use-elench-send";
import { MAX_USER_MESSAGE_CHARS, MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";

vi.mock("@/app/server/actions/billing", () => ({ getAiUsageSummary: vi.fn() }));

/** A harness whose `startThread` runs `impl`, and whose thread exists once one start resolved. */
function setup(impl: (title: string, turn?: FirstTurn) => Promise<unknown>) {
	let attached = false;
	const startThread = vi.fn(async (title: string, turn?: FirstTurn) => {
		const t = await impl(title, turn);
		attached = true;
		return t;
	});
	const sendMessage = vi.fn((_m: UIMessage) => undefined);
	const beforeSend = vi.fn();
	const hook = renderHook(() =>
		useElenchSend({ hasThread: () => attached, startThread, sendMessage, beforeSend }),
	);
	return { hook, startThread, sendMessage, beforeSend };
}

describe("useElenchSend", () => {
	it("sends NOTHING when the thread cannot be created, keeps the message, and shows why", async () => {
		const { hook, startThread, sendMessage, beforeSend } = setup(async () => {
			throw new Error("insert failed");
		});
		let sent = true;
		await act(async () => {
			sent = await hook.result.current.send("hello there");
		});
		expect(startThread).toHaveBeenCalledTimes(1);
		expect(sent).toBe(false); // → the composer keeps the text
		expect(sendMessage).not.toHaveBeenCalled();
		expect(beforeSend).not.toHaveBeenCalled();
		expect(hook.result.current.error).toBeInstanceOf(ThreadStartError);
		expect(hook.result.current.retry).toBeDefined();
	});

	it("retries a committed-but-lost start under the SAME turn id and sends exactly once", async () => {
		// The first start commits server-side, then its response is lost (the action rejects).
		const stored = new Map<string, FirstTurn>();
		let first = true;
		const { hook, startThread, sendMessage } = setup(async (_title, turn) => {
			// The server half: `createThread` is idempotent on the turn id.
			if (turn) stored.set(turn.id, turn);
			if (first) {
				first = false;
				throw new Error("response lost");
			}
			return { id: "t-1" };
		});
		await act(async () => {
			await hook.result.current.send("hello there", [
				{ id: "p1", type: "project", label: "web" },
			]);
		});
		expect(hook.result.current.error).toBeInstanceOf(ThreadStartError);

		let sent = false;
		await act(async () => {
			const retry = hook.result.current.retry;
			if (!retry) throw new Error("no retry offered");
			sent = await retry();
		});
		expect(sent).toBe(true);
		expect(startThread).toHaveBeenCalledTimes(2);
		const [, firstTurn] = startThread.mock.calls[0];
		const [, retryTurn] = startThread.mock.calls[1];
		expect(firstTurn?.id).toBeTruthy();
		expect(retryTurn?.id).toBe(firstTurn?.id);
		expect(stored.size).toBe(1); // one thread key → one stored first turn
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage.mock.calls[0][0]).toEqual({
			id: firstTurn?.id,
			role: "user",
			parts: [{ type: "text", text: "hello there" }],
		});
		expect(hook.result.current.error).toBeNull();
		expect(hook.result.current.retry).toBeUndefined();
	});

	it("creates the thread before the first send, under the id the message is sent with", async () => {
		const { hook, startThread, sendMessage, beforeSend } = setup(async () => ({ id: "t" }));
		await act(async () => {
			await hook.result.current.send("first");
		});
		const [title, turn] = startThread.mock.calls[0];
		expect(title).toBe("first");
		expect(sendMessage.mock.calls[0][0].id).toBe(turn?.id);
		expect(beforeSend).toHaveBeenCalledWith([]);
		// The thread exists now: the next send creates nothing.
		await act(async () => {
			await hook.result.current.send("second");
		});
		expect(startThread).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it("never calls startThread for an over-limit first send (no empty row) and says why", async () => {
		const { hook, startThread, sendMessage } = setup(async () => ({ id: "t" }));
		let sent = true;
		await act(async () => {
			sent = await hook.result.current.send("a".repeat(MAX_USER_MESSAGE_CHARS + 1));
		});
		expect(sent).toBe(false);
		expect(startThread).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
		expect(hook.result.current.error?.message).toBe(MESSAGE_TOO_LONG);
	});

	it("refuses a second send while the thread is still being created", async () => {
		let release: () => void = () => undefined;
		const { hook, startThread, sendMessage } = setup(
			() => new Promise((resolve) => (release = () => resolve({ id: "t" }))),
		);
		let firstSend: Promise<boolean> = Promise.resolve(false);
		let second = true;
		await act(async () => {
			firstSend = hook.result.current.send("one");
			second = await hook.result.current.send("two");
		});
		expect(second).toBe(false);
		await act(async () => {
			release();
			await firstSend;
		});
		expect(startThread).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});
});
