// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6115 PR B, herd control (ADR 0005 §10 R9): a burst is one invalidation, a hidden tab refetches
// nothing, and every delay is jittered inside stated bounds. Run over a REAL QueryClient with
// observed queries, so "refetches" means a queryFn actually ran, not that a mock was called.

import { QueryClient, type QueryKey, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { until } from "./harness";
import {
	createCoalescer,
	HINT_JITTER_MS,
	HINT_WINDOW_MS,
	RESYNC_JITTER_MS,
} from "@/lib/realtime/client/coalescer";
import type { Topic } from "@/lib/realtime/topics";

const JOBS_KEY: QueryKey = ["jobs", "acme"];
const PROJECTS_KEY: QueryKey = ["projects", "acme"];

/** Topic keys for the test: jobs and projects have one key each, the rest none. */
const topicKeys: Record<Topic, () => QueryKey[]> = {
	jobs: () => [JOBS_KEY],
	projects: () => [PROJECTS_KEY],
	environments: () => [],
	clusters: () => [],
	runners: () => [],
	fleet: () => [],
	addons: () => [],
	alerts: () => [],
	support: () => [],
	usage: () => [],
	billing: () => [],
	organization: () => [],
	members: () => [],
	access: () => [],
	connectors: () => [],
	classification: () => [],
	activity: () => [],
};

/** A client with an OBSERVED query per key, counting fetches. */
function observedClient() {
	const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
	const fetches = new Map<string, number>();
	const unsubs: Array<() => void> = [];
	for (const key of [JOBS_KEY, PROJECTS_KEY]) {
		const name = JSON.stringify(key);
		fetches.set(name, 0);
		const observer = new QueryObserver(client, {
			queryKey: key,
			queryFn: async () => {
				fetches.set(name, (fetches.get(name) ?? 0) + 1);
				return [];
			},
		});
		unsubs.push(observer.subscribe(() => {}));
	}
	return {
		client,
		count: (key: QueryKey) => fetches.get(JSON.stringify(key)) ?? 0,
		dispose: () => {
			for (const u of unsubs) u();
			client.clear();
		},
	};
}

describe("createCoalescer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("50 hints on one topic → ONE invalidation, inside the jittered window", async () => {
		const c = observedClient();
		await until(() => c.count(JOBS_KEY) === 1, "the observer's initial fetch");
		const spy = vi.spyOn(c.client, "invalidateQueries");
		const co = createCoalescer({ queryClient: c.client, topicKeys, isVisible: () => true, random: () => 0 });
		for (let i = 0; i < 50; i++) co.hint({ t: "jobs", id: `job-${i}` });
		await vi.advanceTimersByTimeAsync(HINT_WINDOW_MS - 1);
		expect(spy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith({ queryKey: JOBS_KEY, refetchType: "active" });
		await until(() => c.count(JOBS_KEY) === 2, "the one refetch");
		expect(c.count(PROJECTS_KEY)).toBe(1); // another topic's query is untouched
		co.dispose();
		c.dispose();
	});

	it("a hidden tab marks stale and refetches NOTHING", async () => {
		const c = observedClient();
		await until(() => c.count(JOBS_KEY) === 1, "the observer's initial fetch");
		const co = createCoalescer({ queryClient: c.client, topicKeys, isVisible: () => false, random: () => 0 });
		co.hint({ t: "jobs" });
		await vi.advanceTimersByTimeAsync(HINT_WINDOW_MS + HINT_JITTER_MS);
		expect(c.client.getQueryState(JOBS_KEY)?.isInvalidated).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(c.count(JOBS_KEY)).toBe(1);
		co.dispose();
		c.dispose();
	});

	it("visibility is read at FLUSH time: a tab hidden after the hint does not refetch", async () => {
		const c = observedClient();
		await until(() => c.count(JOBS_KEY) === 1, "the observer's initial fetch");
		let visible = true;
		const co = createCoalescer({ queryClient: c.client, topicKeys, isVisible: () => visible, random: () => 0 });
		co.hint({ t: "jobs" });
		visible = false;
		await vi.advanceTimersByTimeAsync(HINT_WINDOW_MS + HINT_JITTER_MS);
		expect(c.count(JOBS_KEY)).toBe(1);
		co.dispose();
		c.dispose();
	});

	// The bounds are written as numbers, not recomputed from the constants: [300, 1050) ms.
	it.each([
		[0, 300],
		[0.5, 675],
		[0.999, 1049],
	])("random()=%f → the hint window closes at %i ms", async (r, delay) => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "invalidateQueries");
		const co = createCoalescer({ queryClient: client, topicKeys, isVisible: () => true, random: () => r });
		co.hint({ t: "jobs" });
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(spy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(spy).toHaveBeenCalledTimes(1);
		co.dispose();
	});

	it.each([
		[0.001, 3],
		[0.5, 1500],
		[0.999, 2997],
	])("random()=%f → a resync lands at %i ms and invalidates everything once", async (r, delay) => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "invalidateQueries");
		const co = createCoalescer({ queryClient: client, topicKeys, isVisible: () => true, random: () => r });
		co.hint({ t: "jobs" });
		co.resync();
		co.resync();
		co.hint({ t: "projects" }); // covered by the pending resync
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(spy).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(spy).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(HINT_WINDOW_MS + HINT_JITTER_MS + RESYNC_JITTER_MS);
		expect(spy).toHaveBeenCalledTimes(1); // the hints it covered never flush on their own
		expect(spy).toHaveBeenCalledWith({ refetchType: "active" });
		co.dispose();
	});

	it("refreshAll (the fallback poll) invalidates every topic's keys now", () => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "invalidateQueries");
		const co = createCoalescer({ queryClient: client, topicKeys, isVisible: () => true });
		co.refreshAll();
		expect(spy.mock.calls.map(([f]) => f?.queryKey)).toEqual([JOBS_KEY, PROJECTS_KEY]);
		co.dispose();
	});

	it("dispose cancels everything scheduled", async () => {
		const client = new QueryClient();
		const spy = vi.spyOn(client, "invalidateQueries");
		const co = createCoalescer({ queryClient: client, topicKeys, isVisible: () => true });
		co.hint({ t: "jobs" });
		co.dispose();
		co.resync();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(spy).not.toHaveBeenCalled();
	});
});
