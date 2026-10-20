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
import { electionName, newDocumentScope, readRelayMessage, startRealtime } from "@/lib/realtime/client/runtime";
import { helloFrame, hintFrame, revokedFrame } from "@/lib/realtime/sse";

/** Exclusive locks by name, each with a FIFO queue — the Web Locks semantics the election relies on. */
function memoryLocks(): LockManagerLike {
	const held = new Set<string>();
	const queues = new Map<string, Array<() => void>>();
	return {
		request(name, options, callback) {
			return new Promise((resolve, reject) => {
				const grant = () => {
					held.add(name);
					void callback().then(() => {
						held.delete(name);
						queues.get(name)?.shift()?.();
						resolve(undefined);
					});
				};
				if (!held.has(name)) return grant();
				const queue = queues.get(name) ?? [];
				queues.set(name, queue);
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

/** A fake events route: each stream request gets a body the test writes to; `refusals` answers the
 * first stream requests with those statuses instead. */
function eventsServer(refusals: number[] = []) {
	const enc = new TextEncoder();
	const streams: Array<{ url: string; write: (t: string) => void }> = [];
	const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("probe=1")) return new Response(null, { status: 204 });
		const refused = refusals.shift();
		if (refused !== undefined) return new Response(null, { status: refused });
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
				startRealtime({ scope: newDocumentScope(),
					userId: "u1",
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
			const stop = startRealtime({ scope: newDocumentScope(),
				userId: "u1",
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
			const stopOther = startRealtime({ scope: newDocumentScope(),
				userId: "u1",
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
			startRealtime({ scope: newDocumentScope(),
				userId: "u1",
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

describe("startRealtime — terminal states, identity, failure and bfcache", () => {
	it("a leader that goes signed-out LEAVES the election: a tab opened later leads and goes live", async () => {
		const locks = memoryLocks();
		const server = eventsServer([401]);
		const storeA = createConnectionStore();
		const stopA = startRealtime({ scope: newDocumentScope(),
			userId: "u1",
			tenant: "acme",
			queryClient: new QueryClient(),
			onRemoved: () => {},
			store: storeA,
			locks,
			openChannel,
			fetch: server.fetchImpl,
			isVisible: () => true,
		});
		await vi.waitFor(() => expect(storeA.get().state).toBe("signed-out"));
		// After a fresh sign-in, a new tab of the same person and org:
		const storeB = createConnectionStore();
		const stopB = startRealtime({ scope: newDocumentScope(),
			userId: "u1",
			tenant: "acme",
			queryClient: new QueryClient(),
			onRemoved: () => {},
			store: storeB,
			locks,
			openChannel,
			fetch: server.fetchImpl,
			isVisible: () => true,
		});
		await vi.waitFor(() => expect(server.streams).toHaveLength(1));
		server.streams[0]!.write(helloFrame("b1", "s.0"));
		await vi.waitFor(() => expect(storeB.get().state).toBe("live"));
		// ...and A, no longer a leader, never answered B's `sync` with its terminal state.
		await new Promise((r) => setTimeout(r, 20));
		expect(storeB.get().state).toBe("live");
		stopA();
		stopB();
	});

	it("two people signed in to one browser, one org: two elections, two streams", async () => {
		const locks = memoryLocks();
		const server = eventsServer();
		const stops = ["u1", "u2"].map((userId) =>
			startRealtime({ scope: newDocumentScope(),
				userId,
				tenant: "acme",
				queryClient: new QueryClient(),
				onRemoved: () => {},
				store: createConnectionStore(),
				locks,
				openChannel,
				fetch: server.fetchImpl,
				isVisible: () => true,
			}),
		);
		await vi.waitFor(() => expect(server.streams).toHaveLength(2));
		expect(electionName("u1", "acme")).not.toBe(electionName("u2", "acme"));
		for (const stop of stops) stop();
	});

	it("never throws: a primitive that fails degrades to the fallback poll and closes what it opened", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		try {
			const opened: Array<{ name: string; closed: boolean }> = [];
			const flakyChannel = (name: string): ChannelLike => {
				if (name.endsWith(":lease")) throw new Error("no channel for you");
				const entry = { name, closed: false };
				opened.push(entry);
				return {
					postMessage: () => {},
					addEventListener: () => {},
					removeEventListener: () => {},
					close: () => {
						entry.closed = true;
					},
				};
			};
			const client = new QueryClient();
			const spy = vi.spyOn(client, "invalidateQueries");
			const store = createConnectionStore();
			let stop: (() => void) | undefined;
			expect(() => {
				stop = startRealtime({ scope: newDocumentScope(),
					userId: "u1",
					tenant: "acme",
					queryClient: client,
					onRemoved: () => {},
					store,
					locks: null, // the insecure-context path, whose channel will not open
					openChannel: flakyChannel,
					fetch: eventsServer().fetchImpl,
					isVisible: () => true,
					pageEvents: null,
				});
			}).not.toThrow();
			expect(store.get().state).toBe("degraded");
			expect(opened).toEqual([{ name: electionName("u1", "acme"), closed: true }]);
			await vi.advanceTimersByTimeAsync(15_000);
			expect(spy).toHaveBeenCalledWith({ queryKey: ["jobs-orpc"], refetchType: "active" });
			stop?.();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a restart clears a `removed` left by the previous runtime", () => {
		const store = createConnectionStore();
		store.set("live");
		store.set("removed");
		expect(store.get().hasBeenLive).toBe(true);
		const stop = startRealtime({ scope: newDocumentScope(),
			userId: "u1",
			tenant: "acme",
			queryClient: new QueryClient(),
			onRemoved: () => {},
			store,
			locks: memoryLocks(),
			openChannel,
			fetch: eventsServer().fetchImpl,
			isVisible: () => true,
			pageEvents: null,
		});
		expect(store.get()).toMatchObject({ state: "connecting", hasBeenLive: false });
		stop();
	});

	it("a bfcache restore (`pageshow` persisted) rejoins the election and resyncs", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const server = eventsServer();
			const page = new EventTarget();
			const client = new QueryClient();
			const spy = vi.spyOn(client, "invalidateQueries");
			const stop = startRealtime({ scope: newDocumentScope(),
				userId: "u1",
				tenant: "acme",
				queryClient: client,
				onRemoved: () => {},
				store: createConnectionStore(),
				locks: memoryLocks(),
				openChannel,
				fetch: server.fetchImpl,
				isVisible: () => true,
				pageEvents: page,
			});
			await vi.waitFor(() => expect(server.streams).toHaveLength(1));
			page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
			await vi.advanceTimersByTimeAsync(3000);
			expect(server.streams).toHaveLength(1); // an ordinary load is not a restore
			page.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
			await vi.waitFor(() => expect(server.streams).toHaveLength(2));
			await vi.advanceTimersByTimeAsync(3000);
			expect(spy).toHaveBeenCalledWith({ refetchType: "active" });
			stop();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("startRealtime — one runtime per document", () => {
	it("a second start in the same document (its stop lost) replaces the first: one relay listener, one invalidation per key", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const locks = memoryLocks();
			const server = eventsServer();
			const base = {
				userId: "u1",
				tenant: "acme",
				onRemoved: () => {},
				locks,
				openChannel,
				fetch: server.fetchImpl,
				isVisible: () => true,
				pageEvents: null,
			};
			const stopA = startRealtime({ ...base, scope: newDocumentScope(), queryClient: new QueryClient(), store: createConnectionStore() });
			await vi.waitFor(() => expect(server.streams).toHaveLength(1));
			const docB = newDocumentScope();
			const clientB = new QueryClient();
			const spyB = vi.spyOn(clientB, "invalidateQueries");
			startRealtime({ ...base, scope: docB, queryClient: clientB, store: createConnectionStore() }); // never stopped
			const stopB = startRealtime({ ...base, scope: docB, queryClient: clientB, store: createConnectionStore() });
			server.streams[0]!.write(helloFrame("b1", "s.0") + hintFrame({ t: "jobs", id: "j1" }, "s.1"));
			await vi.waitFor(() => expect(spyB).toHaveBeenCalled());
			await vi.advanceTimersByTimeAsync(2000);
			const jobsKeyCalls = spyB.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(["jobs"]));
			expect(jobsKeyCalls).toHaveLength(1);
			expect(server.streams).toHaveLength(1); // and B never opened a second stream
			stopA();
			stopB();
		} finally {
			vi.useRealTimers();
		}
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
