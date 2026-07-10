"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { Card, CardContent } from "@repo/ui/card";
import { FieldHelp } from "@repo/ui/field-help";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";
import {
	AlertCircle,
	CheckCircle2,
	HelpCircle,
	KeyRound,
	Loader2,
	Lock,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
	ConnTestPhase,
	ConnTestState,
	VerifyStatus,
} from "./use-connection-test";

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

/**
 * The "How this works" popover shown in a connect sheet's header — a labelled trigger (vs the icon-only
 * FieldHelp) that opens a plain-language explanation of the keyless trust model. Reassures a non-expert
 * user before they touch their cloud console.
 */
function HowItWorks({ children }: { children: ReactNode }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
				>
					<HelpCircle className="size-3.5" />
					How this works
				</button>
			</PopoverTrigger>
			<PopoverContent side="bottom" align="end" className="w-80 p-3.5">
				<p className="mb-1.5 font-medium text-foreground text-xs">How this works</p>
				<div className="space-y-1.5 text-muted-foreground text-xs leading-relaxed">
					{children}
				</div>
			</PopoverContent>
		</Popover>
	);
}

/**
 * The shared connect-sheet frame: a reassuring header (title + "Keyless" badge + a "How this works"
 * popover + a one-line intro) above a card that holds the provider-specific body. Used by every cloud
 * connect sheet so they read consistently and non-threateningly. Self-contained — no dependency on the
 * Sheet wrapper, so it works inside the create-project flow too.
 */
export function ConnectSheetShell({
	title,
	intro,
	howItWorks,
	badgeLabel = "Keyless",
	children,
}: {
	title: string;
	intro: ReactNode;
	howItWorks: ReactNode;
	/** The reassurance pill — "Keyless" for the federated clouds, e.g. "Encrypted" for token clouds. */
	badgeLabel?: string;
	children: ReactNode;
}) {
	return (
		<div className="mx-auto w-full max-w-200 space-y-4">
			<div className="rounded-lg border border-border/40 bg-muted/20 px-4 py-3.5">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
							<span className="font-medium text-foreground text-sm">{title}</span>
							<Badge
								variant="secondary"
								className="h-5 gap-1 px-1.5 font-medium text-[10px]"
							>
								<CheckCircle2 className="size-3" />
								{badgeLabel}
							</Badge>
						</div>
						<p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
							{intro}
						</p>
					</div>
					<div className="shrink-0">
						<HowItWorks>{howItWorks}</HowItWorks>
					</div>
				</div>
			</div>
			<Card className="border-border/40 bg-background shadow-sm">
				<CardContent className="space-y-6 pt-6">{children}</CardContent>
			</Card>
		</div>
	);
}

/** One method choice in {@link MethodTabs}. */
export interface MethodTab {
	id: string;
	label: string;
	sub: string;
	icon: ReactNode;
}

/**
 * The setup-method selector (e.g. CloudFormation vs Terraform), with a "?" popover next to the row that
 * explains how to choose. Kept above the tabs (not inside each button) so there's no nested-interactive
 * markup. Replaces the copy that was hand-rolled in every cloud sheet.
 */
export function MethodTabs({
	tabs,
	value,
	onChange,
	help,
	label = "Choose a setup method",
}: {
	tabs: MethodTab[];
	value: string;
	onChange: (id: string) => void;
	help?: ReactNode;
	label?: string;
}) {
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-1.5">
				<span className="font-medium text-muted-foreground text-xs">{label}</span>
				{help && <FieldHelp title={label}>{help}</FieldHelp>}
			</div>
			<div className="flex gap-3">
				{tabs.map((t) => {
					const active = value === t.id;
					return (
						<button
							key={t.id}
							type="button"
							onClick={() => onChange(t.id)}
							className={cn(
								"flex-1 rounded-lg border p-3 text-left transition-all duration-200",
								active
									? "border-foreground bg-muted/20"
									: "border-border/50 bg-background hover:border-border/80 hover:bg-muted/10",
							)}
						>
							<div className="flex items-center gap-2.5">
								<div
									className={cn(
										"rounded-md border p-1.5",
										active
											? "border-foreground bg-foreground text-background"
											: "border-border/50 bg-background text-muted-foreground",
									)}
								>
									{t.icon}
								</div>
								<div>
									<div className="font-medium text-foreground text-sm">
										{t.label}
									</div>
									<div className="text-[11px] text-muted-foreground">{t.sub}</div>
								</div>
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** A numbered setup step. Shared across every connect sheet. */
export function Step({
	n,
	title,
	children,
}: {
	n: number;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex gap-4">
			<div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted font-medium text-foreground text-xs">
				{n}
			</div>
			<div className="min-w-0 flex-1 space-y-3">
				<div className="font-medium text-foreground text-sm">{title}</div>
				{children}
			</div>
		</div>
	);
}

/**
 * The verify section + form. While the instant server-side verify is in flight it shows the shared
 * verifying/success status (with Cancel); on idle/failure it shows the provider-specific form
 * (`children`). Shared across every connect sheet.
 */
export function VerifySection({
	state,
	successText,
	verifyingText,
	onCancel,
	children,
}: {
	state: ConnTestState;
	successText: string;
	verifyingText: string;
	onCancel: () => void;
	children: ReactNode;
}) {
	const inFlight = state.phase === "success" || state.phase === "saving";
	return (
		<div className="border-border/40 border-t pt-6">
			{inFlight ? (
				<ConnectionTestStatus
					phase={state.phase}
					status={state.status}
					missingPermissions={state.missingPermissions}
					successText={successText}
					verifyingText={verifyingText}
					onCancel={onCancel}
				/>
			) : (
				<>
					{state.phase === "failed" && (
						<div className="mb-4">
							<StatusCallout variant="error" title="Verification failed">
								{state.error}
							</StatusCallout>
						</div>
					)}
					{children}
				</>
			)}
		</div>
	);
}

/**
 * The reassurance footer shown at the bottom of a connect flow: exactly what Alethia keeps, and how to cut
 * access. Replaces the ad-hoc InfoNote text so the "we store almost nothing" promise reads consistently.
 */
export function StoredNote({
	stored,
	revoke,
}: {
	stored: ReactNode;
	revoke: ReactNode;
}) {
	return (
		<div className="mt-5 grid gap-2 rounded-md border border-border/40 bg-muted/20 p-3 text-[11px] text-muted-foreground">
			<div className="flex items-start gap-2">
				<Lock className="mt-0.5 size-3.5 shrink-0" />
				<p className="leading-relaxed">
					<span className="font-medium text-foreground">What&apos;s stored: </span>
					{stored}
				</p>
			</div>
			<div className="flex items-start gap-2">
				<KeyRound className="mt-0.5 size-3.5 shrink-0" />
				<p className="leading-relaxed">
					<span className="font-medium text-foreground">Revoke anytime: </span>
					{revoke}
				</p>
			</div>
		</div>
	);
}
