"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A typeahead multi-select: the trigger *is* a fixed-width text input — you type into it directly to
// filter (no separate search box, no checkboxes). When empty it shows the `placeholder` (e.g. "All
// authors"); selected rows get a right-aligned check in a reserved slot so nothing reflows. Typed
// text and the selected summary truncate — the control never changes width. Used by the jobs filters.

import { Check, ChevronDown, Loader2, Plus, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { cn } from "./utils";

export interface ComboboxOption {
	value: string;
	label: string;
	/** Optional secondary text shown muted after the label (e.g. an email). */
	hint?: string;
	/** Avatar URL — rendered when the combobox has `withAvatar` (falls back to an initials circle). */
	image?: string | null;
}

interface MultiComboboxProps {
	options: ComboboxOption[];
	value: string[];
	onChange: (next: string[]) => void;
	/** Shown when nothing is selected (e.g. "All authors"). */
	placeholder: string;
	icon?: LucideIcon;
	align?: "start" | "center" | "end";
	className?: string;
	/** Render a leading avatar per row (img, else an initials circle from the label). */
	withAvatar?: boolean;
	/** While true, an empty list shows "Loading…" instead of the empty state. */
	loading?: boolean;
	/** Action offered when the (filtered) list is empty — e.g. "Create project". */
	emptyAction?: { label: string; onSelect: () => void };
}

/** A small avatar for an option row: the image, else an initials circle from the label. */
function OptionAvatar({ image, label }: { image?: string | null; label: string }) {
	return (
		<Avatar className="size-5 shrink-0 border border-border">
			<AvatarImage src={image ?? undefined} alt="" />
			<AvatarFallback className="font-mono text-[9px] text-muted-foreground">
				{label.slice(0, 1).toUpperCase()}
			</AvatarFallback>
		</Avatar>
	);
}

/** A searchable, checkbox-free, fixed-width multi-select. Selecting toggles; the list stays open. */
export function MultiCombobox({
	options,
	value,
	onChange,
	placeholder,
	icon: Icon,
	align = "start",
	className,
	withAvatar = false,
	loading = false,
	emptyAction,
}: MultiComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const selected = new Set(value);

	const q = query.trim().toLowerCase();
	const filtered = q
		? options.filter((o) =>
				`${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q),
			)
		: options;

	// The summary the input shows (as its placeholder) when not actively typing.
	const summary =
		value.length === 0
			? placeholder
			: value.length === 1
				? (options.find((o) => o.value === value[0])?.label ?? "1 selected")
				: `${value.length} selected`;

	function toggle(v: string) {
		const next = new Set(selected);
		if (next.has(v)) next.delete(v);
		else next.add(v);
		onChange([...next]);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				if (!o) setQuery("");
			}}
		>
			<PopoverAnchor asChild>
				<div
					className={cn(
						"flex h-8 w-40 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs transition-colors focus-within:border-text-primary",
						className,
					)}
				>
					{Icon && <Icon size={14} className="shrink-0 text-muted-foreground" />}
					<input
						className="min-w-0 flex-1 truncate bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
						placeholder={summary}
						value={query}
						onChange={(e) => {
							setQuery(e.target.value);
							setOpen(true);
						}}
						onFocus={() => setOpen(true)}
					/>
					<ChevronDown size={13} className="shrink-0 text-muted-foreground" />
				</div>
			</PopoverAnchor>
			<PopoverContent
				align={align}
				onOpenAutoFocus={(e) => e.preventDefault()}
				className="w-[var(--radix-popover-trigger-width)] min-w-[200px] p-1"
			>
				<div className="max-h-64 overflow-y-auto">
					{filtered.length === 0 ? (
						loading ? (
							<div className="flex items-center justify-center gap-2 px-2 py-3 text-xs text-muted-foreground">
								<Loader2 className="size-3.5 animate-spin" />
								Loading…
							</div>
						) : emptyAction ? (
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									emptyAction.onSelect();
									setOpen(false);
								}}
								className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent"
							>
								<Plus className="size-3.5 shrink-0" />
								{emptyAction.label}
							</button>
						) : (
							<div className="px-2 py-3 text-center text-xs text-muted-foreground">
								No matches.
							</div>
						)
					) : (
						filtered.map((o) => {
							const on = selected.has(o.value);
							return (
								<button
									key={o.value}
									type="button"
									// Keep focus in the input so multi-select stays typeable.
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => toggle(o.value)}
									className={cn(
										"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
										on && "bg-accent/40",
									)}
								>
									{withAvatar && <OptionAvatar image={o.image} label={o.label} />}
									<span className="min-w-0 flex-1 truncate text-foreground">
										{o.label}
									</span>
									{o.hint && (
										<span className="shrink-0 truncate font-mono text-[10.5px] text-muted-foreground">
											{o.hint}
										</span>
									)}
									{/* Reserved check slot — present always so selecting never reflows the row. */}
									<span className="flex size-3.5 shrink-0 items-center justify-center">
										{on && <Check size={13} className="text-foreground" />}
									</span>
								</button>
							);
						})
					)}
				</div>
				{value.length > 0 && (
					<div className="mt-1 border-t border-border pt-1">
						<button
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => onChange([])}
							className="w-full rounded-sm px-2 py-1.5 text-center text-[12px] text-muted-foreground transition-colors hover:bg-accent"
						>
							Clear {value.length} selected
						</button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
