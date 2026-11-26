// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter bar's free-text input — one search look for every list page (unifies the
// settings-local SettingsSearch and ad-hoc toolbar inputs). Controlled and presentational;
// the caller owns the value (and debounces it before querying).
//
// Two keys (polish-wave spec §3, #7737):
//   - Esc, inside the field, clears it — an `onKeyDown` on the input itself.
//   - `/` focuses it from anywhere on the page. That one is NOT answered here: a page-level key is
//     a row of the console's shortcut registry (`list.search`, scope `list`), answered by the
//     console's `useListSearchShortcut`, which focuses this input through `inputRef`. This package
//     cannot import the registry, so it only DRAWS the key: the caller passes `shortcut` once the
//     binding is actually live, and the hint and `aria-keyshortcuts` appear with it — never a hint
//     for a key nothing answers.

import { Search } from "lucide-react";
import type * as React from "react";
import { cn } from "./utils";

/** A keyboard shortcut that focuses the search, as the caller's shortcut registry states it. */
export interface FilterSearchShortcut {
	/** The key as drawn in the hint, for this platform: `/`. */
	hint: string;
	/** The same key as the `aria-keyshortcuts` attribute spells it: `/`. */
	ariaKeyShortcuts: string;
}

interface FilterSearchProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name for the input; falls back to the placeholder. */
	ariaLabel?: string;
	/** The input element, for a caller that focuses it (the console's `/` shortcut). */
	inputRef?: React.Ref<HTMLInputElement>;
	/**
	 * The shortcut that focuses this field, once the caller has wired it: shows the key hint and sets
	 * `aria-keyshortcuts`. Leave it out when nothing answers the key.
	 */
	shortcut?: FilterSearchShortcut;
	className?: string;
}

/** The standard filter-bar search input (icon, sunken field, focus ring, optional `/` hint). */
export function FilterSearch({
	value,
	onChange,
	placeholder,
	ariaLabel,
	inputRef,
	shortcut,
	className,
}: FilterSearchProps) {
	return (
		<div
			data-slot="filter-search"
			className={cn(
				"group flex h-9 items-center gap-2 rounded-sm border border-border-strong bg-surface-sunken px-[11px] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15",
				className,
			)}
		>
			<Search className="size-[15px] shrink-0 text-text-tertiary" aria-hidden />
			<input
				ref={inputRef}
				className="w-full min-w-0 border-0 bg-transparent text-ui-md text-text-primary outline-none placeholder:text-text-disabled"
				placeholder={placeholder}
				aria-label={ariaLabel ?? placeholder}
				aria-keyshortcuts={shortcut?.ariaKeyShortcuts}
				autoComplete="off"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Esc clears a non-empty field and stops there, so an enclosing sheet or dialog does
					// not also close on the same key; an empty field lets Esc through untouched.
					if (e.key === "Escape" && value !== "") {
						e.preventDefault();
						e.stopPropagation();
						onChange("");
					}
				}}
			/>
			{shortcut && (
				// Drawing only: the shortcut reaches assistive tech as `aria-keyshortcuts` above.
				<kbd
					aria-hidden
					data-slot="filter-search-hint"
					className="shrink-0 rounded-sm border border-border px-1.5 font-mono text-ui-2xs leading-4 text-text-tertiary group-focus-within:hidden"
				>
					{shortcut.hint}
				</kbd>
			)}
		</div>
	);
}
