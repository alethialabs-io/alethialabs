// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6115 PR B: the runtime end to end in one process — two "tabs" of one org over an in-memory
// lock and a real BroadcastChannel, a fake `fetch` serving the events route's real frames. Pins
// that only the leader opens a stream, that a follower's OWN QueryClient is invalidated from the
// relay, that the client captured at start is the only one ever touched, and that `removed` asks
// every tab to refresh.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rpc/client", () => ({
	orpc: { jobs: { key: () => ["jobs-orpc"] } },
}));

import { createConnectionStore } from "@/lib/realtime/client/connection-state";
import type { ChannelLike, LockManagerLike } from "@/lib/realtime/client/leader";
import { readRelayMessage, startRealtime } from "@/lib/realtime/client/runtime";
import { helloFrame, hintFrame, revokedFrame } from "@/lib/realtime/sse";

/** One exclusive lock with a FIFO queue (enough for two tabs). */
function memoryLocks(): LockManagerLike {
	let held = false;
	const queue: Array<() => void> = [];
	return {
		request(_name, options, callback) {
			return new Promise((resolve, reject) => {
				const grant = () => {
					held = true;
					void callback().then(() => {
						held = false;
						queue.shift()?.();
						resolve(undefined);
					});
				};
				if (!held) return grant();
				queue.push(grant);
				options.signal?.addEventListener("abort", () => {
					const i = queue.indexOf(grant);
					if (i >= 0) {
						queue.splice(i, 1);
						reject(new DOMException("aborted", "AbortError"));
					}
				});
			});
		},
	};
}

const channels: BroadcastChannel[] = [];
const openChannel = (name: string): ChannelLike => {
	const c = new BroadcastChannel(name);
	channels.push(c);
	return c;
};

afterEach(() => {
	for (const c of channels.splice(0)) c.close();
});

/** A fake events route: each stream request gets a body the test writes to. */
function eventsServer() {
	const enc = new TextEncoder();
	const streams: Array<{ url: string; write: (t: string) => void }> = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("probe=1")) return new Response(null, { status: 204 });
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		streams.push({ url, write: (t) => controller.enqueue(enc.encode(t)) });
		return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
	});
	return { fetchImpl, streams };
}

describe("startRealtime", () => {
	it("one stream for two tabs; the hint reaches BOTH tabs' own clients", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const locks = memoryLocks();
			const server = eventsServer();
			const clients = [new QueryClient(), new QueryClient()];
			const spies = clients.map((c) => vi.spyOn(c, "invalidateQueries"));
			const stores = [createConnectionStore(), createConnectionStore()];
			const stops = clients.map((queryClient, i) =>
				startRealtime({
					tenant: "acme",
					queryClient,
					onRemoved: () => {},
					store: stores[i],
					locks,
					openChannel,
					fetch: server.fetchImpl,
					isVisible: () => true,
				}),
			);
			await vi.waitFor(() => expect(server.streams).toHaveLength(1));
			expect(server.streams[0]!.url).toBe("/acme/~/events");
			server.streams[0]!.write(helloFrame("b1", "s.0") + hintFrame({ t: "jobs", id: "j1" }, "s.1"));
			await vi.waitFor(() => expect(stores[1]!.get().state).toBe("live"));
			expect(stores[0]!.get().state).toBe("live");
			await vi.advanceTimersByTimeAsync(2000);
			for (const spy of spies) {
				expect(spy).toHaveBeenCalledWith({ queryKey: ["jobs-orpc"], refetchType: "active" });
				expect(spy).toHaveBeenCalledWith({ queryKey: ["jobs"], refetchType: "active" });
			}
			for (const stop of stops) stop();
			expect(server.streams).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("only the client captured at start is invalidated — never one for another org", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const server = eventsServer();
			const acme = new QueryClient();
			const other = new QueryClient();
			const acmeSpy = vi.spyOn(acme, "invalidateQueries");
			const otherSpy = vi.spyOn(other, "invalidateQueries");
			const store = createConnectionStore();
			const stop = startRealtime({
				tenant: "acme",
				queryClient: acme,
				onRemoved: () => {},
				store,
				locks: memoryLocks(),
				openChannel,
				fetch: server.fetchImpl,
				isVisible: () => true,
			});
			await vi.waitFor(() => expect(server.streams).toHaveLength(1));
			server.streams[0]!.write(helloFrame("b1", "s.0") + hintFrame({ t: "jobs" }, "s.1"));
			await vi.waitFor(() => expect(store.get().state).toBe("live"));
			// The address moves to another org while acme's hint is still inside its window.
			stop();
			const stopOther = startRealtime({
				tenant: "other",
				queryClient: other,
				onRemoved: () => {},
				store,
				locks: memoryLocks(),
				openChannel,
				fetch: server.fetchImpl,
				isVisible: () => true,
			});
			await vi.advanceTimersByTimeAsync(5000);
			expect(acmeSpy).not.toHaveBeenCalled(); // the window was cancelled with acme's runtime
			expect(otherSpy).not.toHaveBeenCalled(); // and acme's hint never reached other's cache
			expect(server.streams.map((s) => s.url)).toEqual(["/acme/~/events", "/other/~/events"]);
			stopOther();
		} finally {
			vi.useRealTimers();
		}
	});

	it("`removed` on the leader's stream asks every tab to refresh, once", async () => {
		const locks = memoryLocks();
		const server = eventsServer();
		const removed = [vi.fn(), vi.fn()];
		const stops = removed.map((onRemoved) =>
			startRealtime({
				tenant: "acme",
				queryClient: new QueryClient(),
				onRemoved,
				store: createConnectionStore(),
				locks,
				openChannel,
				fetch: server.fetchImpl,
				isVisible: () => true,
			}),
		);
		await vi.waitFor(() => expect(server.streams).toHaveLength(1));
		server.streams[0]!.write(helloFrame("b1", "s.0") + revokedFrame("not-member"));
		await vi.waitFor(() => expect(removed[1]).toHaveBeenCalledTimes(1));
		expect(removed[0]).toHaveBeenCalledTimes(1);
		for (const stop of stops) stop();
	});
});

describe("readRelayMessage", () => {
	it("accepts the relay's shapes and nothing else", () => {
		expect(readRelayMessage({ type: "hint", hint: { t: "jobs", id: "x" } })).toEqual({
			type: "hint",
			hint: { t: "jobs", id: "x" },
		});
		expect(readRelayMessage({ type: "state", state: "live" })).toEqual({ type: "state", state: "live" });
		expect(readRelayMessage({ type: "hint", hint: { t: "nope" } })).toBeNull();
		expect(readRelayMessage({ type: "state", state: "asleep" })).toBeNull();
		expect(readRelayMessage({ type: "position", position: { boot: 1 } })).toBeNull();
		expect(readRelayMessage("hint")).toBeNull();
	});
});
