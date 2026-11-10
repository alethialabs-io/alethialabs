// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6207: a live agent widget re-runs its source tool on its topic's hint, not on a timer. Driven end
// to end through the REAL bus pieces — the coalescer over the real `TOPIC_KEYS` — into a real
// QueryClient, so "re-ran" means the refresher's `run` was called because an invalidation reached the
// widget's key, not because a test called it.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@/app/server/actions/widgets", () => ({
	refreshWidgetSource: vi.fn(),
	listThreadWidgets: vi.fn(async () => []),
	pinWidget: vi.fn(),
	updateWidget: vi.fn(async () => {}),
	deleteWidget: vi.fn(async () => {}),
}));

import {
	autoRefreshes,
	minRefreshMs,
	createWidgetRefresher,
	liveData,
	type WidgetRefresher,
	widgetQueryKey,
	widgetTopic,
} from "@/components/agent/widgets/live-refresh";
import { WIDGET_REGISTRY } from "@/components/agent/widgets/registry";
import type { ThreadWidget } from "@/lib/db/schema";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { type Coalescer, createCoalescer, HINT_JITTER_MS, HINT_WINDOW_MS } from "@/lib/realtime/client/coalescer";
import type { Topic } from "@/lib/realtime/topics";

/** A thread_widgets row fixture: a live jobs widget unless overridden. */
function widget(over: Partial<ThreadWidget> = {}): ThreadWidget {
	const at = new Date("2026-10-27T10:00:00Z");
	return {
		id: "w1",
		thread_id: "t1",
		user_id: "u1",
		org_id: "org-1",
		kind: "table",
		title: "Jobs",
		source: { tool: "list_jobs", args: null },
		data: { output: { jobs: [] } },
		pos_x: 0,
		pos_y: 0,
		colspan: 3,
		rowspan: 2,
		mode: "live",
		tool_call_id: null,
		artifact_id: null,
		refreshed_at: null,
		created_at: at,
		updated_at: at,
		...over,
	};
}

/** A promise the test settles by hand, to hold a re-run in flight. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Longer than any hint window, so every scheduled flush (and the cache's notify tick) has run. */
const PAST_WINDOW = HINT_WINDOW_MS + HINT_JITTER_MS + 50;

interface Rig {
	client: QueryClient;
	bus: Coalescer;
	refresher: WidgetRefresher;
	run: Mock<(id: string) => Promise<ThreadWidget | null>>;
	setVisible: (v: boolean) => void;
	setWidgets: (ws: ThreadWidget[]) => void;
}

/** The bus's coalescer and the grid's refresher over one org's QueryClient, with the widgets seeded
 * into the cache the way `useWidgetData` seeds them. */
function rig(widgets: ThreadWidget[], run?: (id: string) => Promise<ThreadWidget | null>): Rig {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	let visible = true;
	let current = widgets;
	for (const w of widgets) client.setQueryData(widgetQueryKey(w), w);
	const runFn = vi.fn<(id: string) => Promise<ThreadWidget | null>>(
		run ?? (async (id) => widget({ id, data: { output: { jobs: [{ id: "j-new" }] } }, updated_at: new Date("2026-10-27T11:00:00Z") })),
	);
	const bus = createCoalescer({ queryClient: client, topicKeys: TOPIC_KEYS, isVisible: () => visible, random: () => 0 });
	const refresher = createWidgetRefresher({
		queryClient: client,
		widgets: () => current,
		run: runFn,
		isVisible: () => visible,
	});
	return {
		client,
		bus,
		refresher,
		run: runFn,
		setVisible: (v) => {
			visible = v;
		},
		setWidgets: (ws) => {
			current = ws;
		},
	};
}

/** Sends `n` hints on a topic and lets their window flush. */
async function hint(r: Rig, t: Topic, n = 1) {
	for (let i = 0; i < n; i++) r.bus.hint({ t });
	await vi.advanceTimersByTimeAsync(PAST_WINDOW);
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("live widgets refresh on their topic's hint (#6207)", () => {
	it("a burst of jobs hints re-runs a live jobs widget's source ONCE, and the fresh row lands in Query", async () => {
		const w = widget();
		const r = rig([w]);
		await hint(r, "jobs", 5);
		expect(r.run).toHaveBeenCalledTimes(1);
		expect(r.run).toHaveBeenCalledWith("w1");
		expect(r.client.getQueryData<ThreadWidget>(widgetQueryKey(w))?.data).toEqual({ output: { jobs: [{ id: "j-new" }] } });
		r.refresher.dispose();
	});

	it("a hidden tab re-runs nothing; the widget re-runs once when the tab is looked at again", async () => {
		const r = rig([widget()]);
		r.setVisible(false);
		await hint(r, "jobs", 3);
		expect(r.run).not.toHaveBeenCalled();
		r.setVisible(true);
		r.refresher.onVisible();
		await vi.advanceTimersByTimeAsync(10);
		expect(r.run).toHaveBeenCalledTimes(1);
		r.refresher.onVisible(); // a second visibility change with nothing new re-runs nothing
		await vi.advanceTimersByTimeAsync(10);
		expect(r.run).toHaveBeenCalledTimes(1);
		r.refresher.dispose();
	});

	it("a hint on another topic, a frozen widget, and a widget no topic announces are never re-run", async () => {
		const frozen = widget({ id: "frozen", mode: "frozen" });
		const untopiced = widget({ id: "conn", source: { tool: "list_connectors", args: null } });
		const jobs = widget({ id: "jobs" });
		const r = rig([frozen, untopiced, jobs]);
		await hint(r, "billing");
		expect(r.run).not.toHaveBeenCalled();
		await hint(r, "jobs");
		expect(r.run.mock.calls).toEqual([["jobs"]]);
		r.refresher.dispose();
	});

	it("hints that land while a re-run is in flight queue exactly one follow-up, not one each (at the floor)", async () => {
		const first = deferred<ThreadWidget | null>();
		let calls = 0;
		const r = rig([widget()], async () => {
			calls++;
			return calls === 1 ? first.promise : null;
		});
		await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(1);
		await hint(r, "jobs");
		await hint(r, "jobs");
		await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(1); // still the first one
		first.resolve(null);
		await vi.advanceTimersByTimeAsync(10);
		expect(r.run).toHaveBeenCalledTimes(1); // the follow-up waits for the jobs floor
		await vi.advanceTimersByTimeAsync(minRefreshMs(widget()));
		expect(r.run).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(minRefreshMs(widget()) * 3);
		expect(r.run).toHaveBeenCalledTimes(2); // and only one
		r.refresher.dispose();
	});

	it("a failed re-run keeps the last snapshot and does not wedge the widget: the next hint re-runs it", async () => {
		const w = widget();
		const r = rig([w], async () => {
			throw new Error("tool failed");
		});
		await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(1);
		expect(r.client.getQueryData<ThreadWidget>(widgetQueryKey(w))?.data).toEqual(w.data);
		await hint(r, "jobs");
		await vi.advanceTimersByTimeAsync(minRefreshMs(w));
		expect(r.run).toHaveBeenCalledTimes(2);
		r.refresher.dispose();
	});

	it("a disposed refresher (the grid unmounted) re-runs nothing", async () => {
		const r = rig([widget()]);
		r.refresher.dispose();
		await hint(r, "jobs");
		expect(r.run).not.toHaveBeenCalled();
	});

	it("a widget taken off the grid is not re-run by a hint that still reaches its cached key", async () => {
		const r = rig([widget()]);
		r.setWidgets([]);
		await hint(r, "jobs");
		expect(r.run).not.toHaveBeenCalled();
		r.refresher.dispose();
	});

	it("the refresh button re-runs any widget with a source — frozen and untopiced included", async () => {
		const frozen = widget({ id: "frozen", mode: "frozen" });
		const r = rig([frozen]);
		r.refresher.refresh("frozen");
		await vi.advanceTimersByTimeAsync(10);
		expect(r.run.mock.calls).toEqual([["frozen"]]);
		r.refresher.dispose();
	});
});

describe("the floor between hint-driven re-runs (minRefreshMs)", () => {
	it("keeps the old poll cadences: 15 s for the jobs list, 60 s for clusters", () => {
		expect(minRefreshMs(widget())).toBe(15_000);
		expect(minRefreshMs(widget({ source: { tool: "list_clusters", args: null } }))).toBe(60_000);
		expect(minRefreshMs(widget({ source: { tool: "not_a_tool", args: null } }))).toBe(60_000);
	});

	it("a burst inside the window is one immediate run plus ONE trailing run at the window's end", async () => {
		const w = widget();
		const r = rig([w]);
		await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(1);
		// Ten more hints spread over the window: none runs now.
		for (let i = 0; i < 10; i++) await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(minRefreshMs(w));
		expect(r.run).toHaveBeenCalledTimes(2);
		// Nothing further was hinted, so nothing further runs.
		await vi.advanceTimersByTimeAsync(minRefreshMs(w) * 4);
		expect(r.run).toHaveBeenCalledTimes(2);
		r.refresher.dispose();
	});

	it("a hint after the window has passed runs at once", async () => {
		const w = widget();
		const r = rig([w]);
		await hint(r, "jobs");
		await vi.advanceTimersByTimeAsync(minRefreshMs(w));
		await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(2);
		r.refresher.dispose();
	});

	it("the refresh button bypasses the floor", async () => {
		const r = rig([widget()]);
		await hint(r, "jobs");
		expect(r.run).toHaveBeenCalledTimes(1);
		r.refresher.refresh("w1");
		await vi.advanceTimersByTimeAsync(10);
		expect(r.run).toHaveBeenCalledTimes(2);
		r.refresher.refresh("w1");
		await vi.advanceTimersByTimeAsync(10);
		expect(r.run).toHaveBeenCalledTimes(3);
		r.refresher.dispose();
	});

	it("the trailing run is cancelled when the grid unmounts (dispose)", async () => {
		const w = widget();
		const r = rig([w]);
		await hint(r, "jobs");
		await hint(r, "jobs"); // inside the window: schedules the trailing run
		expect(r.run).toHaveBeenCalledTimes(1);
		r.refresher.dispose();
		await vi.advanceTimersByTimeAsync(minRefreshMs(w) * 2);
		expect(r.run).toHaveBeenCalledTimes(1);
	});
});

describe("every registry topic reaches its widgets through TOPIC_KEYS", () => {
	it.each(Object.entries(WIDGET_REGISTRY).filter(([, def]) => def.topic !== null))(
		"%s: a hint on its topic invalidates its widget's key",
		async (tool, def) => {
			const client = new QueryClient();
			const w = widget({ source: { tool, args: null } });
			client.setQueryData(widgetQueryKey(w), w);
			const topic = def.topic;
			if (!topic) throw new Error("filtered above");
			for (const queryKey of TOPIC_KEYS[topic]()) await client.invalidateQueries({ queryKey, refetchType: "none" });
			expect(client.getQueryState(widgetQueryKey(w))?.isInvalidated).toBe(true);
		},
	);

	it("a hint on one topic does not reach another topic's widget", async () => {
		const client = new QueryClient();
		const usage = widget({ source: { tool: "get_ai_usage", args: null } });
		client.setQueryData(widgetQueryKey(usage), usage);
		for (const queryKey of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey, refetchType: "none" });
		expect(client.getQueryState(widgetQueryKey(usage))?.isInvalidated).toBe(false);
	});
});

describe("widget keys and payload precedence", () => {
	it("keys a widget by topic, owner and id; a personal-scope widget by its person", () => {
		expect(widgetQueryKey(widget())).toEqual(["agent-widget", "jobs", "org-1", "w1"]);
		expect(widgetQueryKey(widget({ org_id: null }))).toEqual(["agent-widget", "jobs", "user:u1", "w1"]);
		expect(widgetTopic(widget({ source: null }))).toBeNull();
		expect(autoRefreshes(widget({ source: null }))).toBe(false);
	});

	it("shows the refreshed payload, unless the grid row is the newer write (a re-pin)", () => {
		const older = new Date("2026-10-27T10:00:00Z");
		const newer = new Date("2026-10-27T11:00:00Z");
		const refreshed = { data: { output: "refreshed" }, refreshed_at: newer, updated_at: newer };
		const pinned = { data: { output: "pinned" }, refreshed_at: null, updated_at: older };
		expect(liveData(refreshed, pinned).data).toEqual({ output: "refreshed" });
		const repinned = { data: { output: "repinned" }, refreshed_at: null, updated_at: new Date("2026-10-27T12:00:00Z") };
		expect(liveData(refreshed, repinned).data).toEqual({ output: "repinned" });
		expect(liveData(undefined, pinned).data).toEqual({ output: "pinned" });
	});
});
