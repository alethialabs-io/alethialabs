"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { formatMinutes, formatRelative } from "@repo/format";
import { Ban, CheckCircle2, Clock, Hourglass } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { jobHref, useSecondsClock } from "@/components/jobs/columns";
import type { JobApproval } from "@/lib/rpc/procedures/jobs";

/** Where a request stands, as the notice words it. `expired` covers a pending request past its time. */
export type ApprovalStanding = "waiting" | "approved" | "started" | "rejected" | "expired" | "superseded";

/**
 * Where `approval` stands at `now`. A request still `pending` after `expires_at` is expired whether
 * or not anything has written that status yet: nobody can decide it any more, and a notice that
 * went on saying "waiting" would be the stuck-looking state this exists to prevent. Before the
 * clock is read (`now` null: the server render and hydration) a pending request reads as waiting.
 */
export function approvalStanding(approval: Pick<JobApproval, "status" | "expires_at">, now: number | null): ApprovalStanding {
	switch (approval.status) {
		case "pending":
			return now !== null && now >= new Date(approval.expires_at).getTime() ? "expired" : "waiting";
		case "approved":
			return "approved";
		case "consumed":
			return "started";
		case "rejected":
			return "rejected";
		case "expired":
			return "expired";
		case "superseded":
			return "superseded";
	}
}

/** The frame every standing shares: an icon, the standing as a title, and what it means underneath. */
function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
	return (
		// `role="status"`: the standing changes while the page is open (approved, expired), and that
		// is news for someone waiting on it, but never an interruption.
		<div role="status" data-slot="job-approval" className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2">
			<p className="flex items-center gap-2 text-ui-md font-medium text-text-primary">
				{icon}
				{title}
			</p>
			<p className="mt-1 pl-6 text-ui-sm text-text-tertiary">{children}</p>
		</div>
	);
}

/**
 * A plan's request to deploy or destroy, on the plan's own page.
 *
 * A deploy or a destroy asked for by a program — the CLI under a login, an agent — does not start
 * until a person approves it, and the request stays open for up to the organization's approval
 * window (60 minutes by default). For that whole time nothing is running and no job exists for it,
 * so without this the plan's page shows a finished plan and nothing else: a wait on a PERSON that
 * looks exactly like something stuck. The notice says who the wait is on, how long the request has
 * left, and what happened to it afterwards.
 */
export function JobApprovalNotice({ approval, org }: { approval: JobApproval; org: string }) {
	// Ticks once a second while mounted; only this notice re-renders with it.
	const now = useSecondsClock();
	const standing = approvalStanding(approval, now);
	const operation = approval.operation;
	const icon = "size-4 shrink-0 text-text-tertiary";
	/** " 3 minutes ago" for an instant, read against the browser's clock; empty until it has been read. */
	const ago = (at: string): string => (now === null ? "" : ` ${formatRelative(at, new Date(now))}`);

	switch (standing) {
		case "waiting": {
			const left = now === null ? null : new Date(approval.expires_at).getTime() - now;
			return (
				<Notice icon={<Hourglass className={icon} aria-hidden />} title="Waiting for approval">
					A {operation} from this plan was requested{ago(approval.requested_at)}. It is waiting for a person to
					approve it and starts when they do — nothing is running yet, and nothing is stuck.
					{left !== null && <> The request stays open for {formatMinutes(left / 60_000)} more.</>}
				</Notice>
			);
		}
		case "approved":
			return (
				<Notice icon={<CheckCircle2 className={icon} aria-hidden />} title="Approved — not started yet">
					The {operation} from this plan was approved{approval.decided_at ? ago(approval.decided_at) : ""}. Its job
					appears here when it starts.
				</Notice>
			);
		case "started":
			return (
				<Notice icon={<CheckCircle2 className={icon} aria-hidden />} title={`Approved — the ${operation} has started`}>
					The request was approved and used.{" "}
					{approval.consumed_job_id && (
						<Link
							href={jobHref(org, approval.consumed_job_id)}
							className="text-text-primary underline underline-offset-4"
						>
							View the {operation} job
						</Link>
					)}
				</Notice>
			);
		case "rejected":
			return (
				<Notice icon={<Ban className={icon} aria-hidden />} title="Approval rejected">
					The {operation} requested from this plan was rejected. Nothing was changed.
				</Notice>
			);
		case "expired":
			return (
				<Notice icon={<Clock className={icon} aria-hidden />} title="Approval request expired">
					Nobody decided the request in time, so the {operation} did not start and nothing was changed. Request it
					again to go ahead.
				</Notice>
			);
		case "superseded":
			return (
				<Notice icon={<Ban className={icon} aria-hidden />} title="Approval request replaced">
					A newer plan or a change to the project replaced this request before it was used. Nothing was changed.
				</Notice>
			);
	}
}
