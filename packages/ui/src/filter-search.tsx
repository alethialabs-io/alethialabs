"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The filter bar's free-text input — one search look for every list page (unifies the
// settings-local SettingsSearch and ad-hoc toolbar inputs). Controlled and presentational;
// the caller owns the value (and debounces it before querying).
//
// Two keys (polish-wave spec §3, #7737):
//   - Esc, inside the field, clears it.
//   - `/`, from anywhere on the page that is not an editable element, focuses it — but only with
//     `slashToFocus`. Two searches both bound to `/` would race for one key, so the binding is
//     opt-in, and `ListToolbar` is the one place that opts in: one list toolbar per page, one `/`.

import { Search } from "lucide-react";
import * as React from "react";
import { cn } from "./utils";

interface FilterSearchProps {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name for the input; falls back to the placeholder. */
	ariaLabel?: string;
	/**
	 * Bind `/` on the page to focus this field, and show the `/` key hint. Set by `ListToolbar`;
	 * leave it off anywhere else, so a page never has two searches answering one key.
	 */
	slashToFocus?: boolean;
	className?: string;
}

/**
 * Whether a key pressed with focus on `target` is the user typing, which `/` must not interrupt:
 * a text field, a select, anything `contenteditable`, or an element that declares itself a text
 * box or combobox. Also true inside an open dialog or menu, whose own controls own the keyboard.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	const role = target.getAttribute("role");
	if (role === "textbox" || role === "combobox" || role === "searchbox") return true;
	return target.closest('[contenteditable="true"], [role="dialog"], [role="menu"]') !== null;
}

/**
 * While `enabled`, focuses the element behind `ref` when `/` is pressed with no modifier and focus
 * is not in something the user is typing into. The listener is on `document` for as long as the
 * component is mounted with `enabled`, and is removed on unmount.
 */
function useSlashToFocus(ref: React.RefObject<HTMLInputElement | null>, enabled: boolean) {
	React.useEffect(() => {
		if (!enabled) return;
		/** Moves focus to the field on a bare `/`, swallowing the keystroke so it is not typed. */
		function onKeyDown(event: KeyboardEvent) {
			if (event.key !== "/" || event.defaultPrevented) return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (isTypingTarget(event.target)) return;
			const input = ref.current;
			if (input === null) return;
			event.preventDefault();
			input.focus();
			input.select();
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [ref, enabled]);
}

/** The standard filter-bar search input (icon, sunken field, focus ring, optional `/` hint). */
export function FilterSearch({
	value,
	onChange,
	placeholder,
	ariaLabel,
	slashToFocus = false,
	className,
}: FilterSearchProps) {
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	useSlashToFocus(inputRef, slashToFocus);

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
				aria-keyshortcuts={slashToFocus ? "/" : undefined}
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
			{slashToFocus && (
				// Drawing only: the shortcut reaches assistive tech as `aria-keyshortcuts` above.
				<kbd
					aria-hidden
					data-slot="filter-search-hint"
					className="shrink-0 rounded-sm border border-border px-1.5 font-mono text-ui-2xs leading-4 text-text-tertiary group-focus-within:hidden"
				>
					/
				</kbd>
			)}
		</div>
	);
}
