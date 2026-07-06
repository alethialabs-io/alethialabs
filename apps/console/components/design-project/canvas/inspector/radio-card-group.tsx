"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRef } from "react";
import { cn } from "@repo/ui/utils";

/** One selectable card: a title, an optional description, and its stored value. */
export interface RadioCardOption {
	value: string;
	label: string;
	description?: string;
}

/**
 * A keyboard-navigable radio-card selector for mutually-exclusive choices. Each card shows a
 * title + description; the selected card gets a filled radio dot and a highlighted border.
 * Roving tabindex + arrow keys move (and select) between cards. Controlled via `value`/`onChange`.
 */
export function RadioCardGroup({
	value,
	onChange,
	options,
	columns = 1,
	ariaLabel,
}: {
	value: string;
	onChange: (value: string) => void;
	options: RadioCardOption[];
	/** 1 = stacked (default), 2 = two-up grid on wider layouts. */
	columns?: 1 | 2;
	ariaLabel?: string;
}) {
	const refs = useRef<(HTMLButtonElement | null)[]>([]);

	/** Arrow keys move the active card, wrapping, and select as they go. */
	const onKeyDown = (e: React.KeyboardEvent, index: number) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const delta = e.key === "ArrowDown" ? 1 : -1;
		const next = (index + delta + options.length) % options.length;
		onChange(options[next].value);
		refs.current[next]?.focus();
	};

	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			className={cn("grid gap-2", columns === 2 && "sm:grid-cols-2")}
		>
			{options.map((opt, i) => {
				const selected = opt.value === value;
				return (
					<button
						key={opt.value}
						ref={(el) => {
							refs.current[i] = el;
						}}
						type="button"
						role="radio"
						aria-checked={selected}
						tabIndex={selected || (!value && i === 0) ? 0 : -1}
						onClick={() => onChange(opt.value)}
						onKeyDown={(e) => onKeyDown(e, i)}
						className={cn(
							"flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							selected
								? "border-foreground/40 bg-muted/40 ring-1 ring-foreground/20"
								: "border-border hover:bg-muted/30",
						)}
					>
						<span
							className={cn(
								"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
								selected ? "border-foreground" : "border-muted-foreground/40",
							)}
						>
							{selected && <span className="h-2 w-2 rounded-full bg-foreground" />}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-sm font-medium text-foreground">
								{opt.label}
							</span>
							{opt.description && (
								<span className="mt-0.5 block text-xs text-muted-foreground">
									{opt.description}
								</span>
							)}
						</span>
					</button>
				);
			})}
		</div>
	);
}
