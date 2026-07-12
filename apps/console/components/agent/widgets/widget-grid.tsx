"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LayoutDashboard } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ScrollArea } from "@repo/ui/scroll-area";
import { cn } from "@repo/ui/utils";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import {
	buildOccupancy,
	clampToCols,
	collides,
	GRID_COLS,
	type GridRect,
	occupancyExcluding,
} from "@/lib/widgets/layout";
import { useWidgetRefresh } from "@/hooks/use-widget-refresh";
import { ArtifactBrowser, SaveArtifactButton } from "./artifact-controls";
import { CellPrompt } from "./cell-prompt";
import { type DragMode, WidgetCard } from "./widget-card";

/** Fixed row height (px) — pairs with `gap-2` (8px) for the cell math. */
const ROW_H = 88;
const GAP = 8;

interface DragState {
	id: string;
	mode: DragMode;
	/** The candidate rect under the pointer. */
	rect: GridRect;
	valid: boolean;
	/** Pointer-grab offset in cells (move only). */
	grab: { dx: number; dy: number };
	start: GridRect;
}

/**
 * The per-chat bento canvas: a fixed 5-column CSS grid that grows downward inside its
 * own scroll area. Widgets land via auto-pin / pin_widget (first-fit) and are dragged/
 * resized with pointer capture — a ghost outline previews the target region and the
 * drop commits only when collision-free (else snaps back). Keyboard move/resize lives
 * on each card; placements announce through the polite live region here.
 */
export function WidgetGrid({ className }: { className?: string }) {
	const widgets = useWidgetGridStore((s) => s.widgets);
	const loading = useWidgetGridStore((s) => s.loading);
	const threadId = useWidgetGridStore((s) => s.threadId);
	const place = useWidgetGridStore((s) => s.place);
	const containerRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [liveMsg, setLiveMsg] = useState("");
	// Live widgets poll on their registry cadence while the tab is visible.
	const refresh = useWidgetRefresh();
	const cellPrompt = useWidgetGridStore((s) => s.cellPrompt);
	const setCellPrompt = useWidgetGridStore((s) => s.setCellPrompt);
	const maxRow = widgets.reduce((m, w) => Math.max(m, w.pos_y + w.rowspan), 0);

	const announce = useCallback((msg: string) => setLiveMsg(msg), []);

	/** The grid cell under a pointer event (unclamped). */
	const cellAt = useCallback((e: { clientX: number; clientY: number }) => {
		const el = containerRef.current;
		if (!el) return { x: 0, y: 0 };
		const r = el.getBoundingClientRect();
		const cellW = (r.width - GAP * (GRID_COLS - 1)) / GRID_COLS;
		return {
			x: Math.floor((e.clientX - r.left) / (cellW + GAP)),
			y: Math.floor((e.clientY - r.top) / (ROW_H + GAP)),
		};
	}, []);

	const rectsOf = useCallback(
		() =>
			widgets.map((w) => ({
				id: w.id,
				x: w.pos_x,
				y: w.pos_y,
				colspan: w.colspan,
				rowspan: w.rowspan,
			})),
		[widgets],
	);

	const onDragStart = useCallback(
		(e: React.PointerEvent, id: string, mode: DragMode) => {
			const w = widgets.find((x) => x.id === id);
			if (!w) return;
			e.preventDefault();
			const start: GridRect = {
				x: w.pos_x,
				y: w.pos_y,
				colspan: w.colspan,
				rowspan: w.rowspan,
			};
			const cell = cellAt(e);
			setDrag({
				id,
				mode,
				rect: start,
				valid: true,
				grab: { dx: cell.x - start.x, dy: cell.y - start.y },
				start,
			});
			const occ = occupancyExcluding(rectsOf(), id);

			const onMove = (ev: PointerEvent) => {
				const c = cellAt(ev);
				setDrag((d) => {
					if (!d) return d;
					const next = clampToCols(
						d.mode === "move"
							? { ...d.rect, x: c.x - d.grab.dx, y: c.y - d.grab.dy }
							: {
									...d.rect,
									colspan: c.x - d.start.x + 1,
									rowspan: c.y - d.start.y + 1,
								},
					);
					return { ...d, rect: next, valid: !collides(occ, next) };
				});
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				setDrag((d) => {
					if (d && d.valid) place(d.id, d.rect);
					return null;
				});
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[widgets, cellAt, rectsOf, place],
	);

	return (
		<ScrollArea className={cn("h-full", className)}>
			<div className="p-4">
				<div className="mb-2 flex items-center justify-between">
					<span className="vx-eyebrow text-[9px]">Grid</span>
					<span className="flex items-center gap-1.5">
						<ArtifactBrowser threadId={threadId} />
						<SaveArtifactButton widgets={widgets} kind="dashboard" />
					</span>
				</div>
				{widgets.length === 0 && !loading && (
					<div className="flex flex-col items-center gap-2 border border-dashed border-border py-16 text-center">
						<LayoutDashboard className="h-4 w-4 text-muted-foreground" />
						<div className="text-[13px] text-foreground">The grid is empty.</div>
						<div className="max-w-[260px] text-xs text-muted-foreground">
							Ask Elench for your clusters, jobs, usage, or a full dashboard —
							structured results pin here as widgets.
						</div>
					</div>
				)}
				{/* biome-ignore lint: background click opens the cell composer; keyboard users
			    reach the same flow through the chat composer. */}
				<div
					ref={containerRef}
					data-testid="widget-grid"
					className="relative grid grid-cols-5 gap-2"
					style={{
						gridAutoRows: `${ROW_H}px`,
						// Keep one clickable empty row below the content so "describe what goes
						// here…" always has somewhere to land.
						minHeight: (maxRow + 1) * (ROW_H + GAP),
					}}
					onClick={(e) => {
						// Only clicks on the grid BACKGROUND (not cards) open the composer.
						if (e.target !== containerRef.current) return;
						const cell = cellAt(e);
						const occ = buildOccupancy(rectsOf());
						if (collides(occ, { ...cell, colspan: 1, rowspan: 1 })) return;
						setCellPrompt({ x: Math.min(cell.x, GRID_COLS - 1), y: cell.y });
					}}
				>
					{widgets.map((w) => (
						<WidgetCard
							key={w.id}
							widget={w}
							onDragStart={onDragStart}
							announce={announce}
							onRefresh={refresh}
						/>
					))}
					{cellPrompt && <CellPrompt cell={cellPrompt} />}
					{/* Drop-target ghost while dragging. */}
					{drag && (
						<div
							aria-hidden
							className={cn(
								"pointer-events-none border border-dashed",
								drag.valid ? "border-foreground/60" : "border-foreground/20",
							)}
							style={{
								gridColumn: `${drag.rect.x + 1} / span ${drag.rect.colspan}`,
								gridRow: `${drag.rect.y + 1} / span ${drag.rect.rowspan}`,
							}}
						/>
					)}
				</div>
				{/* Keyboard placement announcements. */}
				<div aria-live="polite" className="sr-only">
					{liveMsg}
				</div>
			</div>
		</ScrollArea>
	);
}
