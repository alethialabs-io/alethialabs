// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared Settings layout primitives — the authored claude.ai/design "settings" look,
// built from shadcn/ui + Tailwind token utilities (bg-surface, text-text-tertiary,
// border-border-strong, …). Every settings page composes these; there is no bespoke
// CSS module. Presentational only (server-safe — no hooks).

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page header — mono eyebrow + Geist title + description, with an optional action. */
export function SettingsPageHead({
	eyebrow,
	title,
	description,
	action,
}: {
	eyebrow?: string;
	title: string;
	description?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="mb-7 flex items-end justify-between gap-6">
			<div className="flex flex-col gap-2">
				{eyebrow && <span className="vx-eyebrow">{eyebrow}</span>}
				<h1 className="font-display text-[25px] font-semibold tracking-[-0.02em] text-text-primary">
					{title}
				</h1>
				{description && (
					<p className="max-w-[60ch] text-[13.5px] leading-[1.55] text-text-secondary">
						{description}
					</p>
				)}
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

/** A titled block: Geist h2 + a hairline rule (+ optional trailing action), then content. */
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
		<section className={cn("mb-[22px]", className)}>
			<div className="mb-3 flex items-baseline gap-3">
				<h2 className="font-display text-[14.5px] font-semibold tracking-[-0.01em] text-text-primary">
					{title}
				</h2>
				<span className="h-px flex-1 self-center bg-border" />
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
		<div className="grid grid-cols-[200px_1fr] items-start gap-6 border-b border-border px-[22px] py-[18px] last:border-b-0">
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

/** A horizontal strip of summary stats (the design's `m-stats`). */
export function StatStrip({ children }: { children: ReactNode }) {
	return (
		<div className="mb-[18px] flex overflow-hidden rounded-lg border border-border shadow-sm">
			{children}
		</div>
	);
}

/** One cell of a StatStrip: a mono key, a big value, and an optional sub + track. */
export function StatCell({
	label,
	value,
	sub,
	track,
}: {
	label: string;
	value: ReactNode;
	sub?: ReactNode;
	/** 0–1 fill ratio; renders the thin progress track beneath the value. */
	track?: number;
}) {
	return (
		<div className="flex-1 border-r border-border px-[18px] py-[14px] last:border-r-0">
			<div className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
				{label}
			</div>
			<div className="mt-[7px] flex items-baseline gap-[7px]">
				<span className="font-display text-[22px] font-semibold tracking-[-0.02em] text-text-primary">
					{value}
				</span>
				{sub && <span className="font-mono text-[11px] text-text-tertiary">{sub}</span>}
			</div>
			{track !== undefined && (
				<div className="mt-[11px] h-1 overflow-hidden rounded-full border border-border bg-surface-sunken">
					<div
						className="h-full bg-text-primary"
						style={{ width: `${Math.min(100, Math.max(0, track * 100))}%` }}
					/>
				</div>
			)}
		</div>
	);
}
