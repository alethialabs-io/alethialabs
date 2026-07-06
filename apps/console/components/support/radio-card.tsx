"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";

interface RadioCardProps {
	/** Whether this card is the selected option. */
	selected: boolean;
	/** Selects this card. */
	onSelect: () => void;
	/** Primary label. */
	label: string;
	/** Optional secondary/guidance line. */
	description?: string;
}

/**
 * A selectable card acting as one radio option (no native radio-group primitive exists in
 * the design system). Grayscale selected treatment: a solid border + muted fill when active.
 * `aria-pressed` exposes the selection state to assistive tech.
 */
export function RadioCard({ selected, onSelect, label, description }: RadioCardProps) {
	return (
		<button
			type="button"
			aria-pressed={selected}
			onClick={onSelect}
			className={cn(
				"flex w-full flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left transition-colors",
				selected
					? "border-foreground bg-muted"
					: "border-border hover:border-foreground/30 hover:bg-muted/40",
			)}
		>
			<span className="text-sm font-medium leading-none">{label}</span>
			{description && (
				<span className="text-sm text-muted-foreground">{description}</span>
			)}
		</button>
	);
}
