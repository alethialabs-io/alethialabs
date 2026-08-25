// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { cn } from "./utils";

export interface SegmentedOption<T extends string> {
	value: T;
	/** Visible label. Kept short — this control is for two or three choices. */
	label: string;
}

interface SegmentedControlProps<T extends string> {
	options: SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	/** Names the group for assistive tech, e.g. "Currency". */
	label: string;
	/** Mono, uppercase segments — for codes and units (USD/EUR, px/rem). */
	mono?: boolean;
	className?: string;
}

/**
 * A small segmented control for switching between two or three mutually exclusive
 * values.
 *
 * Promoted out of the pricing page's currency toggle, which was the only one of its
 * kind in the app. `ViewToggle` could not serve — it is icon-only and hard-codes
 * card/table as its two options.
 *
 * `aria-pressed` rather than a radiogroup: these are toggle buttons that act
 * immediately, not a form input that gets submitted.
 */
export function SegmentedControl<T extends string>({
	options,
	value,
	onChange,
	label,
	mono = false,
	className,
}: SegmentedControlProps<T>) {
	return (
		<div
			role="group"
			aria-label={label}
			className={cn(
				"inline-flex items-center rounded-md border border-border bg-surface-sunken p-0.5",
				className,
			)}
		>
			{options.map((option) => {
				const active = option.value === value;
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.value)}
						className={cn(
							"vx-clamp vx-clamp--tight rounded px-2.5 py-1 text-[11px] tracking-wide transition-colors duration-[var(--dur-1)] ease-[var(--ease)]",
							mono && "font-mono uppercase",
							active
								? "bg-surface text-text-primary shadow-sm"
								: "text-text-secondary hover:text-text-primary",
						)}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}
