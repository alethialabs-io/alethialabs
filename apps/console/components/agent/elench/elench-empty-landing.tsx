"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatStatus } from "ai";
import { PanelRight } from "lucide-react";
import { AlethiaLogo } from "@repo/brand/alethia-logo";
import type { Mention } from "@/lib/ai/mentions";
import type { AgentThread } from "@/lib/db/schema";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { ElenchComposer } from "./elench-composer";
import type { ElenchSuggestion } from "./elench-suggestions";

/** "9m", "3h", "2d" since a timestamp. */
function relTime(d: Date): string {
	const m = Math.floor((Date.now() - d.getTime()) / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** Local-time greeting ("Good morning/afternoon/evening"). */
function greeting(): string {
	const h = new Date().getHours();
	if (h < 12) return "Good morning.";
	if (h < 18) return "Good afternoon.";
	return "Good evening.";
}

/** The bracketed-point mark as the surface's focal graphic (grayscale, currentColor). */
function ElenchMark({ className }: { className?: string }) {
	return (
		<AlethiaLogo
			aria-hidden
			className={cn("mx-auto text-foreground", className)}
		/>
	);
}

/** A faint grayscale sparkline — decorative demo content for the viz grid. */
function DemoChart() {
	return (
		<svg
			viewBox="0 0 300 150"
			preserveAspectRatio="none"
			className="block h-full w-full text-foreground"
			aria-hidden
		>
			<title>Worker traffic</title>
			<path
				d="M0 122 L20 114 L40 120 L60 101 L80 109 L100 88 L120 96 L140 73 L160 83 L180 59 L200 69 L220 49 L240 43 L260 53 L280 33 L300 40 L300 150 L0 150 Z"
				fill="currentColor"
				fillOpacity="0.06"
			/>
			<path
				d="M0 122 L20 114 L40 120 L60 101 L80 109 L100 88 L120 96 L140 73 L160 83 L180 59 L200 69 L220 49 L240 43 L260 53 L280 33 L300 40"
				fill="none"
				stroke="currentColor"
				strokeOpacity="0.5"
				strokeWidth="2"
				strokeLinejoin="round"
				strokeLinecap="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}

interface ModalLandingProps {
	onSend: (text: string, mentions?: Mention[]) => void;
	suggestions: ElenchSuggestion[];
	/** Recent threads for "Ready to keep going?" (empty → section hidden). */
	recents: AgentThread[];
	onOpenThread: (id: string) => void;
	/** Show the model picker in the hero composer (org only). */
	showModel?: boolean;
	/** The panel-right button in the chip row (docks the surface as a panel). */
	onPanelRight?: () => void;
	status?: ChatStatus;
}

/**
 * The modal empty landing — the hero (mark + "What should we do today?" + composer),
 * suggestion chips, "Ready to keep going?" recents, and the "Draw, describe, go!" viz
 * grid. Ported from the Elench design, rebranded to the grayscale system.
 */
export function ElenchModalLanding({
	onSend,
	suggestions,
	recents,
	onOpenThread,
	showModel,
	onPanelRight,
	status,
}: ModalLandingProps) {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-[830px] px-6 pb-16 pt-24">
				<ElenchMark className="mb-6 h-16 w-auto" />
			<h1 className="mb-10 text-center text-4xl font-semibold tracking-tight">
				What should we do today?
			</h1>

			<ElenchComposer
				onSend={onSend}
				showModel={showModel}
				status={status}
				autoFocus
			/>

			{/* Suggestion chips + panel-right toggle. */}
			<div className="mt-4 flex gap-2.5">
				{suggestions.map((s) => (
					<button
						key={s.title}
						type="button"
						onClick={() => onSend(s.prompt)}
						className="flex min-w-0 flex-1 items-center gap-3 border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:bg-muted"
					>
						<span className="flex size-8 flex-none items-center justify-center border border-border bg-background text-muted-foreground">
							<s.icon className="h-4 w-4" />
						</span>
						<span className="min-w-0">
							<span className="block truncate text-[13px] font-medium text-foreground">
								{s.title}
							</span>
							<span className="block truncate text-xs text-muted-foreground">
								{s.sub}
							</span>
						</span>
					</button>
				))}
				<button
					type="button"
					aria-label="Dock as panel"
					onClick={onPanelRight}
					className="flex w-11 flex-none items-center justify-center border border-border bg-muted/40 text-muted-foreground transition-colors hover:bg-muted"
				>
					<PanelRight className="h-4 w-4" />
				</button>
			</div>

			<DotDivider />

			{/* Ready to keep going — recent threads. */}
			{recents.length > 0 && (
				<section className="border border-border bg-muted/40 p-5">
					<div className="flex items-start justify-between gap-3">
						<div>
							<div className="text-base font-semibold">Ready to keep going?</div>
							<div className="mt-0.5 text-[13px] text-muted-foreground">
								Continue your recent exploration.
							</div>
						</div>
					</div>
					<div className="mt-4 flex gap-3">
						{recents.slice(0, 2).map((t) => (
							<button
								key={t.id}
								type="button"
								onClick={() => onOpenThread(t.id)}
								className="flex min-h-[68px] flex-1 flex-col justify-between border border-border bg-background p-4 text-left transition-colors hover:bg-muted"
							>
								<span className="text-[13px] text-foreground">{t.title}</span>
								<span className="mt-4 font-mono text-[11px] text-muted-foreground">
									{relTime(new Date(t.updated_at))}
								</span>
							</button>
						))}
					</div>
				</section>
			)}

			<DotDivider />

			{/* Draw, describe, go — the visualization grid (decorative demo). */}
			<section className="border border-border bg-muted/40 p-5">
				<div className="flex items-start justify-between gap-3">
					<div>
						<div className="text-base font-semibold">Draw, describe, go.</div>
						<div className="mt-0.5 text-[13px] text-muted-foreground">
							Generate different views of your data using the visualization grid.
						</div>
					</div>
				</div>
				<div className="mt-4 grid grid-cols-3 gap-3.5">
					<div className="flex h-[200px] flex-col overflow-hidden border border-border bg-background p-3">
						<span className="text-xs text-muted-foreground">
							Worker traffic · last 24h
						</span>
						<div className="mt-2 flex-1">
							<DemoChart />
						</div>
					</div>
					<div className="h-[200px] border border-border bg-muted" />
					<div className="h-[200px] border border-dashed border-border" />
				</div>
			</section>
			</div>
		</div>
	);
}

/** The three-dot section separator from the design. */
function DotDivider() {
	return (
		<div className="flex justify-center gap-1.5 py-7">
			{[0, 1, 2].map((i) => (
				<span key={i} className="size-1 rounded-full bg-border" />
			))}
		</div>
	);
}

interface PanelEmptyProps {
	onSend: (text: string, mentions?: Mention[]) => void;
	suggestions: ElenchSuggestion[];
	supportHref?: string;
}

/**
 * The panel empty state — a "Need more help?" banner, the mark + greeting, and the
 * suggestion cards. The docked composer is rendered by the shared chat below this.
 */
export function ElenchPanelEmpty({
	onSend,
	suggestions,
	supportHref,
}: PanelEmptyProps) {
	return (
		<div className="p-3.5">
			<div className="flex items-center justify-between border border-border bg-background px-3.5 py-2.5">
				<span className="text-[13px] text-foreground">Need more help?</span>
				{supportHref && (
					<Button
						asChild
						variant="outline"
						size="xs"
						className="rounded-none"
					>
						<a href={supportHref} target="_blank" rel="noopener noreferrer">
							Support
						</a>
					</Button>
				)}
			</div>

			<div className="py-10 text-center">
				<ElenchMark className="mb-4 h-12 w-auto" />
				<div className="text-lg font-semibold">{greeting()}</div>
				<div className="mt-1 text-sm text-muted-foreground">
					What are we doing today?
				</div>
			</div>

			<div className="flex flex-col gap-2.5">
				{suggestions.map((s) => (
					<button
						key={s.title}
						type="button"
						onClick={() => onSend(s.prompt)}
						className="flex items-center gap-3 border border-border bg-background px-3 py-3 text-left transition-colors hover:bg-muted"
					>
						<span className="flex size-8 flex-none items-center justify-center border border-border text-muted-foreground">
							<s.icon className="h-4 w-4" />
						</span>
						<span className="min-w-0">
							<span className="block text-[13px] font-medium text-foreground">
								{s.title}
							</span>
							<span className="block text-xs text-muted-foreground">
								{s.sub}
							</span>
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
