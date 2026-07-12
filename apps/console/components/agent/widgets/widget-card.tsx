"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { GripVertical, Move, Scaling, Trash2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@repo/ui/utils";
import type { ThreadWidget } from "@/lib/db/schema";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import {
	clampToCols,
	collides,
	type GridRect,
	occupancyExcluding,
} from "@/lib/widgets/layout";
import type { DashboardBlock } from "@/types/jsonb.types";
import { DashboardBlockBody } from "./bodies/blocks";
import { WIDGET_REGISTRY } from "./registry";

/** Drag intent a card hands to the grid (which owns the pointer math). */
export type DragMode = "move" | "resize";

/** Whether a widget's stored block payload is present (exploded dashboard widget). */
function blockOf(w: ThreadWidget): DashboardBlock | undefined {
	return w.data.block;
}

/** The widget's body: a dashboard block, or its source tool's registry body. */
function WidgetBody({ widget }: { widget: ThreadWidget }) {
	const block = blockOf(widget);
	if (block) return <DashboardBlockBody block={block} />;
	const def = widget.source ? WIDGET_REGISTRY[widget.source.tool] : undefined;
	if (def && widget.data.output !== undefined) {
		return <def.Body output={widget.data.output} />;
	}
	return (
		<div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
			No renderer for this widget.
		</div>
	);
}

/**
 * One bento-grid widget: hairline card with a mono caption row (drag grip, title,
 * keyboard move/resize, delete) over its registry/block body. Pointer drags are
 * delegated to the grid (`onDragStart`); keyboard mode steps one cell per arrow
 * (Shift = resize), Enter commits, Esc reverts — announced via the grid's live region.
 */
export function WidgetCard({
	widget,
	onDragStart,
	announce,
}: {
	widget: ThreadWidget;
	onDragStart: (e: React.PointerEvent, id: string, mode: DragMode) => void;
	announce: (msg: string) => void;
}) {
	const place = useWidgetGridStore((s) => s.place);
	const remove = useWidgetGridStore((s) => s.remove);
	const widgets = useWidgetGridStore((s) => s.widgets);
	const [kb, setKb] = useState<{ mode: DragMode; rect: GridRect } | null>(null);

	const rect: GridRect = kb?.rect ?? {
		x: widget.pos_x,
		y: widget.pos_y,
		colspan: widget.colspan,
		rowspan: widget.rowspan,
	};

	/** Step the keyboard rect one cell (move) or one span (resize). */
	const step = (dx: number, dy: number, resize: boolean) => {
		if (!kb) return;
		const next = clampToCols(
			resize || kb.mode === "resize"
				? { ...kb.rect, colspan: kb.rect.colspan + dx, rowspan: kb.rect.rowspan + dy }
				: { ...kb.rect, x: kb.rect.x + dx, y: kb.rect.y + dy },
		);
		setKb({ ...kb, rect: next });
		announce(
			`${widget.title}: row ${next.y + 1}, column ${next.x + 1}, ${next.colspan} by ${next.rowspan}`,
		);
	};

	const commitKb = () => {
		if (!kb) return;
		const occ = occupancyExcluding(
			widgets.map((w) => ({
				id: w.id,
				x: w.pos_x,
				y: w.pos_y,
				colspan: w.colspan,
				rowspan: w.rowspan,
			})),
			widget.id,
		);
		if (collides(occ, kb.rect)) {
			announce(`${widget.title}: target occupied — reverted`);
		} else {
			place(widget.id, kb.rect);
			announce(`${widget.title}: placed`);
		}
		setKb(null);
	};

	return (
		<div
			role="group"
			aria-label={widget.title}
			data-testid="widget-card"
			data-widget-id={widget.id}
			style={{
				gridColumn: `${rect.x + 1} / span ${rect.colspan}`,
				gridRow: `${rect.y + 1} / span ${rect.rowspan}`,
			}}
			className={cn(
				"group/widget relative flex min-h-0 flex-col overflow-hidden border border-border bg-background",
				kb && "border-foreground",
			)}
			onKeyDown={(e) => {
				if (!kb) return;
				const d: Record<string, [number, number]> = {
					ArrowLeft: [-1, 0],
					ArrowRight: [1, 0],
					ArrowUp: [0, -1],
					ArrowDown: [0, 1],
				};
				const dir = d[e.key];
				if (dir) {
					e.preventDefault();
					step(dir[0], dir[1], e.shiftKey);
				} else if (e.key === "Enter") {
					e.preventDefault();
					commitKb();
				} else if (e.key === "Escape") {
					e.preventDefault();
					setKb(null);
					announce(`${widget.title}: move cancelled`);
				}
			}}
		>
			<div className="flex h-7 flex-none items-center gap-1.5 border-b border-border px-2">
				<button
					type="button"
					aria-label={`Drag ${widget.title}`}
					className="flex h-full cursor-grab items-center text-muted-foreground hover:text-foreground"
					onPointerDown={(e) => onDragStart(e, widget.id, "move")}
				>
					<GripVertical className="h-3 w-3" />
				</button>
				<span
					title={widget.title}
					className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
				>
					{widget.title}
				</span>
				{widget.mode === "frozen" && (
					<span className="flex-none font-mono text-[9px] text-muted-foreground/70">
						frozen
					</span>
				)}
				<span className="flex flex-none items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/widget:opacity-100">
					<button
						type="button"
						aria-label={`Move ${widget.title} with arrow keys`}
						aria-pressed={kb?.mode === "move"}
						className={cn(
							"flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground",
							kb?.mode === "move" && "text-foreground",
						)}
						onClick={() =>
							setKb(kb?.mode === "move" ? null : { mode: "move", rect })
						}
					>
						<Move className="h-3 w-3" />
					</button>
					<button
						type="button"
						aria-label={`Resize ${widget.title} with arrow keys`}
						aria-pressed={kb?.mode === "resize"}
						className={cn(
							"flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground",
							kb?.mode === "resize" && "text-foreground",
						)}
						onClick={() =>
							setKb(kb?.mode === "resize" ? null : { mode: "resize", rect })
						}
					>
						<Scaling className="h-3 w-3" />
					</button>
					<button
						type="button"
						aria-label={`Remove ${widget.title}`}
						className="flex h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground"
						onClick={() => remove(widget.id)}
					>
						<Trash2 className="h-3 w-3" />
					</button>
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<WidgetBody widget={widget} />
			</div>
			{/* SE resize handle (pointer). */}
			<button
				type="button"
				aria-label={`Resize ${widget.title}`}
				className="absolute bottom-0 right-0 h-3 w-3 cursor-nwse-resize border-l border-t border-border bg-background opacity-0 transition-opacity group-hover/widget:opacity-100"
				onPointerDown={(e) => onDragStart(e, widget.id, "resize")}
			/>
		</div>
	);
}
