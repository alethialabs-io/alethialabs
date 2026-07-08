"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Loader2 } from "lucide-react";

/**
 * A lightweight "preparing…" affordance for a HITL proposal tool while its arguments
 * are still streaming in (`input-streaming`), shown in place of the eventual approval/
 * accept card (which renders once the input is complete, at `input-available`). Before
 * this, the custom lanes rendered `null` until the proposal was ready, so it appeared to
 * hang with no feedback. Grayscale and squared, consistent with the AI Elements cards.
 */
export function ToolPending({
	label = "Preparing proposal",
}: {
	label?: string;
}) {
	return (
		<div className="flex w-full items-center gap-2 border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
			<Loader2 className="h-3 w-3 animate-spin" />
			{label}…
		</div>
	);
}
