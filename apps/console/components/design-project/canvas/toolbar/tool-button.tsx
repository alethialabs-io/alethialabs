"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One tool on the board's toolbar (#6832): an icon, a name, the key that does the same thing, a
// pressed state when it is a toggle, and a reason when it cannot be used.
//
// The name is the button's accessible name and the first words of its tooltip; the key is read
// from the shortcut registry by the tool's id, so a tooltip cannot name a key the board does not
// bind. A tool that cannot be used stays on the toolbar, disabled, inside `DisabledReason`: its
// tooltip is then the reason, reachable by hover and by keyboard focus alike.

import { useMemo, type ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { findShortcut, formatChord, type ShortcutChord } from "@/lib/shortcuts/registry";

/** True on macOS and iOS, where the modifier is ⌘ and not Ctrl. False while rendering on a server. */
export function useIsMac(): boolean {
	return useMemo(
		() => typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform),
		[],
	);
}

/**
 * The chord registered under `id`, as a tooltip shows it (`⌘K`, `Ctrl+K`), or null when no row
 * has that id — a tool whose key another file registers shows no key until that file is loaded.
 */
export function shortcutHint(id: string | undefined, isMac: boolean): string | null {
	if (!id) return null;
	const binding = findShortcut(id);
	return binding ? formatChord(binding.chord, isMac) : null;
}

/** How a named key is written in `aria-keyshortcuts`. A key not listed is written upper-cased. */
const ARIA_KEY_NAMES: Record<string, string> = {
	escape: "Escape",
	enter: "Enter",
	delete: "Delete",
	backspace: "Backspace",
	" ": "Space",
};

/** A chord in the `aria-keyshortcuts` grammar: `Meta+K`, `Control+Shift+Z`, `A`. */
export function ariaKeyShortcut(chord: ShortcutChord, isMac: boolean): string {
	const parts: string[] = [];
	if (chord.mod) parts.push(isMac ? "Meta" : "Control");
	if (chord.alt) parts.push("Alt");
	if (chord.shift) parts.push("Shift");
	parts.push(ARIA_KEY_NAMES[chord.key] ?? chord.key.toUpperCase());
	return parts.join("+");
}

/**
 * The classes of a tool that leaves the toolbar when its region is narrow. It needs an ancestor
 * marked `@container`; every tool hidden this way is also a row of the toolbar's own menu and of
 * the command palette, so nothing becomes unreachable.
 */
export const SECONDARY_TOOL = "hidden @xl:inline-flex";

interface ToolButtonProps {
	/** What the tool does: its accessible name and its tooltip. */
	label: string;
	/** The registry id of the key that does the same thing, when there is one. */
	shortcutId?: string;
	onClick: () => void;
	/** For a toggle: whether it is on. Left out, the tool is not a toggle. */
	pressed?: boolean;
	/** For a tool that opens something: whether it is open. */
	expanded?: boolean;
	/** Why the tool cannot be used. Set, the tool is disabled and its tooltip is this sentence. */
	disabledReason?: string | null;
	/** Leaves the toolbar when its region is narrow (see {@link SECONDARY_TOOL}). */
	secondary?: boolean;
	/** The one filled tool on the toolbar: Add. */
	primary?: boolean;
	/** The icon, and for a tool that shows its name, the name after it. */
	children: ReactNode;
	className?: string;
}

/** A toolbar tool. See the file header for what each prop is shown as. */
export function ToolButton({
	label,
	shortcutId,
	onClick,
	pressed,
	expanded,
	disabledReason,
	secondary = false,
	primary = false,
	children,
	className,
}: ToolButtonProps) {
	const isMac = useIsMac();
	const binding = shortcutId ? findShortcut(shortcutId) : undefined;
	const hint = shortcutHint(shortcutId, isMac);
	const button = (
		<Button
			type="button"
			data-tool=""
			variant={primary ? "default" : "ghost"}
			size={primary ? "sm" : "icon"}
			className={cn(
				"h-8 rounded-none",
				primary ? "px-2.5 text-xs" : "w-8",
				pressed && "bg-foreground text-background hover:bg-foreground hover:text-background",
				expanded && !primary && "bg-accent text-accent-foreground",
				secondary && !disabledReason && SECONDARY_TOOL,
				className,
			)}
			aria-label={label}
			aria-pressed={pressed}
			aria-expanded={expanded}
			aria-keyshortcuts={binding ? ariaKeyShortcut(binding.chord, isMac) : undefined}
			onClick={onClick}
		>
			{children}
		</Button>
	);

	if (disabledReason) {
		return (
			<DisabledReason reason={disabledReason} className={secondary ? SECONDARY_TOOL : undefined}>
				{button}
			</DisabledReason>
		);
	}

	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent side="bottom" className="flex items-center gap-2">
				<span>{label}</span>
				{hint && <kbd className="font-mono text-ui-xs">{hint}</kbd>}
			</TooltipContent>
		</Tooltip>
	);
}

/** The line between two groups of tools. `secondary` hides it with the group it leads. */
export function ToolSeparator({ secondary = false }: { secondary?: boolean }) {
	return (
		<span
			aria-hidden
			className={cn("mx-1 h-5 w-px shrink-0 bg-border", secondary ? "hidden @xl:block" : "block")}
		/>
	);
}
