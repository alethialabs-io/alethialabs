// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@repo/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { CircleDollarSign } from "lucide-react";
import type { AiSpendRollup } from "@/lib/queries";

/** Formats a USD number as `$1,234.56` (4 dp under a cent so tiny spend is visible). */
function fmtUsd(n: number): string {
	if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
	return n.toLocaleString("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

/** A labelled headline metric tile. */
function Stat({ label, value }: { label: string; value: string }) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<CardDescription>{label}</CardDescription>
				<CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
			</CardHeader>
		</Card>
	);
}

/**
 * A minimal CSS bar-chart daily trend (no chart lib) — one bar per active day, height
 * proportional to that day's USD, with the peak day labelled. Purely presentational.
 */
function DailyTrend({ daily }: { daily: AiSpendRollup["daily"] }) {
	const peak = Math.max(1e-9, ...daily.map((d) => d.usd));
	return (
		<Card>
			<CardHeader className="pb-2">
				<CardTitle className="text-base">Daily spend</CardTitle>
				<CardDescription>USD cost-of-serve per day in the window.</CardDescription>
			</CardHeader>
			<CardContent>
				{daily.length === 0 ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						No AI usage in this window.
					</p>
				) : (
					<div className="flex h-40 items-end gap-1">
						{daily.map((d) => (
							<div
								key={d.day}
								className="group flex flex-1 flex-col items-center justify-end gap-1"
								title={`${d.day}: ${fmtUsd(d.usd)}`}
							>
								<div
									className="w-full rounded-t bg-foreground/70 transition-colors group-hover:bg-foreground"
									style={{
										height: `${Math.max(2, (d.usd / peak) * 100)}%`,
									}}
								/>
								<span className="text-[10px] text-muted-foreground">
									{d.day.slice(5)}
								</span>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

/**
 * The read-only staff AI-spend dashboard: headline totals, a daily-spend trend, and
 * per-model / per-org / per-user cost tables — all in USD from the ledger's snapshotted
 * `cost_micros`. Data comes from `aiSpendRollup`; this component is presentational only.
 */
export function AiSpendDashboard({
	rollup,
	windowLabel,
}: {
	rollup: AiSpendRollup;
	windowLabel: string;
}) {
	const hasData = rollup.perModel.length > 0;

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<Stat label={`Total (${windowLabel})`} value={fmtUsd(rollup.totalUsd)} />
				<Stat label="Orgs with spend" value={String(rollup.perOrg.length)} />
				<Stat label="Users with spend" value={String(rollup.perUser.length)} />
				<Stat label="Models used" value={String(rollup.perModel.length)} />
			</div>

			{!hasData ? (
				<Empty className="rounded-md border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<CircleDollarSign />
						</EmptyMedia>
						<EmptyTitle>No AI spend yet</EmptyTitle>
						<EmptyDescription>
							No metered AI usage was recorded in {windowLabel}.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<DailyTrend daily={rollup.daily} />

					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Per model</CardTitle>
							<CardDescription>Cost split by model.</CardDescription>
						</CardHeader>
						<CardContent className="px-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Model</TableHead>
										<TableHead className="text-right">Actions</TableHead>
										<TableHead className="text-right">Spend</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rollup.perModel.map((r) => (
										<TableRow key={r.model ?? "unknown"}>
											<TableCell className="font-mono text-xs">
												{r.model ?? "(unattributed)"}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{r.actions.toLocaleString("en-US")}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{fmtUsd(r.usd)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Per org</CardTitle>
							<CardDescription>Top organizations by AI spend.</CardDescription>
						</CardHeader>
						<CardContent className="px-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Organization</TableHead>
										<TableHead className="text-right">Actions</TableHead>
										<TableHead className="text-right">Spend</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rollup.perOrg.map((r) => (
										<TableRow key={r.org_id ?? "none"}>
											<TableCell>
												<span className="font-medium">
													{r.org_name ?? "(no org)"}
												</span>
												{r.org_slug && (
													<span className="ml-2 font-mono text-xs text-muted-foreground">
														/{r.org_slug}
													</span>
												)}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{r.actions.toLocaleString("en-US")}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{fmtUsd(r.usd)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>

					<Card>
						<CardHeader className="pb-2">
							<CardTitle className="text-base">Per user</CardTitle>
							<CardDescription>Top seats by AI spend.</CardDescription>
						</CardHeader>
						<CardContent className="px-0">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>User</TableHead>
										<TableHead>Org</TableHead>
										<TableHead className="text-right">Actions</TableHead>
										<TableHead className="text-right">Spend</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rollup.perUser.map((r) => (
										<TableRow key={`${r.user_id}:${r.org_id ?? "none"}`}>
											<TableCell>
												<span className="font-medium">
													{r.user_name ?? r.user_email ?? "(unknown)"}
												</span>
												{r.user_email && r.user_name && (
													<span className="ml-2 text-xs text-muted-foreground">
														{r.user_email}
													</span>
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{r.org_name ?? "—"}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{r.actions.toLocaleString("en-US")}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{fmtUsd(r.usd)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				</>
			)}
		</div>
	);
}
