"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The decision sheet's scrolling body (spec §1.4): Request, Reviewed plan (or What gets destroyed),
// and the requester's note. What would run is read from the PLAN JOB the approval is bound to —
// never from the requester's account of it — and the note is untrusted text, shown as data.

import { formatDate, formatMonthlyRate, formatRelative } from "@repo/format";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { Skeleton } from "@repo/ui/skeleton";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { z } from "zod";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";
import { parsePlanJSON, resolveAction } from "@/lib/plan/parse-plan";
import type { ApprovalDetail } from "@/lib/queries/approvals";
import { orpc } from "@/lib/rpc/client";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import type { ExecutionMetadata, VerifyStatus } from "@/types/jsonb.types";
import { ApprovalCountdown } from "./approval-countdown";
import { OperationTag, ProductionPill, RequesterMark } from "./approval-marks";
import { requestedThrough, requesterName } from "./approval-vocabulary";

/** A verify verdict as a status: its tier and its words. */
const VERDICT: Record<VerifyStatus, { tier: StatusTier; label: string }> = {
	pass: { tier: "active", label: "Passed" },
	warn: { tier: "pending", label: "Passed with warnings" },
	fail: { tier: "failed", label: "Failed" },
	not_evaluable: { tier: "idle", label: "Not checked" },
};

/** One fact row: a term and its value. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-1 gap-1 py-2 sm:grid-cols-[9rem_1fr] sm:gap-4">
			<dt className="text-ui-sm text-text-secondary">{term}</dt>
			<dd className="min-w-0 text-ui-md text-text-primary">{children}</dd>
		</div>
	);
}

/** The Request section: what is asked, where, for whom, through what, and until when. */
export function RequestSection({ approval }: { approval: ApprovalDetail }) {
	const through = requestedThrough(approval);
	return (
		<section aria-label="Request">
			<SectionHeading level={3} title="Request" />
			<dl className="mt-2 divide-y divide-border">
				<Fact term="Operation">
					<OperationTag operation={approval.operation} />
				</Fact>
				<Fact term="Project">{approval.project_name}</Fact>
				<Fact term="Environment">
					<span className="flex flex-wrap items-center gap-2">
						<span className="font-mono">{approval.environment_name}</span>
						{approval.environment_stage === "production" ? <ProductionPill /> : null}
					</span>
					{approval.environment_stage === "production" ? (
						<span className="mt-1 block text-ui-sm text-text-secondary">This environment serves your customers.</span>
					) : null}
				</Fact>
				<Fact term="Requested for">{approval.requester_name ?? "Unknown person"}</Fact>
				<Fact term="Requested through">
					<span className="flex items-center gap-1.5">
						<RequesterMark approval={approval} size={16} />
						{through.name}
					</span>
					{through.kind ? <span className="mt-0.5 block text-ui-sm text-text-secondary">{through.kind}</span> : null}
				</Fact>
				<Fact term="Requested">
					{formatDate(approval.created_at, "datetime")}{" "}
					<span className="text-text-secondary">· {formatRelative(approval.created_at)}</span>
				</Fact>
				<Fact term="Expires">
					{formatDate(approval.expires_at, "datetime")}
					{approval.status === "pending" ? (
						<>
							{" "}
							<span className="text-text-secondary">·</span> <ApprovalCountdown expiresAt={approval.expires_at} />
						</>
					) : null}
				</Fact>
			</dl>
		</section>
	);
}

/** The plan job's counts, cost and verdict, read from its stored output. */
interface PlanFacts {
	counts: { create: number; update: number; replace: number; delete: number } | null;
	monthly: number | null;
	verdict: VerifyStatus | null;
	/**
	 * The addresses a destroy-mode plan removes, in plan order, or null when the job is not a destroy
	 * plan (`execution_metadata.destroy_plan`, #7455) or reported no readable changes.
	 */
	teardown: string[] | null;
}

// A destroy plan's posted `resource_changes` carry each resource's identity and actions only — the
// runner drops `before`/`after` (apps/runner/internal/agent/runner.go, destroyPlanChanges). Lenient
// like parsePlanJSON: an entry it cannot read is skipped, a malformed list reads as nothing.
const teardownSchema = z
	.object({
		resource_changes: z
			.array(
				z
					.object({
						address: z.string().catch(""),
						mode: z.string().catch("managed"),
						change: z.object({ actions: z.array(z.string()).catch([]) }).catch({ actions: [] }),
					})
					.catch({ address: "", mode: "managed", change: { actions: [] } }),
			)
			.catch([]),
	})
	.catch({ resource_changes: [] });

/**
 * The managed resources a destroy plan removes, by address. A data source is read, not owned, so a
 * teardown never removes one; an entry the plan does not delete is not part of the teardown.
 */
function teardownOf(planResult: Record<string, unknown>): string[] {
	return teardownSchema
		.parse(planResult)
		.resource_changes.filter((rc) => rc.address !== "" && rc.mode !== "data" && resolveAction(rc.change.actions) === "delete")
		.map((rc) => rc.address);
}

/** The facts of a plan job's execution metadata; nulls where the runner reported nothing readable. */
function planFactsOf(meta: ExecutionMetadata | null | undefined): PlanFacts {
	// parsePlanJSON / parseCostBreakdown are lenient: a malformed output reads as nothing, never throws.
	return {
		counts: meta?.plan_result ? parsePlanJSON(meta.plan_result).counts : null,
		monthly: meta?.cost_breakdown ? parseCostBreakdown(meta.cost_breakdown).totalMonthlyCost : null,
		verdict: meta?.verify_result?.verdict ?? null,
		teardown: meta?.destroy_plan && meta.plan_result ? teardownOf(meta.plan_result) : null,
	};
}

/**
 * What a destroy removes: from a destroy-mode plan, every resource it lists, each marked removed and
 * nothing counted as added or changed. A destroy bound to anything else (an approval from before
 * destroy plans existed) keeps the general statement and points at the plan.
 */
function Teardown({ pending, failed, teardown }: { pending: boolean; failed: boolean; teardown: string[] | null }) {
	if (pending) return <Skeleton className="h-4 w-48" />;
	if (teardown === null) {
		return (
			<>
				Everything this environment runs
				<span className="mt-0.5 block text-ui-sm text-text-secondary">
					{failed ? "Couldn't read the destroy plan. Open the plan to see what it removes." : "As listed in the destroy plan."}
				</span>
			</>
		);
	}
	if (teardown.length === 0) {
		return <span className="text-text-secondary">The destroy plan removes nothing: this environment has no resources.</span>;
	}
	return (
		<>
			<span className="font-medium text-text-primary">
				{teardown.length} resource{teardown.length > 1 ? "s" : ""}, all removed
			</span>
			<ul aria-label="Resources the destroy plan removes" className="mt-2 max-h-80 divide-y divide-border overflow-y-auto rounded-md border">
				{teardown.map((address) => (
					<li key={address} className="flex items-baseline justify-between gap-3 px-2 py-1.5">
						<span className="min-w-0 break-all font-mono text-ui-sm text-text-primary">{address}</span>
						<span className="shrink-0 text-ui-sm text-text-secondary">removed</span>
					</li>
				))}
			</ul>
		</>
	);
}

/** `+14 to add`, dimmed at zero. */
function Count({ n, word, strong = false }: { n: number; word: string; strong?: boolean }) {
	return (
		<span className={n === 0 ? "text-text-tertiary" : strong ? "font-medium text-text-primary" : "text-text-primary"}>
			{n} {word}
		</span>
	);
}

/**
 * The Reviewed plan section — or, for a destroy, What gets destroyed — read from the plan job
 * (`jobs.planResult`), never from the request. The digest is the check a person can do by eye: the
 * requester was shown the same eight characters.
 */
export function PlanSection({ approval, orgSlug }: { approval: ApprovalDetail; orgSlug: string }) {
	const isDestroy = approval.operation === "destroy";
	const plan = useQuery({
		...orpc.jobs.planResult.queryOptions({ input: { id: approval.plan_job_id } }),
		retry: retryUnlessRefused,
	});
	const facts = plan.data ? planFactsOf(plan.data.execution_metadata) : null;
	const planHref = `/${orgSlug}/~/jobs/${approval.plan_job_id}`;
	const via = requesterName(approval);

	return (
		<section aria-label={isDestroy ? "What gets destroyed" : "Reviewed plan"}>
			<SectionHeading
				level={3}
				title={isDestroy ? "What gets destroyed" : "Reviewed plan"}
				description={isDestroy ? "Read from the destroy plan, not from the request." : "Read from the plan job, not from the request."}
				actions={
					<Button variant="outline" size="sm" nativeButton={false} render={<Link href={planHref} />}>
						<ExternalLink aria-hidden />
						Open plan
					</Button>
				}
			/>
			<dl className="mt-2 divide-y divide-border">
				{isDestroy ? (
					<Fact term="Removes">
						<Teardown pending={plan.isPending} failed={plan.isError} teardown={facts?.teardown ?? null} />
					</Fact>
				) : (
					<Fact term="Changes">
						{plan.isPending ? (
							<Skeleton className="h-4 w-48" />
						) : facts?.counts ? (
							<>
								<span className="flex flex-wrap gap-x-3 font-mono text-ui-md">
									<Count n={facts.counts.create} word="to add" />
									<Count n={facts.counts.update} word="to change" />
									{facts.counts.replace ? <Count n={facts.counts.replace} word="to replace" /> : null}
									<Count n={facts.counts.delete} word="to destroy" strong />
								</span>
								{facts.counts.delete ? (
									<span className="mt-1 block text-ui-sm text-text-secondary">
										This deploy removes {facts.counts.delete} existing resource{facts.counts.delete > 1 ? "s" : ""}.
									</span>
								) : null}
							</>
						) : (
							<span className="text-text-secondary">
								{plan.isError ? "Couldn't read the plan's changes. Open the plan to see them." : "The plan reported no changes."}
							</span>
						)}
					</Fact>
				)}
				{!isDestroy ? (
					<Fact term="Cost">
						{plan.isPending ? (
							<Skeleton className="h-4 w-32" />
						) : facts?.monthly != null ? (
							<>
								<span className="font-mono">{formatMonthlyRate(facts.monthly, "exact")}</span>{" "}
								<span className="text-text-secondary">estimated after this deploy</span>
							</>
						) : (
							<span className="text-text-secondary">No estimate for this plan</span>
						)}
					</Fact>
				) : null}
				<Fact term="Verification">
					{plan.isPending ? (
						<Skeleton className="h-4 w-24" />
					) : (
						<StatusBadge
							status={facts?.verdict ?? "not_evaluable"}
							tier={VERDICT[facts?.verdict ?? "not_evaluable"].tier}
							label={VERDICT[facts?.verdict ?? "not_evaluable"].label}
						/>
					)}
				</Fact>
				<Fact term="Plan digest">
					<span className="inline-flex rounded border px-2 py-0.5 font-mono text-ui-lg tracking-widest text-text-primary">
						{approval.digest_prefix}
					</span>
					<span className="mt-1.5 block text-ui-sm text-text-secondary">
						{via} showed the requester these same 8 characters. If they don&apos;t match, deny.
					</span>
				</Fact>
				<Fact term="Plan job">
					<Link className="font-mono underline underline-offset-2" href={planHref}>
						{approval.plan_job_id.slice(0, 8)}
					</Link>
				</Fact>
			</dl>
		</section>
	);
}

/** The requester's note: untrusted text, said to be so, rendered as data. */
export function NoteSection({ approval }: { approval: ApprovalDetail }) {
	if (!approval.note) return null;
	const via = requesterName(approval);
	return (
		<section aria-labelledby="approval-note" className="space-y-2">
			<figure className="rounded-md border border-dashed p-3">
				<figcaption className="flex items-center justify-between gap-2">
					<span id="approval-note" className="font-mono text-ui-2xs uppercase tracking-wide text-text-secondary">
						Note from the requester
					</span>
					<span className="text-ui-sm text-text-tertiary">Not checked by Alethia</span>
				</figcaption>
				<blockquote className="mt-1 whitespace-pre-wrap break-words text-ui-md text-text-primary">{approval.note}</blockquote>
			</figure>
			<p className="text-ui-sm text-text-secondary">
				Decide on the plan above. The note is written by {via} and can say anything.
			</p>
		</section>
	);
}
