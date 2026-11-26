"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CircleAlert } from "lucide-react";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

/**
 * A failed REFRESH behind content already on screen: the content stays, under one polite line with
 * a retry (R6 C-35). Live updates make every change a refetch, so this is the common failure, and
 * replacing good rows with a full error for it would be worse than the failure.
 *
 * One component for every list region that has one: `DataTable` (with the `data-table-stale` slot),
 * the runners grid and the evidence posture, so a grid, a grouped table and a table tell it the
 * same way. Built from a ghost `Button` and a named ink tier, so it adds no colour of its own.
 * Polite (`role="status"`): nothing the viewer had has gone away.
 */
export function StaleRefreshNotice({
	onRetry,
	slot,
	className,
}: {
	/** Re-runs the failed read. */
	onRetry: () => void;
	/** The `data-slot` that names the region's notice, for specs and styles. */
	slot: string;
	className?: string;
}) {
	return (
		<div
			data-slot={slot}
			role="status"
			className={cn(
				"flex flex-wrap items-center justify-between gap-2 text-ui-sm text-text-secondary",
				className,
			)}
		>
			<span className="flex items-center gap-2">
				<CircleAlert className="size-3.5 shrink-0" aria-hidden />
				{"Couldn't refresh — showing earlier data"}
			</span>
			<Button variant="ghost" size="xs" onClick={onRetry}>
				Try again
			</Button>
		</div>
	);
}
