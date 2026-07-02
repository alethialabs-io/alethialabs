"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { ConnTestPhase, VerifyStatus } from "./use-connection-test";

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
 * Renders the in-progress / done states of an instant server-side connection verify (driven by
 * `useConnectionTest`): `saving` (the single save+verify round trip, with a Cancel so the flow can
 * never get stuck) and `success` — which distinguishes a fully CONNECTED account from a DEGRADED one
 * (authenticated, but missing some provisioning permissions). The caller handles `idle`/`failed` by
 * showing its credential form.
 */
export function ConnectionTestStatus({
	phase,
	successText,
	verifyingText,
	onCancel,
	status,
	missingPermissions,
}: {
	phase: ConnTestPhase;
	successText: string;
	verifyingText: string;
	onCancel: () => void;
	status?: VerifyStatus;
	missingPermissions?: string[];
}) {
	if (phase === "success") {
		if (status === "degraded") {
			const missing = missingPermissions?.length
				? ` (${missingPermissions.join(", ")})`
				: "";
			return (
				<StatusCallout variant="pending" title="Connected — limited permissions">
					{successText} Some provisioning permissions look missing{missing} — provisioning may
					fail until the role is widened.
				</StatusCallout>
			);
		}
		return (
			<StatusCallout variant="success" title="Connection verified">
				{successText}
			</StatusCallout>
		);
	}

	// `saving` — the save + server-side verify happen in one round trip; it resolves near-instantly.
	return (
		<div className="space-y-3">
			<StatusCallout variant="pending" title="Verifying connection…">
				{verifyingText}
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
