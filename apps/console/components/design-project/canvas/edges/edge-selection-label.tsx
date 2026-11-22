"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EdgeLabelRenderer } from "@xyflow/react";
import { Unlink } from "lucide-react";
import { Button } from "@repo/ui/button";
import type { BoardEdgeData } from "./board-edges";
import { useBoardConnections } from "./connection-context";

/**
 * What a SELECTED edge shows at its midpoint: the control that removes it, or — for a line the
 * board cannot remove — the sentence that says where it is changed. A selected line with nothing
 * on it would be a selection that offers no next step.
 *
 * The same removal is on the Delete key; this is its pointer form, and it is a real button, so it
 * is also reachable by Tab.
 *
 * It is lifted to `--z-raised`. React Flow draws edge labels in a layer BELOW the cards, and both
 * sit in the viewport's one stacking context, so on a short line the midpoint falls on a card — in
 * the first browser run (#7132) on the target card's connection handle, whose hit area reaches 10px
 * past it — and the card took every click meant for the button. Raised, the label is above any card
 * that is not itself selected (React Flow lifts a selected card to 1000).
 */
export function EdgeSelectionLabel({
	edgeId,
	x,
	y,
	data,
}: {
	edgeId: string;
	x: number;
	y: number;
	data: BoardEdgeData | undefined;
}) {
	const { remove } = useBoardConnections();
	const count = data?.count ?? 1;
	const locked = data?.locked ?? null;
	return (
		<EdgeLabelRenderer>
			<div
				className="nodrag nopan pointer-events-auto absolute z-[var(--z-raised)]"
				style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
			>
				{locked ? (
					<p className="max-w-56 border border-border bg-background px-2 py-1 text-ui-xs text-muted-foreground">
						{locked}
					</p>
				) : (
					<Button
						type="button"
						variant="outline"
						size="xs"
						className="bg-background"
						onClick={() => remove(edgeId)}
					>
						<Unlink aria-hidden="true" />
						{count > 1 ? `Remove ${count} connections` : "Remove connection"}
					</Button>
				)}
			</div>
		</EdgeLabelRenderer>
	);
}
