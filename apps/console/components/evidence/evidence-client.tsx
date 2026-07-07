"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Evidence surface — the org-wide "keep proving it" roll-up. Three tabs over one
// fetched roll-up: Verify (latest elench verdict per environment, linking to the job's
// Plan tab for the full report + downloadable signed receipt), Drift (current posture per
// environment), and Waivers (recorded, time-boxed control overrides). Read-only; the data
// is produced by the PLAN/DEPLOY + DETECT_DRIFT jobs — this page never mutates anything.

import { formatDistanceToNow } from "date-fns";
import { FileCheck2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Badge } from "@repo/ui/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@repo/ui/empty";
import { Skeleton } from "@repo/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@repo/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import type {
	EvidenceEnvRow,
	EvidenceWaiver,
} from "@/lib/queries/evidence";
import { useEvidenceQuery } from "@/lib/query/use-evidence-query";
import { EvidenceSummaryStrip } from "./evidence-summary";
import {
	DriftBadge,
	DriftUnknownBadge,
	UnverifiedBadge,
	VerdictBadge,
} from "./verdict-badge";

/** Relative-time label from an ISO timestamp (e.g. "3 hours ago"). */
function ago(iso: string): string {
	return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

/** The environment's project + name, stacked, for the leftmost table cell. */
function EnvCell({ row }: { row: EvidenceEnvRow }) {
	return (
		<div className="flex flex-col">
			<span className="font-medium">{row.environmentName}</span>
			<span className="text-xs text-muted-foreground">
				{row.projectName} · {row.stage}
			</span>
		</div>
	);
}

/** Verify tab — latest verdict per environment, each linking to the job's Plan tab. */
function VerifyTable({ rows, org }: { rows: EvidenceEnvRow[]; org: string }) {
	if (rows.length === 0) {
		return (
			<EvidenceEmpty
				title="Nothing to verify yet"
				description="Once you plan or deploy an environment, its verification verdict and signed receipt appear here."
			/>
		);
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Environment</TableHead>
					<TableHead>Verdict</TableHead>
					<TableHead>Receipt</TableHead>
					<TableHead>Evaluated</TableHead>
					<TableHead className="text-right">Report</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => (
					<TableRow key={row.environmentId}>
						<TableCell>
							<EnvCell row={row} />
						</TableCell>
						<TableCell>
							{row.verify ? (
								<VerdictBadge verdict={row.verify.verdict} />
							) : (
								<UnverifiedBadge />
							)}
						</TableCell>
						<TableCell>
							{row.verify?.hasReceipt ? (
								<Badge variant="outline" className="gap-1.5">
									<FileCheck2 className="h-3.5 w-3.5" />
									Signed
								</Badge>
							) : (
								<span className="text-xs text-muted-foreground">—</span>
							)}
						</TableCell>
						<TableCell className="text-sm text-muted-foreground">
							{row.verify ? ago(row.verify.evaluatedAt) : "—"}
						</TableCell>
						<TableCell className="text-right">
							{row.verify ? (
								<Link
									href={`/${org}/~/jobs/${row.verify.jobId}`}
									className="text-sm underline-offset-4 hover:underline"
								>
									View
								</Link>
							) : (
								<span className="text-xs text-muted-foreground">—</span>
							)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** Drift tab — current posture per environment from the latest refresh-only scan. */
function DriftTable({ rows }: { rows: EvidenceEnvRow[] }) {
	if (rows.length === 0) {
		return (
			<EvidenceEmpty
				title="No environments yet"
				description="Provisioned environments are drift-scanned on a day-2 cadence; their posture shows here."
			/>
		);
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Environment</TableHead>
					<TableHead>Posture</TableHead>
					<TableHead>Last scanned</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row) => (
					<TableRow key={row.environmentId}>
						<TableCell>
							<EnvCell row={row} />
						</TableCell>
						<TableCell>
							{row.drift ? (
								<DriftBadge inSync={row.drift.inSync} drifted={row.drift.drifted} />
							) : (
								<DriftUnknownBadge />
							)}
						</TableCell>
						<TableCell className="text-sm text-muted-foreground">
							{row.drift ? ago(row.drift.scannedAt) : "—"}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** Waivers tab — recorded, time-boxed verification control overrides. */
function WaiversTable({ waivers }: { waivers: EvidenceWaiver[] }) {
	if (waivers.length === 0) {
		return (
			<EvidenceEmpty
				title="No waivers"
				description="When an apply proceeds despite a failing control, the authorized, time-boxed waiver is recorded here."
			/>
		);
	}
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Environment</TableHead>
					<TableHead>Controls</TableHead>
					<TableHead>Reason</TableHead>
					<TableHead>By</TableHead>
					<TableHead>Status</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{waivers.map((w) => (
					<TableRow key={w.jobId}>
						<TableCell>
							<div className="flex flex-col">
								<span className="font-medium">
									{w.environmentName ?? "—"}
								</span>
								<span className="text-xs text-muted-foreground">
									{w.projectName ?? "—"}
								</span>
							</div>
						</TableCell>
						<TableCell>
							<div className="flex flex-wrap gap-1">
								{w.controls.map((c) => (
									<Badge key={c} variant="outline" className="font-mono text-[11px]">
										{c}
									</Badge>
								))}
							</div>
						</TableCell>
						<TableCell className="max-w-[280px] text-sm text-muted-foreground">
							{w.reason}
						</TableCell>
						<TableCell className="text-sm text-muted-foreground">{w.by}</TableCell>
						<TableCell>
							{w.active ? (
								<Badge variant="secondary">Active</Badge>
							) : (
								<Badge variant="outline" className="text-muted-foreground">
									Expired
								</Badge>
							)}
						</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

/** Shared empty state for the three tabs. */
function EvidenceEmpty({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Empty className="rounded-md border">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<ShieldCheck />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/** The Evidence page body: summary strip + Verify / Drift / Waivers tabs. */
export function EvidenceClient() {
	const { org } = useParams<{ org: string }>();
	const { data, isPending } = useEvidenceQuery();

	if (isPending || !data) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-24 w-full rounded-lg" />
				<Skeleton className="h-9 w-64 rounded-md" />
				<Skeleton className="h-64 w-full rounded-lg" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<EvidenceSummaryStrip summary={data.summary} />
			<Tabs defaultValue="verify">
				<TabsList>
					<TabsTrigger value="verify">Verify</TabsTrigger>
					<TabsTrigger value="drift">Drift</TabsTrigger>
					<TabsTrigger value="waivers">
						Waivers
						{data.summary.activeWaivers > 0 && (
							<Badge variant="secondary" className="ml-2">
								{data.summary.activeWaivers}
							</Badge>
						)}
					</TabsTrigger>
				</TabsList>
				<TabsContent value="verify" className="mt-4">
					<VerifyTable rows={data.rows} org={org} />
				</TabsContent>
				<TabsContent value="drift" className="mt-4">
					<DriftTable rows={data.rows} />
				</TabsContent>
				<TabsContent value="waivers" className="mt-4">
					<WaiversTable waivers={data.waivers} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
