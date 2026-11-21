// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Filter } from "lucide-react";
import { EmptyState } from "@repo/ui/empty";
import { SectionHeading } from "@repo/ui/section-heading";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { cn } from "@repo/ui/utils";
import {
	type FunnelReport,
	STAGES,
	WINDOW_CHOICES,
	cloudLabel,
	dailyRows,
	totalsMatrix,
} from "./report";

/** Formats a count with thousands separators. */
function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/** The 7 / 30 / 90-day window switch — plain links, so the page stays a server render. */
export function WindowSwitch({ days }: { days: number }) {
	return (
		<nav aria-label="Window" className="flex items-center gap-1 rounded-md border p-0.5">
			{WINDOW_CHOICES.map((choice) => (
				<Link
					key={choice}
					href={`/funnel?days=${choice}`}
					aria-current={choice === days ? "page" : undefined}
					className={cn(
						"rounded px-2 py-1 text-xs transition-colors",
						choice === days
							? "bg-muted font-medium text-foreground"
							: "text-muted-foreground hover:text-foreground",
					)}
				>
					{choice} days
				</Link>
			))}
		</nav>
	);
}

/**
 * The funnel, read-only: window totals per stage and per cloud, then the per-day counts. Every
 * number on it is an aggregate; the report it renders can carry nothing else (./report.ts).
 */
export function FunnelView({ report }: { report: FunnelReport }) {
	if (report.totals.length === 0) {
		return (
			<EmptyState
				className="rounded-md border"
				icon={<Filter />}
				title="No funnel activity"
				description={`Nothing reached any stage between ${report.from} and ${report.to} (UTC).`}
			/>
		);
	}

	const matrix = totalsMatrix(report);
	const daily = dailyRows(report);

	return (
		<div className="space-y-8">
			<section className="space-y-3">
				<SectionHeading
					title="By stage and cloud"
					description={`First time each organization reached a stage, ${report.from} to ${report.to} (UTC). Sign-up, organization and payment have no cloud.`}
				/>
				<div className="overflow-x-auto rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Stage</TableHead>
								<TableHead className="text-right">Total</TableHead>
								{matrix.clouds.map((c) => (
									<TableHead key={c ?? "none"} className="text-right">
										{cloudLabel(c)}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{STAGES.map((s) => (
								<TableRow key={s.key}>
									<TableCell className="font-medium">{s.label}</TableCell>
									<TableCell className="text-right tabular-nums">
										{fmt(matrix.stageTotal(s.key))}
									</TableCell>
									{matrix.clouds.map((c) => (
										<TableCell
											key={c ?? "none"}
											className="text-right tabular-nums text-muted-foreground"
										>
											{fmt(matrix.get(s.key, c))}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</section>

			<section className="space-y-3">
				<SectionHeading
					title="By day"
					description="Each stage summed across clouds, newest day first."
				/>
				<div className="overflow-x-auto rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Day (UTC)</TableHead>
								{STAGES.map((s) => (
									<TableHead key={s.key} className="text-right">
										{s.label}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{daily.map((row) => (
								<TableRow key={row.day}>
									<TableCell className="font-mono text-xs">{row.day}</TableCell>
									{STAGES.map((s) => (
										<TableCell key={s.key} className="text-right tabular-nums">
											{fmt(row.counts[s.key])}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</section>
		</div>
	);
}
