// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter bar's free-text input — one search look for every list page (unifies the
// settings-local SettingsSearch and ad-hoc toolbar inputs). Controlled and presentational;
// the caller owns the value (and debounces it before querying).

import { Search } from "lucide-react";
import { cn } from "./utils";

interface FilterSearchProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name for the input; falls back to the placeholder. */
	ariaLabel?: string;
	className?: string;
}

/** The standard filter-bar search input (icon, sunken field, focus ring). */
export function FilterSearch({
	value,
	onChange,
	placeholder,
	ariaLabel,
	className,
}: FilterSearchProps) {
	return (
		<div
			className={cn(
				"flex h-9 items-center gap-2 rounded-sm border border-border-strong bg-surface-sunken px-[11px] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15",
				className,
			)}
		>
			<Search className="size-[15px] shrink-0 text-text-tertiary" />
			<input
				className="w-full border-0 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-disabled"
				placeholder={placeholder}
				aria-label={ariaLabel ?? placeholder}
				autoComplete="off"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}
