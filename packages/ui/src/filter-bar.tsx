// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter-bar shell — encodes the console's toolbar layout convention (wrap-friendly
// row, 10px gaps, bottom margin) so pages stop copy-pasting it. Children read left to
// right: search, then facet controls, then the reset. `end` is a right-aligned slot for
// the rare page-level control (an export button) — never for "N of M" result prose;
// counts belong in the pill next to the section heading.

import { cn } from "./utils";

interface FilterBarProps {
	children: React.ReactNode;
	/** Right-aligned slot, used sparingly (e.g. an Export action). */
	end?: React.ReactNode;
	className?: string;
}

/** The standard filter-bar row: search + facet controls, wrapping on narrow viewports. */
export function FilterBar({ children, end, className }: FilterBarProps) {
	return (
		<div className={cn("mb-4 flex flex-wrap items-center gap-2.5", className)}>
			{children}
			{end && <div className="ml-auto flex items-center gap-2.5">{end}</div>}
		</div>
	);
}

interface FilterBarResetProps {
	/** How many filters differ from their defaults; the button hides at 0. */
	count: number;
	onReset: () => void;
	className?: string;
}

/** The mono "Reset · N" affordance — visible only while any filter is active. */
export function FilterBarReset({ count, onReset, className }: FilterBarResetProps) {
	if (count === 0) return null;
	return (
		<button
			type="button"
			onClick={onReset}
			className={cn(
				"px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground",
				className,
			)}
		>
			Reset · {count}
		</button>
	);
}
