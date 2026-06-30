"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { ConnTestPhase } from "./use-connection-test";

/** Live seconds since `startedAt`, ticking once a second (0 when not started). */
function useElapsedSeconds(startedAt?: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!startedAt) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [startedAt]);
	return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
}

/** Formats seconds as `m:ss`. */
function mmss(total: number): string {
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

type CalloutVariant = "success" | "pending" | "error";

const VARIANT_STYLES: Record<
	CalloutVariant,
	{ box: string; icon: ReactNode; title: string }
> = {
	success: {
		box: "bg-muted/50 border-border",
		icon: <CheckCircle2 className="size-5 shrink-0 text-foreground" />,
		title: "text-foreground",
	},
	pending: {
		box: "bg-muted/30 border-border/40",
		icon: (
			<Loader2 className="size-5 shrink-0 animate-spin text-muted-foreground" />
		),
		title: "text-foreground",
	},
	error: {
		box: "bg-destructive/5 border-destructive/20",
		icon: <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />,
		title: "text-destructive",
	},
};

/**
 * The status banner shown inside a connect flow while saving / after a
 * verification attempt. Shared across every provider connection component so the
 * success / pending / error states look identical everywhere.
 */
export function StatusCallout({
	variant,
	title,
	children,
}: {
	variant: CalloutVariant;
	title: string;
	children: ReactNode;
}) {
	const s = VARIANT_STYLES[variant];
	return (
		<div
			className={cn(
				"flex gap-3 rounded-md border p-4",
				variant === "error" ? "items-start" : "items-center",
				s.box,
			)}
		>
			{s.icon}
			<div>
				<p className={cn("text-sm font-medium", s.title)}>{title}</p>
				<p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
			</div>
		</div>
	);
}

/**
 * Renders the in-progress / done states of a CONNECTION_TEST (driven by
 * `useConnectionTest`): a `queued` "waiting for a runner" hint (with the
 * always-present Cancel so the flow can never get stuck), `testing`, `saving`, and
 * `success`. The caller handles `idle`/`failed` by showing its credential form.
 */
export function ConnectionTestStatus({
	phase,
	successText,
	verifyingText,
	onCancel,
	startedAt,
}: {
	phase: ConnTestPhase;
	successText: string;
	verifyingText: string;
	onCancel: () => void;
	startedAt?: number;
}) {
	const elapsed = useElapsedSeconds(phase === "success" ? undefined : startedAt);

	if (phase === "success") {
		return (
			<StatusCallout variant="success" title="Connection verified">
				{successText}
			</StatusCallout>
		);
	}
	if (phase === "saving") {
		return (
			<StatusCallout variant="pending" title="Saving…">
				Storing your credentials.
			</StatusCallout>
		);
	}

	const isQueued = phase === "queued";
	const base = isQueued ? "Waiting for a runner" : "Verifying connection";
	const title = startedAt ? `${base} · ${mmss(elapsed)}` : base;
	const escalation =
		isQueued && elapsed > 15
			? "A managed runner is starting up — this can take a minute."
			: !isQueued && elapsed > 45
				? "First-time verification can take a couple of minutes while the cloud propagates the trust."
				: null;

	return (
		<div className="space-y-3">
			<StatusCallout variant="pending" title={title}>
				{isQueued
					? "No runner has picked this up yet — make sure a runner is connected (managed fleet, or your self-hosted runner). It verifies automatically once one claims it."
					: verifyingText}
				{escalation && (
					<span className="mt-1 block text-muted-foreground/80">{escalation}</span>
				)}
			</StatusCallout>
			<div className="flex justify-end">
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 border-border/50 text-xs"
					onClick={onCancel}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}

/**
 * The muted "how your credentials are handled" footnote shown at the bottom of a
 * connect flow. Shared so the security reassurance reads consistently.
 */
export function InfoNote({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-muted/20 p-3 text-[11px] text-muted-foreground">
			<AlertCircle className="mt-0.5 size-3.5 shrink-0" />
			<p className="leading-relaxed">{children}</p>
		</div>
	);
}
