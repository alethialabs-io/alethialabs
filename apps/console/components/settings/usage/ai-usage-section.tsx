"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The standalone AI plan/usage surface — shared by the Usage page and the Billing page's
// AI section. Shows the org's current AI tier and its usage as PERCENTAGES (daily +
// weekly, on the same fixed buckets the guard enforces) with reset times and a hard-limit
// indicator — never raw credit counts. CTAs: Buy credits (top-up packs) + Upgrade AI plan
// (raise the caps). AI is metered independently of the org plan (lib/billing/ai-plan.ts).

import { ArrowUpRight, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	type AiUsageSummary,
	getAiUsageSummary,
} from "@/app/server/actions/billing";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { UpgradeAiSheet } from "@/components/billing/upgrade-ai-sheet";
import { SettingsSection } from "@/components/settings/settings-ui";
import { useLiveAiPrice } from "@/lib/billing/use-live-plan-price";
import { aiPlanMeta } from "@repo/plan-catalog";
import { Skeleton } from "@repo/ui/skeleton";

/** Humanize the time until an ISO reset ("2h", "1d", "5m", or "soon"). */
function resetsIn(iso: string): string {
	const ms = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(ms) || ms <= 0) return "soon";
	const h = Math.floor(ms / 3_600_000);
	if (h >= 24) return `${Math.floor(h / 24)}d`;
	if (h >= 1) return `${h}h`;
	return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/** A percent meter (bar + % value + reset sub). Shows proportions only, never raw counts. */
function PctMeter({
	label,
	pct,
	resetAt,
}: {
	label: string;
	pct: number;
	resetAt: string;
}) {
	const atLimit = pct >= 100;
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span
					className={`text-[12.5px] ${atLimit ? "font-semibold text-text-primary" : "text-text-secondary"}`}
				>
					{pct}%
				</span>
			</div>
			<div className="h-[5px] overflow-hidden rounded-full border border-border bg-surface-sunken">
				<div
					className="h-full rounded-full bg-text-primary"
					style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-[10px] text-text-tertiary">
				{atLimit ? "at limit · " : ""}resets in {resetsIn(resetAt)}
			</div>
		</div>
	);
}

const pctOf = (used: number, budget: number) =>
	budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;

/**
 * The AI plan & usage card. Self-fetches the canonical AI summary and renders the tier +
 * daily/weekly % + purchased balance + Buy-credits / Upgrade-AI-plan CTAs. Rendered on both
 * the Usage and Billing settings pages (one source of truth — no twin panel).
 */
export function AiUsageSection() {
	const [ai, setAi] = useState<AiUsageSummary | null>(null);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [creditsOpen, setCreditsOpen] = useState(false);

	/** (Re)load the canonical AI summary — also called after an upgrade / credit purchase. */
	const refetch = useCallback(() => {
		let alive = true;
		getAiUsageSummary()
			.then((s) => alive && setAi(s))
			.catch(() => {
				/* best-effort — the section just shows a skeleton */
			});
		return () => {
			alive = false;
		};
	}, []);

	useEffect(() => refetch(), [refetch]);

	const meta = ai ? aiPlanMeta(ai.tier) : null;
	// The tier's live (Stripe-authoritative) price in USD — placeholder catalog price until
	// the AI Stripe prices are cut over; the upgrade sheet owns the currency choice. Hooks
	// must run unconditionally, so resolve against the free tier until the summary loads.
	const aiPrice = useLiveAiPrice(ai?.tier ?? "ai_free");
	// Free/Plus can still upgrade the AI tier; Max is the top.
	const canUpgrade = ai ? ai.tier !== "ai_max" : false;

	return (
		<SettingsSection title="AI plan & usage">
			<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
				{/* tier header */}
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
					<div className="flex flex-col gap-0.5">
						<div className="flex items-baseline gap-2">
							<span className="font-display text-[15px] font-semibold text-text-primary">
								{meta ? meta.name : <Skeleton className="h-4 w-20" />}
							</span>
							{meta && (
								<span className="font-mono text-[11px] text-text-secondary">
									· {aiPrice.label}
								</span>
							)}
						</div>
						{meta && (
							<span className="font-mono text-[10.5px] text-text-tertiary">
								{meta.advisor}
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setCreditsOpen(true)}
							className="inline-flex items-center gap-1 text-[12.5px] text-text-secondary transition-colors hover:text-text-primary"
						>
							Buy credits
							<ArrowUpRight size={13} />
						</button>
						{canUpgrade && (
							<button
								type="button"
								onClick={() => setUpgradeOpen(true)}
								className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-[12px] text-text-primary transition-colors hover:bg-surface-muted"
							>
								<Zap size={12} />
								Upgrade AI plan
							</button>
						)}
					</div>
				</div>

				{/* daily + weekly % meters */}
				<div className="grid grid-cols-1 sm:grid-cols-2">
					{ai ? (
						<>
							<PctMeter
								label="Today"
								pct={pctOf(ai.dailyUsed, ai.dailyBudget)}
								resetAt={ai.dailyResetAt}
							/>
							<PctMeter
								label="This week"
								pct={pctOf(ai.weeklyUsed, ai.weeklyBudget)}
								resetAt={ai.weeklyResetAt}
							/>
						</>
					) : (
						<div className="px-6 py-4">
							<Skeleton className="h-10 w-full" />
						</div>
					)}
				</div>

				{/* purchased top-up balance */}
				<div className="flex items-center justify-between border-t border-border bg-surface-sunken px-6 py-3 text-[12px] text-text-tertiary">
					<span>Top-up credits stack on any tier and never expire.</span>
					<span className="font-mono text-text-secondary">
						{ai ? `${ai.purchasedBalance.toLocaleString()} credits` : "—"}
					</span>
				</div>
			</div>

			<UpgradeAiSheet
				open={upgradeOpen}
				onOpenChange={setUpgradeOpen}
				onUpgraded={refetch}
			/>
			<CreditPackDialog
				open={creditsOpen}
				onOpenChange={setCreditsOpen}
				onPurchased={refetch}
			/>
		</SettingsSection>
	);
}
