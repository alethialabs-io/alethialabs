"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@repo/ui/utils";

/**
 * The card's box — its padding, border, gap and the two text lines' type. Shared with
 * {@link RadioCardSkeleton}, so the placeholder and the card it stands in for cannot disagree about
 * their size (#6354).
 */
const CARD = "flex w-full flex-col items-start gap-1 rounded-lg border px-4 py-3 text-left";
const LABEL = "text-sm font-medium leading-none";
const DESCRIPTION = "text-sm";

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
				CARD,
				"transition-colors",
				selected
					? "border-foreground bg-muted"
					: "border-border hover:border-foreground/30 hover:bg-muted/40",
			)}
		>
			<span className={LABEL}>{label}</span>
			{description && (
				<span className={cn(DESCRIPTION, "text-muted-foreground")}>{description}</span>
			)}
		</button>
	);
}

/**
 * The loading form of {@link RadioCard}: the same box, with its label and description set in their
 * own type but transparent over a pulse — so it wraps exactly where the real card wraps, and is
 * exactly as tall, at every width (#6354). Not interactive and hidden from assistive tech.
 */
export function RadioCardSkeleton({ label, description }: { label: string; description?: string }) {
	return (
		<div aria-hidden data-slot="radio-card-skeleton" className={cn(CARD, "border-border")}>
			<span className={cn(LABEL, "text-transparent")}>
				<span className="animate-pulse rounded-md bg-accent">{label}</span>
			</span>
			{description && (
				<span className={cn(DESCRIPTION, "text-transparent")}>
					<span className="animate-pulse rounded-md bg-accent box-decoration-clone">{description}</span>
				</span>
			)}
		</div>
	);
}
