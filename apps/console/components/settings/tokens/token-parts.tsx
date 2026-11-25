// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Small presentational pieces the service tokens page repeats: the environment stage pill, the
// inline notice, and the dotted rule list. No "use client": none of them holds state.

import type { EnvironmentStage } from "@/lib/db/schema/enums";
import { cn } from "@repo/ui/utils";
import type { ReactNode } from "react";

/** What each stage is called on a pill. */
const STAGE_LABEL: Record<EnvironmentStage, string> = {
	development: "Development",
	staging: "Staging",
	production: "Production",
};

/**
 * An environment's stage as a mono pill. Production is the one FILLED ink pill — seriousness without
 * colour (design §0) — so it reads differently from the other two at a glance and in grayscale.
 */
export function StagePill({ stage, className }: { stage: EnvironmentStage; className?: string }) {
	return (
		<span
			data-stage={stage}
			className={cn(
				"inline-flex h-[18px] shrink-0 items-center whitespace-nowrap rounded-sm border px-1.5 font-mono text-ui-2xs uppercase tracking-[0.08em]",
				stage === "production"
					? "border-ink bg-ink font-medium text-ink-foreground"
					: "border-border-strong text-text-secondary",
				className,
			)}
		>
			{STAGE_LABEL[stage]}
		</span>
	);
}

/**
 * A notice inside a form: an icon, a bold title and one sentence. Not an `Alert` — that primitive is
 * `role="alert"`, which would interrupt a screen reader on every open for a fact that is not news.
 * The caller ties it to its control with `aria-describedby` through `id`.
 */
export function TokenNotice({
	id,
	icon,
	title,
	children,
	className,
}: {
	id?: string;
	icon: ReactNode;
	title: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			id={id}
			data-slot="token-notice"
			className={cn(
				"flex items-start gap-2.5 rounded-sm border border-border-strong bg-surface-sunken px-3 py-2.5 text-ui-md",
				className,
			)}
		>
			<span className="mt-0.5 shrink-0 text-text-secondary [&>svg]:size-3.5" aria-hidden>
				{icon}
			</span>
			<div className="min-w-0">
				<p className="font-medium text-text-primary">{title}</p>
				<p className="mt-0.5 text-text-secondary">{children}</p>
			</div>
		</div>
	);
}

/**
 * A short list of facts, each behind a middle dot (the design's consequence list). The caller passes
 * the `<li>` elements, so each keeps a key of its own.
 */
export function RuleList({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<ul
			className={cn(
				"flex flex-col gap-1.5 text-ui-sm text-text-secondary",
				"[&>li]:relative [&>li]:pl-3 [&>li]:before:absolute [&>li]:before:left-0.5 [&>li]:before:font-semibold [&>li]:before:text-text-primary [&>li]:before:content-['·']",
				className,
			)}
		>
			{children}
		</ul>
	);
}
