"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The keyboard way to reorder a dimension or a value (F-29). Drag-to-reorder is pointer-only, so the
// rail and the values list each also carry a "move up" / "move down" pair on every row. Both write
// the same full new order through the same reorder mutation the drop does.

import { ChevronDown, ChevronUp } from "lucide-react";

/** `ids` with `id` moved `by` places (-1 up, +1 down); unchanged when that would leave the list. */
export function movedBy(ids: readonly string[], id: string, by: -1 | 1): string[] {
	const from = ids.indexOf(id);
	const to = from + by;
	if (from < 0 || to < 0 || to >= ids.length) return [...ids];
	const next = [...ids];
	next.splice(from, 1);
	next.splice(to, 0, id);
	return next;
}

/** The shared look of one arrow button. */
const ARROW =
	"grid size-[18px] place-items-center rounded-[2px] text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:text-text-disabled";

/**
 * A stacked "move up" / "move down" pair for the row named `label`. An end of the list has no
 * handler for its direction, and that arrow is rendered disabled rather than removed, so the pair
 * keeps its place and the row does not shift.
 */
export function MoveButtons({
	label,
	onMoveUp,
	onMoveDown,
}: {
	label: string;
	onMoveUp?: () => void;
	onMoveDown?: () => void;
}) {
	return (
		<div className="flex shrink-0 flex-col">
			<button
				type="button"
				aria-label={`Move ${label} up`}
				disabled={!onMoveUp}
				onClick={(e) => {
					e.stopPropagation();
					onMoveUp?.();
				}}
				className={ARROW}
			>
				<ChevronUp className="size-3" aria-hidden />
			</button>
			<button
				type="button"
				aria-label={`Move ${label} down`}
				disabled={!onMoveDown}
				onClick={(e) => {
					e.stopPropagation();
					onMoveDown?.();
				}}
				className={ARROW}
			>
				<ChevronDown className="size-3" aria-hidden />
			</button>
		</div>
	);
}
