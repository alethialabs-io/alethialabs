"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PLACEHOLDER — a functional AI-usage surface (tier + window/weekly bars + buy
// credits) built from existing primitives. To be replaced by the claude.ai
// `console/usage.html` design (rebuilt via DesignSync). Shows proportions only — no
// raw included-credit numbers (the multiplier tier is the only "amount").

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AiUsageSummary } from "@/app/server/actions/ai-billing";
import { createCreditPackIntent } from "@/app/server/actions/billing";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import type { CreditPack } from "@/lib/billing/ai-credits";

const TIER_LABEL: Record<AiUsageSummary["tier"], string> = {
	trial: "Trial",
	standard: "Standard",
	plus: "5×",
	max: "20×",
};

function resetsIn(iso: string): string {
	const ms = new Date(iso).getTime() - Date.now();
	if (ms <= 0) return "now";
	const h = Math.floor(ms / 3_600_000);
	if (h >= 24) return `${Math.floor(h / 24)}d`;
	if (h >= 1) return `${h}h`;
	return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

function Bar({ label, pct, reset }: { label: string; pct: number; reset: string }) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between">
				<span className="vx-eyebrow text-[10px]">{label}</span>
				<span className="font-mono text-[10px] text-muted-foreground">
					resets in {reset}
				</span>
			</div>
			<div className="h-[6px] overflow-hidden border border-border bg-muted">
				<div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}

export function UsagePanel({
	usage,
	packs,
}: {
	usage: AiUsageSummary;
	packs: CreditPack[];
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	const buy = async (packId: string) => {
		setBusy(packId);
		try {
			const intent = await createCreditPackIntent(packId);
			setClientSecret(intent.clientSecret);
		} finally {
			setBusy(null);
		}
	};
	const close = () => {
		setOpen(false);
		setClientSecret(null);
		router.refresh();
	};

	if (!usage.hosted) {
		return (
			<div className="border border-border p-6 text-sm text-muted-foreground">
				AI usage is unlimited on self-managed deployments — you provide your own
				gateway key and pay your own model costs.
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="border border-border">
				<div className="flex items-center justify-between border-b border-border px-5 py-4">
					<div>
						<div className="vx-eyebrow text-[10px]">AI plan</div>
						<div className="text-sm font-medium">
							{TIER_LABEL[usage.tier]} usage
						</div>
					</div>
					<Button
						variant="outline"
						className="rounded-none"
						onClick={() => setOpen(true)}
					>
						Buy credits
					</Button>
				</div>
				<div className="space-y-4 px-5 py-4">
					<Bar
						label="Current window"
						pct={usage.windowPctUsed}
						reset={resetsIn(usage.windowResetAt)}
					/>
					<Bar
						label="This week"
						pct={usage.weekPctUsed}
						reset={resetsIn(usage.weekResetAt)}
					/>
					{usage.purchasedBalance > 0 && (
						<div className="flex items-center justify-between border-t border-border pt-3 text-xs">
							<span className="text-muted-foreground">Extra credits</span>
							<span className="font-mono text-foreground">
								{usage.purchasedBalance.toLocaleString()}
							</span>
						</div>
					)}
				</div>
			</div>

			<Dialog
				open={open}
				onOpenChange={(o) => (o ? setOpen(true) : close())}
			>
				<DialogContent className="rounded-none">
					<DialogHeader>
						<DialogTitle>Add AI credits</DialogTitle>
					</DialogHeader>
					{clientSecret ? (
						<StripeElementsProvider clientSecret={clientSecret}>
							<PaymentForm mode="payment" submitLabel="Pay" onSuccess={close} />
						</StripeElementsProvider>
					) : (
						<div className="space-y-2">
							{packs.map((p) => (
								<button
									key={p.id}
									type="button"
									disabled={busy !== null}
									onClick={() => buy(p.id)}
									className="flex w-full items-center justify-between border border-border px-4 py-3 text-left transition-colors hover:bg-muted disabled:opacity-50"
								>
									<span className="text-sm font-medium">
										{p.credits.toLocaleString()} credits
									</span>
									<span className="font-mono text-sm">
										${(p.amountCents / 100).toFixed(0)}
									</span>
								</button>
							))}
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
