"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { buildShortcuts } from "../shortcuts";
import { useIsMac } from "./tool-button";

/**
 * The board's keyboard-shortcut sheet (`?`, the toolbar's keyboard tool, the ⋯ menu, ⌘K).
 *
 * Its rows are read from the shortcut registry when it opens (`buildShortcuts`), so a key the
 * board binds and a key this sheet lists are the same row: there is no list in this file.
 */
export function ShortcutSheet({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isMac = useIsMac();
	const rows = open ? buildShortcuts(isMac) : [];

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
					<DialogDescription className="text-ui-sm">
						A single key works while the focus is on the board, not while you type in a field.
					</DialogDescription>
				</DialogHeader>
				<dl className="max-h-[60vh] space-y-1.5 overflow-y-auto">
					{rows.map((row) => (
						<div key={row.label} className="flex items-center justify-between gap-3 text-sm">
							<dt className="text-muted-foreground">{row.label}</dt>
							<dd>
								<kbd className="whitespace-nowrap border border-border px-1.5 py-0.5 font-mono text-ui-xs">
									{row.keys}
								</kbd>
							</dd>
						</div>
					))}
				</dl>
			</DialogContent>
		</Dialog>
	);
}
