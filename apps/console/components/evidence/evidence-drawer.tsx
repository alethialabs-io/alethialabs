// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The evidence detail drawer — the full drill-down in-place (no bounce to the job page).
// Three tabs over one environment: Report (per-control verdicts + findings + honest
// coverage blind-spots), Receipt (signed/unsigned + field grid + sealed exception +
// download), and Drift (per-resource divergence). Built on the shared Sheet + Tabs.

import Link from "next/link";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { Sheet, SheetContent } from "@repo/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { cn } from "@repo/ui/utils";
import type {
	VerifyControlResult,
	VerifyStatus,
} from "@/types/jsonb.types";
import type { EvidenceEnvRow } from "./evidence-derive";
import {
	EvIcon,
	type IconKey,
	kindTone,
	stageChipClass,
	TONE_TEXT,
} from "./evidence-status";

/** Verdict → the header mark (icon + label + tone) inside the drawer. */
const VERDICT_HEADER: Record<
	VerifyStatus,
	{ icon: IconKey; label: string; tone: "good" | "warn" | "bad" | "unknown" }
> = {
	pass: { icon: "shield-check", label: "Verified", tone: "good" },
	warn: { icon: "triangle-alert", label: "Warnings", tone: "warn" },
	fail: { icon: "shield-alert", label: "Failing", tone: "bad" },
	not_evaluable: {
		icon: "shield-question",
		label: "Not evaluable",
		tone: "unknown",
	},
};

const CONTROL_STATUS_ICON: Record<VerifyStatus, IconKey> = {
	pass: "shield-check",
	warn: "triangle-alert",
	fail: "shield-alert",
	not_evaluable: "shield-question",
};

const CONTROL_STATUS_TONE: Record<
	VerifyStatus,
	"good" | "warn" | "bad" | "unknown"
> = {
	pass: "good",
	warn: "warn",
	fail: "bad",
	not_evaluable: "unknown",
};

const KNOWN_CLOUDS = new Set([
	"aws",
	"gcp",
	"azure",
	"alibaba",
	"digitalocean",
	"hetzner",
	"civo",
]);

/** One control card: status + id/title, severity + provider chips, findings, coverage note. */
function ControlCard({ ctl }: { ctl: VerifyControlResult }) {
	const hasDetail =
		Boolean(ctl.frameworks?.length) ||
		Boolean(ctl.findings?.length) ||
		Boolean(ctl.coverage);
	return (
		<div className="overflow-hidden rounded-md border bg-surface">
			<div className="flex items-center gap-2.5 px-3 py-2.5">
				<EvIcon
					name={CONTROL_STATUS_ICON[ctl.status]}
					size={15}
					className={cn("shrink-0", TONE_TEXT[CONTROL_STATUS_TONE[ctl.status]])}
				/>
				<div className="flex min-w-0 flex-1 items-baseline gap-2">
					<span className="font-mono text-[11px] text-text-primary">{ctl.id}</span>
					<span className="truncate text-[12.5px] text-text-secondary">
						{ctl.title}
					</span>
				</div>
				<span className="shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wide text-text-tertiary">
					{ctl.severity}
				</span>
				<span className="shrink-0 font-mono text-[9px] text-text-disabled">
					{ctl.provider}
				</span>
			</div>
			{hasDetail && (
				<div className="flex flex-col gap-2.5 px-3 pb-3">
					{ctl.frameworks?.length ? (
						<div className="flex flex-wrap gap-1">
							{ctl.frameworks.map((fw) => (
								<span
									key={fw}
									className="rounded-xs bg-surface-sunken px-1.5 py-0.5 font-mono text-[9.5px] text-text-tertiary"
								>
									{fw}
								</span>
							))}
						</div>
					) : null}
					{(ctl.findings ?? []).map((f, i) => (
						<div
							key={`${f.address}-${i}`}
							className="border-l-2 border-border-strong pl-2.5"
						>
							<div className="font-mono text-[11px] text-text-primary">
								{f.address}
							</div>
							<div className="mt-0.5 text-[11.5px] leading-relaxed text-text-tertiary">
								{f.message}
							</div>
						</div>
					))}
					{ctl.coverage && (
						<div className="flex gap-2.5 rounded-sm border border-dashed border-border-strong bg-surface-sunken px-2.5 py-2">
							<span className="shrink-0 pt-px font-mono text-[8.5px] uppercase tracking-wide text-text-tertiary">
								Blind spot
							</span>
							<span className="text-[11.5px] leading-relaxed text-text-secondary">
								{ctl.coverage}
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/** One label/value receipt field row. */
function Field({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-3.5 border-b border-border-faint px-0.5 py-2.5">
			<span className="w-[130px] shrink-0 font-mono text-[9.5px] uppercase tracking-wide text-text-tertiary">
				{label}
			</span>
			<span className="flex-1 break-all font-mono text-[11px] leading-relaxed text-text-primary">
				{value}
			</span>
		</div>
	);
}

/** The evidence detail drawer for one environment. */
export function EvidenceDrawer({
	org,
	row,
	tab,
	onTab,
	onClose,
	onDownload,
}: {
	org: string;
	row: EvidenceEnvRow | null;
	tab: string;
	onTab: (t: string) => void;
	onClose: () => void;
	onDownload: (row: EvidenceEnvRow) => void;
}) {
	const report = row?.verify?.report ?? null;
	const receipt = row?.verify?.receipt ?? null;
	const drift = row?.drift ?? null;
	const provider = row?.provider ?? null;

	return (
		<Sheet open={Boolean(row)} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				side="right"
				className="w-[min(560px,96vw)] gap-0 border-border-strong bg-surface-raised p-0 sm:max-w-none"
			>
				{row && (
					<>
						<div className="shrink-0 border-b px-5 pb-3.5 pt-5">
							<div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-text-disabled">
								Evidence detail
							</div>
							<div className="flex items-center gap-2.5">
								{provider && KNOWN_CLOUDS.has(provider) ? (
									<ProviderIcon provider={provider} size={17} />
								) : (
									<EvIcon name="layers" size={16} className="text-text-tertiary" />
								)}
								<span className="font-display text-lg font-semibold tracking-tight text-text-primary">
									{row.projectName}
								</span>
								<span
									className={cn(
										"rounded-full border px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wider",
										stageChipClass(row.stage),
									)}
								>
									{row.stage}
								</span>
							</div>
							<div className="mt-1.5 font-mono text-[11px] text-text-tertiary">
								{row.environmentName} · {row.region}
								{row.verify && (
									<>
										{" · "}
										<Link
											href={`/${org}/~/jobs/${row.verify.jobId}`}
											className="underline-offset-2 hover:underline"
										>
											View job
										</Link>
									</>
								)}
							</div>
						</div>

						<Tabs
							value={tab}
							onValueChange={onTab}
							className="flex min-h-0 flex-1 flex-col"
						>
							<TabsList className="mx-5 mt-3.5 w-fit shrink-0">
								{report && <TabsTrigger value="report">Report</TabsTrigger>}
								{receipt && <TabsTrigger value="receipt">Receipt</TabsTrigger>}
								{drift && <TabsTrigger value="drift">Drift</TabsTrigger>}
							</TabsList>

							<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-4">
								{report && (
									<TabsContent value="report" className="flex flex-col gap-4">
										<div className="flex flex-wrap items-center gap-3 rounded-md border bg-surface px-3.5 py-3">
											<span
												className={cn(
													"inline-flex items-center gap-2",
													TONE_TEXT[VERDICT_HEADER[report.verdict].tone],
												)}
											>
												<EvIcon
													name={VERDICT_HEADER[report.verdict].icon}
													size={17}
												/>
												<span className="font-display text-[15px] font-semibold text-text-primary">
													{VERDICT_HEADER[report.verdict].label}
												</span>
											</span>
											<span className="flex-1" />
											<span className="font-mono text-[10px] text-text-tertiary">
												{report.provider} · {report.catalog_version}
											</span>
										</div>
										<div className="flex flex-wrap gap-2">
											{(
												[
													["pass", report.summary.pass],
													["warn", report.summary.warn],
													["fail", report.summary.fail],
													["not evaluable", report.summary.not_evaluable],
												] as const
											).map(([label, count]) => (
												<div
													key={label}
													className="flex min-w-[70px] flex-col gap-0.5 rounded-sm border px-3 py-2"
												>
													<span className="font-display text-lg font-semibold tabular-nums text-text-primary">
														{count}
													</span>
													<span className="font-mono text-[9px] uppercase tracking-wide text-text-tertiary">
														{label}
													</span>
												</div>
											))}
										</div>
										<div className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-disabled">
											Controls
										</div>
										<div className="flex flex-col gap-2.5">
											{report.controls.map((c) => (
												<ControlCard key={c.id} ctl={c} />
											))}
										</div>
									</TabsContent>
								)}

								{receipt && (
									<TabsContent value="receipt" className="flex flex-col gap-4">
										<div className="flex items-center gap-3 rounded-md border bg-surface px-3.5 py-3">
											<EvIcon
												name={
													receipt.algorithm === "ed25519"
														? "file-check"
														: "file-minus"
												}
												size={18}
												className="text-text-secondary"
											/>
											<div className="flex-1">
												<div className="font-display text-[14px] font-semibold text-text-primary">
													{receipt.algorithm === "ed25519"
														? "Signed receipt"
														: "Unsigned receipt"}
												</div>
												<div className="mt-0.5 font-mono text-[10px] text-text-tertiary">
													{receipt.key_id ?? receipt.algorithm}
												</div>
											</div>
											<button
												type="button"
												onClick={() => onDownload(row)}
												className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-ink px-3 text-[12px] font-medium text-ink-foreground transition-colors hover:bg-ink-hover"
											>
												<EvIcon name="download" size={14} />
												Download
											</button>
										</div>
										<div className="flex flex-col">
											<Field
												label="plan sha256"
												value={
													receipt.receipt.plan_sha256
														? `${receipt.receipt.plan_sha256.slice(0, 24)}…`
														: "—"
												}
											/>
											<Field
												label="catalog"
												value={receipt.receipt.catalog_version}
											/>
											<Field label="provider" value={receipt.receipt.provider} />
											{receipt.receipt.tofu_version && (
												<Field
													label="opentofu"
													value={receipt.receipt.tofu_version}
												/>
											)}
											{receipt.receipt.evaluated_at && (
												<Field
													label="evaluated"
													value={receipt.receipt.evaluated_at}
												/>
											)}
											{receipt.receipt.runner && (
												<Field label="runner" value={receipt.receipt.runner} />
											)}
										</div>
										{receipt.receipt.exception && (
											<div className="rounded-md border border-dashed border-border-strong bg-surface-sunken px-3.5 py-3">
												<div className="mb-2 font-mono text-[9px] uppercase tracking-[0.13em] text-text-tertiary">
													Sealed exception
												</div>
												<div className="mb-2 flex flex-wrap gap-1">
													{receipt.receipt.exception.controls.map((c) => (
														<span
															key={c}
															className="rounded-xs border px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
														>
															{c}
														</span>
													))}
												</div>
												<div className="text-[12px] leading-relaxed text-text-secondary">
													{receipt.receipt.exception.reason}
												</div>
												<div className="mt-2 font-mono text-[10px] text-text-tertiary">
													{receipt.receipt.exception.by}
												</div>
											</div>
										)}
										<div className="flex gap-2.5 rounded-sm border bg-surface px-3 py-2.5">
											<EvIcon
												name="shield-question"
												size={14}
												className="mt-px shrink-0 text-text-tertiary"
											/>
											<span className="text-[11.5px] leading-relaxed text-text-tertiary">
												A receipt attests that this verdict is reproducible given
												the same plan — not a proof of compliance. Anchor it with a
												customer-controlled key or a transparency log to
												strengthen the root of trust.
											</span>
										</div>
									</TabsContent>
								)}

								{drift && (
									<TabsContent value="drift" className="flex flex-col gap-3">
										<div className="font-mono text-[11px] text-text-secondary">
											{drift.inSync
												? "In sync — no managed resource has drifted."
												: `${drift.drifted} resource${drift.drifted === 1 ? "" : "s"} diverged from the provisioned state.`}
										</div>
										{drift.details.length > 0 && (
											<div className="flex flex-col overflow-hidden rounded-md border">
												{drift.details.map((d) => (
													<div
														key={d.address}
														className="flex items-center gap-3 border-b border-border-faint bg-surface px-3 py-2.5 last:border-0"
													>
														<span
															className={cn(
																"shrink-0 rounded-full border border-border-strong px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-wide",
																TONE_TEXT[kindTone(d.kind)],
															)}
														>
															{d.kind}
														</span>
														<div className="min-w-0 flex-1">
															<div className="truncate font-mono text-[11.5px] text-text-primary">
																{d.address}
															</div>
															<div className="mt-0.5 font-mono text-[10px] text-text-tertiary">
																{d.type}
															</div>
														</div>
													</div>
												))}
											</div>
										)}
									</TabsContent>
								)}
							</div>
						</Tabs>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}
