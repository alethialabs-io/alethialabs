"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useCallback, useEffect, useRef } from "react";
import { refreshWidgetSource } from "@/app/server/actions/widgets";
import { WIDGET_REGISTRY } from "@/components/agent/widgets/registry";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

/** Refresh one widget now and swap the fresh row into the grid store. */
async function refreshOne(id: string): Promise<void> {
	try {
		const row = await refreshWidgetSource(id);
		if (!row) return;
		useWidgetGridStore.setState((s) =>
			s.threadId === row.thread_id
				? { widgets: s.widgets.map((w) => (w.id === row.id ? row : w)) }
				: s,
		);
	} catch {
		// A failed refresh keeps the last snapshot — the widget stays useful.
	}
}

/**
 * The live-widget polling loop: every LIVE widget with a replayable source refetches
 * on its registry cadence (± jitter so a grid of same-kind widgets doesn't thundering-
 * herd), but ONLY while the tab is visible and the grid is mounted. Frozen widgets
 * never poll. Returns a manual `refresh(id)` for the per-widget button.
 */
export function useWidgetRefresh(): (id: string) => void {
	const timers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());

	useEffect(() => {
		const clearAll = () => {
			for (const t of timers.current.values()) clearInterval(t);
			timers.current.clear();
		};

		const arm = () => {
			clearAll();
			if (document.visibilityState !== "visible") return;
			const { widgets } = useWidgetGridStore.getState();
			for (const w of widgets) {
				if (w.mode !== "live" || !w.source) continue;
				const cadence = WIDGET_REGISTRY[w.source.tool]?.refreshIntervalMs;
				if (!cadence) continue;
				const jitter = Math.floor(cadence * 0.1 * Math.random());
				timers.current.set(
					w.id,
					setInterval(() => void refreshOne(w.id), cadence + jitter),
				);
			}
		};

		// Re-arm when the widget set/modes change or the tab becomes visible again.
		const unsub = useWidgetGridStore.subscribe((s, prev) => {
			if (s.widgets !== prev.widgets || s.threadId !== prev.threadId) arm();
		});
		document.addEventListener("visibilitychange", arm);
		arm();
		return () => {
			unsub();
			document.removeEventListener("visibilitychange", arm);
			clearAll();
		};
	}, []);

	return useCallback((id: string) => void refreshOne(id), []);
}
