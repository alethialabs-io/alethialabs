"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The standalone AI plan/usage surface. Shows the org's current AI plan and its usage as
// PERCENTAGES (the rolling 5-hour session + the fixed weekly limit, on the same windows the guard
// enforces) with reset times and a hard-limit indicator — never raw credit counts. CTAs: Upgrade AI
// plan (raise the limits) always; Buy credits (top-up packs) only on a PAID tier at/near a limit —
// free orgs can't top up, they upgrade. AI is metered independently of the org plan
// (lib/billing/ai-plan.ts).
//
// Rendered on the Usage page only (#6133, design decision A: Usage owns all of AI). The Billing page
// shows the tier as one row on its plan card, from the same cache entry (`usage.ai`), so the two
// can never disagree, and links here.
//
// The read is `usage.ai` over GET, prefetched by the Usage route (#6127), so the first paint carries
// the plan and the meters. No poll: AI spend moves through the `usage` topic of the change stream.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Zap } from "lucide-react";
import { type ReactNode, useState } from "react";
import { CreditPackDialog } from "@/components/billing/credit-pack-dialog";
import { UpgradeAiSheet } from "@/components/billing/upgrade-ai-sheet";
import { RegionError } from "@/components/errors/region-error";
import {
	RegionRefusal,
	refusalOf,
	retryUnlessRefused,
} from "@/components/settings/billing/read-state";
import { AiSpendLimits } from "@/components/settings/usage/ai-spend-limits";
import { ClockText } from "@/components/settings/usage/clock-text";
import { count } from "@/components/settings/usage/usage-primitives";
import { SettingsSection } from "@/components/settings/settings-ui";
import {
	isNearAiLimit,
	pctOf,
	sessionResetLabel,
	weeklyResetLabel,
} from "@/lib/billing/ai-usage-format";
import { aiPriceView } from "@/lib/billing/use-live-plan-price";
import { orpc } from "@/lib/rpc/client";
import type { AiUsageSummary } from "@/lib/rpc/procedures/usage";
import { aiPlanMeta } from "@repo/plan-catalog";
import { Skeleton } from "@repo/ui/skeleton";

/** A percent meter (bar + % value + reset sub). Shows proportions only, never raw counts. */
function PctMeter({
	label,
	pct,
	sub,
}: {
	label: string;
	pct: number;
	sub: ReactNode;
}) {
	const atLimit = pct >= 100;
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-ui-2xs uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span
					className={`text-ui-sm ${atLimit ? "font-semibold text-text-primary" : "text-text-secondary"}`}
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
			<div className="mt-2 font-mono text-ui-2xs text-text-tertiary">
				{atLimit ? "At limit · " : ""}
				{sub}
			</div>
		</div>
	);
}

/** The widest reset labels, so their slots hold their width until the clock is read. */
const SESSION_RESET_SIZER = "Starts on first use";
const WEEKLY_RESET_SIZER = "Resets Wed 12:00 PM";

/** The AI plan & usage card: the plan, the session and weekly meters, and the admin spend limits. */
export function AiUsageSection() {
	const ai = useQuery(orpc.usage.ai.queryOptions({ retry: retryUnlessRefused }));

	if (ai.data === undefined) {
		if (ai.isError) {
			const refusal = refusalOf(ai.error);
			return (
				<SettingsSection title="AI plan & usage">
					{refusal ? (
						<RegionRefusal refusal={refusal} />
					) : (
						<RegionError
							title="Couldn't load AI usage"
							description="Something went wrong reading this organization's AI plan and usage."
							onRetry={() => void ai.refetch()}
						/>
					)}
				</SettingsSection>
			);
		}
		return <AiSectionSkeleton />;
	}
	return <AiCard ai={ai.data} />;
}

/** The section's pending render, in the card's shape. */
function AiSectionSkeleton() {
	return (
		<SettingsSection title="AI plan & usage">
			<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm" aria-busy="true">
				<div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4 last:border-b-0">
					<div className="flex flex-col gap-1.5">
						<Skeleton className="h-5 w-28" />
						<Skeleton className="h-3 w-48" />
					</div>
					<Skeleton className="h-7 w-32 rounded-md" />
				</div>
				<div className="px-6 py-4">
					<Skeleton className="h-10 w-full" />
				</div>
			</div>
		</SettingsSection>
	);
}

/** The card for a loaded AI summary. */
function AiCard({ ai }: { ai: AiUsageSummary }) {
	const queryClient = useQueryClient();
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [creditsOpen, setCreditsOpen] = useState(false);
	// The tier's live (Stripe-authoritative) price, prefetched with the page; the catalog price is
	// the fallback while it is absent (Stripe not configured, or the read failed).
	const prices = useQuery(
		orpc.billing.liveAiPrices.queryOptions({ staleTime: 5 * 60_000, retry: retryUnlessRefused }),
	);
	const aiPrice = aiPriceView(ai.tier, prices.data?.[ai.tier]);
	const meta = aiPlanMeta(ai.tier);

	/** Re-read the AI standing after an upgrade or a credit purchase. */
	const refetch = () => void queryClient.invalidateQueries({ queryKey: orpc.usage.ai.key() });

	// Free/Plus can still upgrade the AI tier; Max is the top.
	const canUpgrade = ai.tier !== "ai_max";
	const paid = ai.tier !== "ai_free";
	// Top-up packs only make sense on a paid plan, and only once a limit is actually near —
	// below that, the plan's included allowance is the whole story.
	const showBuyCredits = paid && isNearAiLimit(ai);
	// The balance strip is noise for a free org that never bought packs.
	const showBalance = paid || ai.purchasedBalance > 0;

	return (
		<SettingsSection title="AI plan & usage">
			<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
				{/* plan header */}
				<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4 last:border-b-0">
					<div className="flex flex-col gap-0.5">
						<div className="flex items-baseline gap-2">
							<span className="font-display text-ui-lg font-semibold text-text-primary">
								{meta.name}
							</span>
							<span className="font-mono text-ui-xs text-text-secondary">· {aiPrice.label}</span>
						</div>
						<span className="text-ui-xs text-text-tertiary">{meta.tagline}</span>
					</div>
					<div className="flex items-center gap-2">
						{showBuyCredits && (
							<button
								type="button"
								onClick={() => setCreditsOpen(true)}
								className="inline-flex items-center gap-1 text-ui-sm text-text-secondary transition-colors hover:text-text-primary"
							>
								Buy credits
								<ArrowUpRight size={13} />
							</button>
						)}
						{canUpgrade && (
							<button
								type="button"
								onClick={() => setUpgradeOpen(true)}
								className="inline-flex items-center gap-1 rounded-md border border-border-strong px-2.5 py-1 text-ui-sm text-text-primary transition-colors hover:bg-surface-muted"
							>
								<Zap size={12} />
								Upgrade AI plan
							</button>
						)}
					</div>
				</div>

				{/* session + weekly % meters. The reset labels read the clock (and the weekly one
				    the viewer's zone), so they render after hydration in a reserved slot. */}
				<div className="grid grid-cols-1 sm:grid-cols-2">
					<PctMeter
						label="Current session"
						pct={pctOf(ai.sessionUsed, ai.sessionBudget)}
						sub={
							<ClockText
								sizer={SESSION_RESET_SIZER}
								text={() => sessionResetLabel(ai.sessionResetAt)}
							/>
						}
					/>
					<PctMeter
						label="Weekly limit"
						pct={pctOf(ai.weeklyUsed, ai.weeklyBudget)}
						sub={
							<ClockText
								sizer={WEEKLY_RESET_SIZER}
								text={() => weeklyResetLabel(ai.weeklyResetAt)}
							/>
						}
					/>
				</div>

				{/* purchased top-up balance — paid tiers (or a leftover balance) only */}
				{showBalance && (
					<div className="flex items-center justify-between border-t border-border bg-surface-sunken px-6 py-3 text-ui-sm text-text-tertiary">
						<span>Top-up credits never expire and stack on your plan.</span>
						<span className="font-mono text-text-secondary">
							{count(ai.purchasedBalance)} credits
						</span>
					</div>
				)}

				{/* admin spend limits — org admins (manage_billing) in a real org only. Keyed on the
				    stored values so a save (or another admin's, through the change stream)
				    re-seeds the fields from what was actually stored. */}
				{ai.canManageCaps && (
					<AiSpendLimits
						key={`${ai.orgWeeklyCapCredits}-${ai.perUserWeeklyCapCredits}`}
						orgWeeklyCapCredits={ai.orgWeeklyCapCredits}
						perUserWeeklyCapCredits={ai.perUserWeeklyCapCredits}
					/>
				)}
			</div>

			<UpgradeAiSheet open={upgradeOpen} onOpenChange={setUpgradeOpen} onUpgraded={refetch} />
			<CreditPackDialog
				open={creditsOpen}
				onOpenChange={setCreditsOpen}
				onPurchased={refetch}
				onUpgradeInstead={() => setUpgradeOpen(true)}
			/>
		</SettingsSection>
	);
}
