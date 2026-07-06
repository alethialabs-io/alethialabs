"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronsUpDown } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { PopoverTrigger } from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";

/** Where the trigger renders — `sidebar` (full-width org row) or `topbar` (compact quick-switcher). */
type SwitcherTriggerVariant = "sidebar" | "topbar";

type SwitcherTriggerProps = {
	/** Layout/sizing preset for the trigger row. */
	variant: SwitcherTriggerVariant;
	/** Popover open state — drives `aria-expanded`. */
	open: boolean;
	/** Leading visual: an `OrgAvatar` (sidebar) or a boxed lucide icon (topbar). Optional —
	 * omit for a bare label (the topbar project switcher). */
	leading?: ReactNode;
	/** Two-line caption shown above the label on the topbar variant ("Project" | "Env"). */
	caption?: string;
	/** The current selection name. */
	label: string;
	/** Trailing badge (e.g. the org plan pill) — sidebar only. */
	badge?: ReactNode;
	/** When set, the body becomes a `<Link href>` (navigates) and only the chevron opens the
	 * popover — i.e. a split button. When absent, the whole row opens the popover. */
	href?: string;
	/** Accessible label for the chevron button in split mode, e.g. "Switch organization". */
	ariaLabel?: string;
};

/**
 * The shared trigger row for every shell switcher (org / project / env). Renders a consistent
 * leading visual + label (optionally a two-line caption) + a single `ChevronsUpDown` open icon, so
 * all switchers look and behave identically. Pass `href` to make it a split button: the body links
 * to `href` and only the chevron toggles the popover (the org picker); omit it and the whole row
 * toggles the popover (the topbar project/env switchers). Must render inside a `<Popover>`.
 */
export function SwitcherTrigger({
	variant,
	open,
	leading,
	caption,
	label,
	badge,
	href,
	ariaLabel,
}: SwitcherTriggerProps) {
	const labelBlock = caption ? (
		<span className="flex min-w-0 flex-col items-start leading-tight">
			<span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground/70">
				{caption}
			</span>
			<span className="max-w-[10rem] truncate text-[13px] font-medium text-foreground">
				{label}
			</span>
		</span>
	) : (
		<span className="min-w-0 flex-1 truncate text-left text-[13.5px] font-medium">
			{label}
		</span>
	);

	const chevron = (
		<ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
	);

	// Split button (org): the body navigates, only the chevron opens the popover.
	if (href) {
		return (
			<div className="flex w-full items-center gap-1">
				<Button
					asChild
					variant="ghost"
					className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-2.5 py-2"
				>
					<Link href={href}>
						{leading}
						{labelBlock}
						{badge}
					</Link>
				</Button>
				<PopoverTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						role="combobox"
						aria-expanded={open}
						aria-label={ariaLabel}
						className="shrink-0"
					>
						{chevron}
					</Button>
				</PopoverTrigger>
			</div>
		);
	}

	// Whole-row trigger (project / env): clicking anywhere opens the popover.
	return (
		<PopoverTrigger asChild>
			<Button
				variant="ghost"
				role="combobox"
				aria-expanded={open}
				className={cn(
					"h-auto",
					variant === "sidebar"
						? "w-full justify-start gap-2.5 px-2.5 py-2"
						: "gap-2 px-2 py-1.5",
				)}
			>
				{leading}
				{labelBlock}
				{badge}
				{chevron}
			</Button>
		</PopoverTrigger>
	);
}
