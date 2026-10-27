"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How a LIVE agent widget stays current (#6207, ADR 0005 §7 Q3): on its topic's hint, not on a timer.
//
// A widget's data is a Query entry keyed `[...AGENT_WIDGET_KEY, topic, owner, widgetId]`; the org's
// change stream invalidates `[...AGENT_WIDGET_KEY, topic]` through `TOPIC_KEYS` like any other read.
// What an invalidation cannot do on its own is RE-RUN THE SOURCE TOOL: that replay persists the new
// snapshot (`refreshWidgetSource`), so it is a write, and a write is not a `queryFn`. The query is
// therefore fetcher-less (`skipToken`) and the grid's refresher listens for the invalidation and runs
// the replay itself, writing the fresh row back with `setQueryData`.
//
// The rules it keeps, each tested in `tests/components/widgets/live-refresh.test.ts`:
//   · ONE re-run per invalidation. The bus already coalesces a burst of hints into one invalidation
//     per topic window; an invalidation that lands while a re-run is in flight queues exactly one
//     follow-up, never one per hint.
//   · a HIDDEN tab re-runs nothing. The widget is remembered and re-run once when the tab is looked
//     at again (the bus marks queries stale in a hidden tab for the same reason).
//   · only a widget that is on the grid, LIVE, and has a topic auto-refreshes. A frozen widget is a
//     fixed snapshot; a widget whose data nothing on the stream announces refreshes only on its
//     refresh button.
//   · a failed re-run keeps the last snapshot and does not wedge the widget: the entry is written
//     back either way, which clears its invalidated flag so the next hint is heard again.

import {
	type QueryClient,
	type QueryKey,
	queryOptions,
	skipToken,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { refreshWidgetSource } from "@/app/server/actions/widgets";
import type { ThreadWidget } from "@/lib/db/schema";
import { AGENT_WIDGET_KEY } from "@/lib/query/topics";
import type { Topic } from "@/lib/realtime/topics";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import { WIDGET_REGISTRY } from "./registry";

/** The topic whose hint re-runs this widget's source, or null when nothing announces its data. */
export function widgetTopic(widget: Pick<ThreadWidget, "source">): Topic | null {
	if (!widget.source) return null;
	return WIDGET_REGISTRY[widget.source.tool]?.topic ?? null;
}

/** The widget's Query key: its topic first (so `TOPIC_KEYS` reaches it by prefix), then its owner
 * (the org, or the person for a personal-scope widget) and its id. */
export function widgetQueryKey(widget: Pick<ThreadWidget, "id" | "org_id" | "user_id" | "source">): QueryKey {
	const owner = widget.org_id ?? `user:${widget.user_id}`;
	return [...AGENT_WIDGET_KEY, widgetTopic(widget) ?? "none", owner, widget.id];
}

/** Whether a hint re-runs this widget: it is live and something on the stream announces its data. */
export function autoRefreshes(widget: Pick<ThreadWidget, "source" | "mode">): boolean {
	return widget.mode === "live" && widgetTopic(widget) !== null;
}

/** The widget id an agent-widget key names, or null for any other key. */
function widgetIdOf(key: QueryKey): string | null {
	if (key.length !== 4 || key[0] !== AGENT_WIDGET_KEY[0]) return null;
	const id = key[3];
	return typeof id === "string" ? id : null;
}

/** When a row was last written, as epoch ms (server rows carry Dates; a JSON round trip, strings). */
function writtenAt(row: Pick<ThreadWidget, "updated_at">): number {
	return new Date(row.updated_at).getTime();
}

/**
 * The data a card shows: the refreshed row from Query, unless the grid store holds a NEWER write of
 * the same widget (a re-pin or an artifact edit replaced its payload after the last refresh). Only the
 * payload is taken this way — position, size and mode always come from the store, whose optimistic
 * moves a refreshed row must never undo.
 */
export function liveData(
	fromQuery: Pick<ThreadWidget, "data" | "refreshed_at" | "updated_at"> | undefined,
	fromStore: Pick<ThreadWidget, "data" | "refreshed_at" | "updated_at">,
): Pick<ThreadWidget, "data" | "refreshed_at"> {
	const row = fromQuery && writtenAt(fromQuery) > writtenAt(fromStore) ? fromQuery : fromStore;
	return { data: row.data, refreshed_at: row.refreshed_at };
}

/** What {@link createWidgetRefresher} needs. */
export interface WidgetRefresherOptions {
	/** The org's QueryClient — the one its change stream invalidates. */
	queryClient: QueryClient;
	/** The widgets on the grid right now (read at event time, never captured). */
	widgets: () => readonly ThreadWidget[];
	/** Re-runs one widget's source tool and returns the persisted row (null = gone). */
	run: (id: string) => Promise<ThreadWidget | null>;
	/** Whether the tab is being looked at. */
	isVisible: () => boolean;
}

/** The refresher's surface. */
export interface WidgetRefresher {
	/** Re-run one widget now (the refresh button) — live or frozen, topic or not. */
	refresh(id: string): void;
	/** The tab became visible: re-run, once each, the live widgets a hidden-tab hint reached. */
	onVisible(): void;
	/** Stop listening; a re-run already in flight writes nothing back. */
	dispose(): void;
}

/** Builds the refresher over one org's QueryClient. See the file header for its rules. */
export function createWidgetRefresher(options: WidgetRefresherOptions): WidgetRefresher {
	const { queryClient } = options;
	const inFlight = new Set<string>();
	const again = new Set<string>();
	const dueOnVisible = new Set<string>();
	let disposed = false;

	const find = (id: string) => options.widgets().find((w) => w.id === id);

	const start = (widget: ThreadWidget) => {
		if (inFlight.has(widget.id)) {
			again.add(widget.id);
			return;
		}
		inFlight.add(widget.id);
		const key = widgetQueryKey(widget);
		// Re-seat the entry first: that clears its invalidated flag, so a hint that lands DURING the
		// re-run is heard (an already-invalidated query emits no second invalidation) and queues one
		// follow-up instead of being lost.
		queryClient.setQueryData<ThreadWidget>(key, (old) => old ?? widget);
		void options
			.run(widget.id)
			.catch(() => null)
			.then((row) => {
				inFlight.delete(widget.id);
				if (disposed) return;
				// Written back either way: a failed or empty re-run keeps the last snapshot.
				queryClient.setQueryData<ThreadWidget>(key, (old) => row ?? old ?? widget);
				if (!again.delete(widget.id)) return;
				// The queued follow-up obeys the same rules as a fresh hint: still on the grid, and not
				// in a tab nobody is looking at (it waits for the tab instead).
				const next = find(widget.id);
				if (!next?.source) return;
				if (options.isVisible()) start(next);
				else dueOnVisible.add(next.id);
			});
	};

	const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
		if (disposed || event.type !== "updated" || event.action.type !== "invalidate") return;
		const id = widgetIdOf(event.query.queryKey);
		if (!id) return;
		const widget = find(id);
		if (!widget || !autoRefreshes(widget)) return;
		if (!options.isVisible()) {
			dueOnVisible.add(id);
			return;
		}
		start(widget);
	});

	return {
		refresh(id) {
			const widget = find(id);
			if (widget?.source) start(widget);
		},
		onVisible() {
			if (disposed || !options.isVisible()) return;
			const due = [...dueOnVisible];
			dueOnVisible.clear();
			for (const id of due) {
				const widget = find(id);
				if (widget && autoRefreshes(widget)) start(widget);
			}
		},
		dispose() {
			disposed = true;
			unsubscribe();
			dueOnVisible.clear();
			again.clear();
		},
	};
}

/** Whether this document is being looked at. */
function documentVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Mounts the grid's refresher on the org's QueryClient for as long as the grid is on screen, and
 * returns the refresh-button handler. Hint-driven: there is no interval anywhere in this path.
 */
export function useWidgetLiveRefresh(): (id: string) => void {
	const queryClient = useQueryClient();
	const refresher = useRef<WidgetRefresher | null>(null);

	useEffect(() => {
		const r = createWidgetRefresher({
			queryClient,
			widgets: () => useWidgetGridStore.getState().widgets,
			run: refreshWidgetSource,
			isVisible: documentVisible,
		});
		refresher.current = r;
		const onVisibility = () => r.onVisible();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			r.dispose();
			refresher.current = null;
		};
	}, [queryClient]);

	return useCallback((id: string) => refresher.current?.refresh(id), []);
}

/** The Query options of one widget's payload: seeded with its grid row, never fetched by Query. */
function widgetDataQuery(widget: ThreadWidget) {
	return queryOptions({
		queryKey: widgetQueryKey(widget),
		queryFn: skipToken,
		initialData: widget,
		staleTime: Number.POSITIVE_INFINITY,
	});
}

/**
 * One widget's payload, read from Query (seeded with the grid row, never fetched on mount): what its
 * body renders, what "updated … ago" reads, and what Save copies.
 */
export function useWidgetData(widget: ThreadWidget): Pick<ThreadWidget, "data" | "refreshed_at"> {
	const { data } = useQuery(widgetDataQuery(widget));
	return liveData(data, widget);
}

/** Narrows a cached entry to the row shape `liveData` reads (`useQueries` does not carry each
 * entry's type through a mapped list). */
function isWidgetRow(value: unknown): value is Pick<ThreadWidget, "data" | "refreshed_at" | "updated_at"> {
	return (
		typeof value === "object" &&
		value !== null &&
		"data" in value &&
		typeof value.data === "object" &&
		value.data !== null &&
		"updated_at" in value &&
		(value.updated_at instanceof Date || typeof value.updated_at === "string") &&
		"refreshed_at" in value
	);
}

/** Every grid row with its payload from Query — what saving the whole grid as a dashboard copies. */
export function useLiveWidgets(widgets: ThreadWidget[]): ThreadWidget[] {
	return useQueries({
		queries: widgets.map(widgetDataQuery),
		combine: (results) =>
			widgets.map((w, i) => {
				const fromQuery = results[i]?.data;
				return { ...w, ...liveData(isWidgetRow(fromQuery) ? fromQuery : undefined, w) };
			}),
	});
}
