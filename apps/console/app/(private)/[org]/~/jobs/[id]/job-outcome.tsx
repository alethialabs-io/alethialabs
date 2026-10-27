"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";
import { CheckCircle2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { DriftDetail, DriftPosture } from "@/types/jsonb.types";
import { DRIFT_PREVIEW_COUNT, type JobResult, countNoun, readJobResult } from "./job-result";

/** The kind pill's word for each way a resource diverged (the Go `drift.Kind`). */
const KIND_LABEL: Record<DriftDetail["kind"], string> = {
	modified: "Modified",
	deleted: "Deleted",
	other: "Other",
};

/** The frame every result shares: bordered, under the status line, headed by its finding. */
function ResultFrame({
	finding,
	label,
	children,
}: {
	/** The block's first line — what the job FOUND, which the status pill does not say. */
	finding: string;
	/** What kind of result this is, for assistive tech (the heading is the finding, not the kind). */
	label: string;
	children?: ReactNode;
}) {
	return (
		<section aria-label={label} data-slot="job-outcome" className="mt-3 rounded-md border border-border px-3 py-2.5">
			<SectionHeading level={2} title={finding} />
			{children}
		</section>
	);
}

/** One drifted resource: a grayscale kind pill, its address, and the attribute paths that differed. */
function DriftRow({ detail }: { detail: DriftDetail }) {
	return (
		<li className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1">
			<span className="w-16 shrink-0 rounded-sm border border-border px-1.5 text-center font-mono text-ui-3xs uppercase text-text-secondary">
				{KIND_LABEL[detail.kind]}
			</span>
			<span className="min-w-0 break-all font-mono text-ui-sm text-text-primary">{detail.address}</span>
			{/* Paths, never values (`DriftDetail.attributes`). Empty means "not computed". */}
			{detail.attributes && detail.attributes.length > 0 && (
				<span className="min-w-0 break-all text-ui-xs text-text-tertiary">{detail.attributes.join(", ")}</span>
			)}
		</li>
	);
}

/**
 * A drift job's result: the drifted count as the finding, what was dismissed and what was not
 * checked, then the first {@link DRIFT_PREVIEW_COUNT} resources with a disclosure for the rest.
 */
function DriftResult({ posture }: { posture: DriftPosture }) {
	const [showAll, setShowAll] = useState(false);
	const details = posture.details ?? [];
	const shown = showAll ? details : details.slice(0, DRIFT_PREVIEW_COUNT);
	const hidden = details.length - DRIFT_PREVIEW_COUNT;
	const finding = posture.in_sync
		? "In sync — no managed resource has drifted."
		: `${countNoun(posture.drifted, "resource")} drifted`;
	const normalized = posture.normalized ?? 0;

	return (
		<ResultFrame finding={finding} label="Drift result">
			<div className="mt-1 space-y-0.5 text-ui-sm text-text-tertiary">
				{normalized > 0 && <p>{countNoun(normalized, "difference")} dismissed as representational</p>}
				{/* So the count is never read as "everything": a refresh-only scan cannot see what is
				    in the cloud but not in state. */}
				{posture.unmanaged_known ? (
					posture.unmanaged > 0 && <p>{countNoun(posture.unmanaged, "unmanaged resource")} found</p>
				) : (
					<p>Unmanaged resources: not checked by a refresh-only scan</p>
				)}
			</div>
			{details.length > 0 && (
				<ul
					aria-label="Drifted resources"
					className={cn(
						"mt-2 divide-y divide-border/40 border-t border-border/40",
						// Expanded, the list scrolls inside the header rather than pushing the log off screen.
						showAll && "max-h-48 overflow-y-auto",
					)}
				>
					{shown.map((d, i) => (
						<DriftRow key={`${d.address}-${i}`} detail={d} />
					))}
				</ul>
			)}
			{hidden > 0 && (
				<div className="mt-1 flex items-center gap-2 text-ui-sm text-text-tertiary">
					{!showAll && <span>… {hidden} more</span>}
					<Button
						variant="link"
						size="sm"
						className="h-auto px-0"
						aria-expanded={showAll}
						onClick={() => setShowAll((v) => !v)}
					>
						{showAll ? "Show fewer" : `Show all ${details.length}`}
					</Button>
				</div>
			)}
		</ResultFrame>
	);
}

/** A plan job's result: the change total as the finding, the per-action counts, and the cost line. */
function PlanResult({ result }: { result: Extract<NonNullable<JobResult>, { kind: "plan" }> }) {
	const { counts, cost } = result;
	const total = counts.create + counts.update + counts.delete + counts.replace;
	const finding =
		total === 0
			? "No changes — the infrastructure matches the configuration."
			: `${countNoun(total, "change")} planned`;

	return (
		<ResultFrame finding={finding} label="Plan result">
			<p className="mt-1 font-mono text-ui-sm text-text-secondary">
				+{counts.create} to create · ~{counts.update} to update · −{counts.delete} to destroy · ±{counts.replace} to
				replace
			</p>
			{cost && (
				<p className="mt-0.5 text-ui-sm text-text-tertiary">
					{cost.delta !== null && (
						<>
							Monthly cost change <span className="font-mono text-text-secondary">{cost.delta}</span>
						</>
					)}
					{cost.delta !== null && cost.total !== null && " · "}
					{cost.total !== null && (
						<>
							Estimated total <span className="font-mono text-text-secondary">{cost.total}</span>
						</>
					)}
				</p>
			)}
		</ResultFrame>
	);
}

/**
 * The outcome of a SUCCESSFUL job, under its status line (#6134). `SUCCESS` means the job ran; for
 * a drift scan or a plan, this block says what it FOUND, from the result the runner stored on the
 * row. A job with no structured result keeps the plain sentence it always had.
 */
export function JobOutcome({
	job,
}: {
	job: { job_type: string; status: string; execution_metadata: unknown };
}) {
	const result = readJobResult(job);

	if (result === null) {
		return (
			<p className="mt-3 flex items-center gap-2 text-ui-md text-text-secondary">
				<CheckCircle2 className="size-4 shrink-0" />
				Job completed successfully.
			</p>
		);
	}

	if (result.kind === "unreadable") {
		const subject = result.subject === "drift" ? "Drift" : "Plan";
		return (
			<ResultFrame finding={`${subject} summary unavailable`} label={`${subject} result`}>
				<p className="mt-1 text-ui-sm text-text-tertiary">
					The job completed, but its stored result could not be read. The raw output is in the log below.
				</p>
			</ResultFrame>
		);
	}

	return result.kind === "drift" ? <DriftResult posture={result.posture} /> : <PlanResult result={result} />;
}
