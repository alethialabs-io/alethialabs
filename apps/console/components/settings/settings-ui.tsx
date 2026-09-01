// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared Settings layout primitives — the authored claude.ai/design "settings" look,
// built from shadcn/ui + Tailwind token utilities (bg-surface, text-text-tertiary,
// border-border-strong, …). Every settings page composes these; there is no bespoke
// CSS module. Presentational only (server-safe — no hooks).

import { Search } from "lucide-react";
import type { ReactNode } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { PageHeader } from "@repo/ui/page-header";
import { cn } from "@repo/ui/utils";

/** Two-up responsive grid for pairing short sections; stacks on narrow screens. */
export function SettingsColumns({ children }: { children: ReactNode }) {
	return <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">{children}</div>;
}

/**
 * A titled block: a second-level `PageHeader` + a hairline rule (+ optional trailing action),
 * then content.
 *
 * The heading comes from `@repo/ui/page-header` rather than a local `<h2>`, and this one call
 * site is why the rule is worth having: every settings page composes `SettingsSection`, so its
 * hand-written `font-display text-[14.5px]` was one of the five sizes the console rendered the
 * same outline rung at — and the pages that had already adopted `PageHeader` for their titles
 * (members, teams, roles, sso, access) disagreed with their own sections. `level={2}` keeps the
 * document outline exactly as it was; the type scale is now the shared one.
 */
export function SettingsSection({
	title,
	action,
	children,
	className,
}: {
	title: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("mb-[18px]", className)}>
			{/* `items-center`, not `items-baseline`: `PageHeader` is a flex container with its own
			    inner rows, so a parent baseline resolves against its first line box rather than the
			    heading — the hairline rule already asked for `self-center` to work around that. */}
			<div className="mb-3 flex items-center gap-3">
				{/* `min-w-0` and NOT `shrink-0`: `PageHeader` truncates its title and puts the full
				    text in a `title` attribute, but a flex item defaults to `min-width: auto`, so
				    without this the truncation can never fire and a long section title pushes the
				    rule and the action off the row instead. */}
				<PageHeader level={2} title={title} className="min-w-0" />
				<span className="h-px flex-1 bg-border" />
				{action}
			</div>
			{children}
		</section>
	);
}

/** The bordered surface card that holds a section's content. */
export function SettingsPanel({
	children,
	className,
	danger,
}: {
	children: ReactNode;
	className?: string;
	/** Danger variant — a stronger border (the "danger zone" card). */
	danger?: boolean;
}) {
	return (
		<div
			className={cn(
				"rounded-lg border bg-surface shadow-sm",
				danger ? "border-border-strong" : "border-border",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** A labeled form row: 200px label/hint column + a control column. */
export function SettingsField({
	label,
	hint,
	children,
}: {
	label: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="grid grid-cols-[200px_1fr] items-start gap-6 border-b border-border px-[22px] py-[15px] last:border-b-0">
			<div className="flex flex-col gap-1">
				<span className="text-[13px] font-medium text-text-primary">{label}</span>
				{hint && (
					<span className="text-[11.5px] leading-[1.45] text-text-tertiary">
						{hint}
					</span>
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-2">{children}</div>
		</div>
	);
}

/** A footer band inside a panel — a left note + right-aligned actions (e.g. Save). */
export function SettingsCardFoot({
	note,
	children,
}: {
	note?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 border-t border-border bg-surface-sunken px-[22px] py-[13px]">
			{note ? (
				<span className="text-[11.5px] text-text-tertiary">{note}</span>
			) : (
				<span />
			)}
			<div className="flex items-center gap-2">{children}</div>
		</div>
	);
}

/** A danger-zone row inside a danger panel: title/description + a destructive action. */
export function SettingsDangerRow({
	title,
	description,
	children,
}: {
	title: string;
	description: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-5 border-b border-border px-[22px] py-4 last:border-b-0">
			<div className="min-w-0">
				<div className="mb-[3px] text-[13px] font-medium text-text-primary">
					{title}
				</div>
				<div className="max-w-[52ch] text-[11.5px] leading-[1.45] text-text-tertiary">
					{description}
				</div>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}

/**
 * Tailwind classes for a settings form control (input / textarea / select), matching
 * the authored design's filled, squared field. Compose onto native elements or shadcn
 * Input: `className={cn(settingsControl, "...")}`.
 */
export const settingsControl =
	"w-full rounded-sm border border-border-strong bg-surface-sunken text-[13.5px] text-text-primary outline-none transition-[border-color,box-shadow] placeholder:text-text-disabled focus:border-ring focus:ring-2 focus:ring-ring/15";

/** Height + padding for single-line controls (inputs, selects). */
export const settingsControlSize = "h-[38px] px-3";

/**
 * A select built on the shadcn `Select` primitive (proper popover, keyboard nav). An
 * option with an empty-string `value` is treated as the placeholder (Radix forbids
 * empty item values), so existing call sites that pass a `{ value: "", label: "…" }`
 * leading option keep working.
 */
export function SettingsSelect({
	value,
	onChange,
	options,
	className,
	placeholder,
	"aria-label": ariaLabel,
}: {
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
	/** Width/extra classes for the trigger (e.g. `w-[130px]`). Defaults to full width. */
	className?: string;
	placeholder?: string;
	"aria-label"?: string;
}) {
	const ph = placeholder ?? options.find((o) => o.value === "")?.label;
	const items = options.filter((o) => o.value !== "");
	return (
		<Select value={value || undefined} onValueChange={onChange}>
			<SelectTrigger aria-label={ariaLabel} className={cn("w-full", className)}>
				<SelectValue placeholder={ph} />
			</SelectTrigger>
			<SelectContent>
				{items.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** A segmented count-tabs control (the design's `.tabs`). */
export function SettingsTabs<T extends string>({
	value,
	onChange,
	tabs,
}: {
	value: T;
	onChange: (value: T) => void;
	tabs: { value: T; label: string; count?: number }[];
}) {
	return (
		<div className="inline-flex gap-0.5 rounded-sm border border-border-strong bg-surface-sunken p-[3px]">
			{tabs.map((t) => {
				const on = t.value === value;
				return (
					<button
						key={t.value}
						type="button"
						onClick={() => onChange(t.value)}
						className={cn(
							"inline-flex items-center gap-[7px] rounded-[4px] px-3 py-1.5 text-[12.5px] font-medium capitalize transition-colors",
							on
								? "bg-surface text-text-primary shadow-sm"
								: "text-text-tertiary hover:text-text-secondary",
						)}
					>
						{t.label}
						{t.count !== undefined && (
							<span className="font-mono text-[10px] text-text-tertiary">
								{t.count}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}

/** A search box (icon + borderless input) matching the design's `.search`. */
export function SettingsSearch({
	value,
	onChange,
	placeholder,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	className?: string;
}) {
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
				autoComplete="off"
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</div>
	);
}

// `StatStrip` and `StatCell` used to live here — a container of flex-1 cells, each a mono key
// over a 22px display figure. They are deleted rather than migrated: §6 bans stat-card strips
// with no qualifier, and these two had NO call site in the console at all, so the whole cost of
// keeping them was that the next settings page needed one import to grow a strip.
//
// Worth knowing if you are reading this from the guard: `check:shared-surface` did not see them.
// Its primitive matcher is `function Stat(`, which `function StatCell(` and `function StatStrip(`
// both slip past, and its cell matcher is `<Stat` followed by whitespace or `>`, which `<StatCell`
// slips past for the same reason. The banned shape was two renames away from being invisible, and
// here it already was.
