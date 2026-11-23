// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMoney } from "@repo/format";
import {
	BG_REGISTRATION_THRESHOLD,
	EU_CROSS_BORDER_THRESHOLD,
	type ThresholdAssessment,
	type ThresholdVerdict,
	type UsStateThreshold,
	usStateThreshold,
} from "@repo/legal/thresholds";
import type { EurTotal } from "@repo/legal/turnover";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@repo/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@repo/ui/empty";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import type { ReactNode } from "react";
import type { TurnoverReport } from "@/lib/turnover";

/** The badge for a verdict: ok reads active, warn pending, stop failed. */
function VerdictBadge({ assessment }: { assessment: ThresholdAssessment }) {
	const tiers: Record<ThresholdVerdict, "active" | "pending" | "failed"> = {
		ok: "active",
		warn: "pending",
		stop: "failed",
	};
	return <StatusBadge status={assessment.verdict} tier={tiers[assessment.verdict]} />;
}

/** A usage fraction as a whole percentage; "unreadable" when the total cannot be read. */
function usagePercent(usage: number): string {
	return Number.isFinite(usage) ? `${Math.round(usage * 100)}%` : "unreadable";
}

/** A horizontal bar for how far along its threshold a total is, capped at full. */
function UsageBar({ usage }: { usage: number }) {
	const width = Number.isFinite(usage) ? Math.min(100, Math.max(0, usage * 100)) : 100;
	return (
		<div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
			<div className="h-1.5 rounded-full bg-foreground" style={{ width: `${width}%` }} />
		</div>
	);
}

/** One EUR total against its threshold, with how many invoices it sums and any unconverted. */
function EurThresholdCard({
	title,
	description,
	total,
	limitEurMinor,
	assessment,
	extra,
}: {
	title: string;
	description: string;
	total: EurTotal;
	limitEurMinor: number;
	assessment: ThresholdAssessment;
	extra?: ReactNode;
}) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<div className="flex items-center justify-between gap-2">
					<CardTitle className="text-base">{title}</CardTitle>
					<VerdictBadge assessment={assessment} />
				</div>
				<CardDescription>{description}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-2">
				<p className="tabular-nums">
					<span className="text-lg font-semibold">{formatMoney(total.eurMinor, "eur")}</span>{" "}
					<span className="text-sm text-muted-foreground">
						of {formatMoney(limitEurMinor, "eur")} · {usagePercent(assessment.usage)}
					</span>
				</p>
				<UsageBar usage={assessment.usage} />
				<p className="text-sm text-muted-foreground">
					{total.invoices} invoice{total.invoices === 1 ? "" : "s"}
					{total.unconverted > 0
						? ` · ${total.unconverted} with no EUR amount — the total is unreadable and the gate refuses until it is converted (replay the invoice's payment event)`
						: ""}
				</p>
				{extra}
			</CardContent>
		</Card>
	);
}

/** A state's threshold rule in words, e.g. "$100,000 or 200 transactions". */
function ruleText(rule: UsStateThreshold | null): string {
	if (rule === null) return "unknown state";
	switch (rule.kind) {
		case "no_sales_tax":
			return "no general sales tax";
		case "revenue":
			return formatMoney(rule.revenueUsdMinor, "usd");
		case "revenue_or_transactions":
			return `${formatMoney(rule.revenueUsdMinor, "usd")} or ${rule.transactions} transactions`;
		case "revenue_and_transactions":
			return `${formatMoney(rule.revenueUsdMinor, "usd")} and ${rule.transactions} transactions`;
	}
}

/**
 * The staff turnover dashboard: the Bulgarian EUR 51,130 total, the EU EUR 10,000 cross-border total
 * for this year and last, and every US state's revenue and transaction count, nearest threshold
 * first. Read-only and server-rendered.
 */
export function TurnoverDashboard({ report }: { report: TurnoverReport }) {
	const { totals, assessments } = report;
	return (
		<div className="space-y-6">
			<div className="grid gap-4 md:grid-cols-2">
				<EurThresholdCard
					title={`Bulgaria — ${totals.year}`}
					description="Turnover with place of supply in Bulgaria this calendar year (VAT Act Art. 96(1)): Bulgarian buyers, and EU buyers with no VAT number."
					total={totals.bg}
					limitEurMinor={BG_REGISTRATION_THRESHOLD.limit}
					assessment={assessments.bg}
				/>
				<EurThresholdCard
					title={`EU cross-border, no VAT number — ${totals.year}`}
					description="Sales to buyers in other member states that gave no VAT number, all states together (Art. 20b). The gate refuses the sale that would cross, before it is taken."
					total={totals.euCurrent}
					limitEurMinor={EU_CROSS_BORDER_THRESHOLD.limit}
					assessment={assessments.eu}
					extra={
						<p className="text-sm text-muted-foreground tabular-nums">
							{totals.year - 1}: {formatMoney(totals.euPrevious.eurMinor, "eur")} ·{" "}
							{totals.euPrevious.invoices} invoice{totals.euPrevious.invoices === 1 ? "" : "s"}
							{totals.euPrevious.unconverted > 0
								? ` · ${totals.euPrevious.unconverted} with no EUR amount`
								: ""}
							{" "}— a crossing last year stops every sale this year.
						</p>
					}
				/>
			</div>

			<Card>
				<CardHeader className="pb-2">
					<CardTitle className="text-base">United States, per state</CardTitle>
					<CardDescription>
						Revenue and transaction count per state, each the largest over the previous calendar year,
						the trailing twelve months and the last four quarters. Nearest threshold first.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{assessments.usStates.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>No US sales</EmptyTitle>
								<EmptyDescription>No paid invoice to a US buyer in the measuring periods.</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>State</TableHead>
									<TableHead className="text-right">Revenue</TableHead>
									<TableHead className="text-right">Transactions</TableHead>
									<TableHead>Threshold</TableHead>
									<TableHead className="text-right">Usage</TableHead>
									<TableHead>Verdict</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{assessments.usStates.map((s) => (
									<TableRow key={s.state}>
										<TableCell className="font-mono">{s.state}</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatMoney(s.revenueUsdMinor, "usd")}
											{s.unconverted > 0 ? ` (+${s.unconverted} not in USD)` : ""}
										</TableCell>
										<TableCell className="text-right tabular-nums">{s.transactions}</TableCell>
										<TableCell className="text-muted-foreground">{ruleText(usStateThreshold(s.state))}</TableCell>
										<TableCell className="text-right tabular-nums">{usagePercent(s.assessment.usage)}</TableCell>
										<TableCell>
											<VerdictBadge assessment={s.assessment} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			{totals.usNoState.invoices > 0 || totals.unattributed.invoices > 0 ? (
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-base">Not attributed</CardTitle>
						<CardDescription>Paid invoices no threshold above can count. Each needs a person.</CardDescription>
					</CardHeader>
					<CardContent className="space-y-1 text-sm">
						{totals.usNoState.invoices > 0 ? (
							<p>
								{totals.usNoState.invoices} US invoice{totals.usNoState.invoices === 1 ? "" : "s"} with no
								usable state ({formatMoney(totals.usNoState.revenueUsdMinor, "usd")}) — counted toward no state.
							</p>
						) : null}
						{totals.unattributed.invoices > 0 ? (
							<p>
								{totals.unattributed.invoices} non-EUR invoice{totals.unattributed.invoices === 1 ? "" : "s"} with
								no recorded buyer facts — replay the payment event to record them.
							</p>
						) : null}
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}
