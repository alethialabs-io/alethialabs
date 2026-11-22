"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Info, X } from "lucide-react";
import { Button } from "@repo/ui/button";

/**
 * One plain sentence about the starting point a link carried (#6836): why it was not applied, or
 * that its content is still on the way. Top-centre, under the toolbar, above the cards; it never
 * covers the board's controls and never blocks the board. Announced politely — the board is usable
 * whether or not it is read — and dismissed with its own button.
 *
 * `inRegion` is how the board's host places it (#6832): drawn in the flow of the toolbar's region,
 * under the toolbar, it cannot land on whatever else opens there. Without it the notice places
 * itself at a fixed offset from the top of the nearest positioned ancestor.
 */
export function SeedNotice({
	sentence,
	onDismiss,
	inRegion = false,
}: {
	sentence: string;
	onDismiss: () => void;
	inRegion?: boolean;
}) {
	return (
		<div
			data-slot="board-seed-notice"
			className={
				inRegion
					? "pointer-events-none flex max-w-full justify-center"
					: "pointer-events-none absolute inset-x-0 top-14 z-[var(--z-raised)] flex justify-center px-3"
			}
		>
			<div
				role="status"
				className="pointer-events-auto flex max-w-xl items-start gap-2.5 border border-border bg-background p-2.5 shadow-sm"
			>
				<Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
				<p className="text-ui-sm text-foreground">{sentence}</p>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Dismiss"
					onClick={onDismiss}
				>
					<X aria-hidden />
				</Button>
			</div>
		</div>
	);
}
