"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { applyPlan, cancelJob, rerunJob } from "@/app/server/actions/jobs";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { RegionError } from "@/components/errors/region-error";
import { RegionRefusal } from "@/components/errors/region-refusal";
import { ClockSlot, JOB_TYPES, JobDuration, RelativeTime } from "@/components/jobs/columns";
import { JobNotFoundState } from "@/components/jobs/job-not-found-state";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
// `FactList`/`Fact` are the console's ONE label-and-value list. They live under `settings/usage`
// because that is where they were first needed, and this page is their second consumer — which is
// the argument for #3628 promoting them into `@repo/ui` beside `SectionHeading`. That promotion is
// one shared decision across two lanes and is deliberately NOT taken here; importing them is what
// keeps this page from becoming the third rendering of a term and its value.
import { Fact, FactList } from "@/components/settings/usage/usage-primitives";
import { useHydrated } from "@repo/ui/use-hydrated";
import { useJobLogStream } from "@/hooks/use-job-log-stream";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { JOB_ACTION } from "@/lib/copy/vocabulary";
import { type RerunRoute, rerunRouteOf } from "@/lib/jobs/operation";
import { qk } from "@/lib/query/keys";
import { orpc } from "@/lib/rpc/client";
import type { JobDetail as JobDetailRow } from "@/lib/rpc/procedures/jobs";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { formatDate } from "@repo/format";
import { Button } from "@repo/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { PageToolbar } from "@repo/ui/page-toolbar";
import { SectionHeading } from "@repo/ui/section-heading";
import { StatusBadge } from "@repo/ui/status-badge";
import { TooltipProvider } from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import { Ban, ChevronRight, Loader2, RefreshCw, Rocket, XCircle } from "lucide-react";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useState } from "react";

import JobDetailLoading from "./loading";
import { JOB_DETAIL_SECTIONS, JOB_VIEWPORT_HEIGHT } from "./detail-column";
import { JobApprovalNotice } from "./job-approval";
import { JobLog } from "./job-log";
import { DeployWarnings, JobOutcome } from "./job-outcome";

/**
 * One collapsible block of the job's detail column — a real heading over a disclosure.
 *
 * The three blocks used to be three copies of a bare `<button>` carrying a 12px label, so nothing
 * on this page appeared in the document outline at all: a screen reader moving by heading skipped
 * from the breadcrumb to the end of the page. The heading is `SectionHeading` and the button lives
 * INSIDE it, which is the accordion pattern that keeps both — a heading you can navigate to, and a
 * control that says whether it is open. The reverse nesting (a heading inside a button) is what a
 * "make the whole row clickable" instinct produces and it is invalid content: a `<button>` takes
 * phrasing content, and it swallows the heading it contains.
 */
function DetailSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Collapsible className="border-b border-border/40 last:border-b-0">
			{/* TWO hops, and both are needed — `[&>div]:w-full` alone leaves the target as small as
			    the label. `SectionHeading` nests `div > div.flex-col > div.flex-row > h2 > {title}`.
			    The first selector widens the direct child column, and the row inside it stretches on
			    its own (a `flex-col` parent's cross axis). But the `<h2>` is a flex ITEM of that row,
			    so it is `flex-grow: 0` and sized to its content — and the trigger's own `w-full`
			    resolves against exactly that box. `[&_h2]:flex-1` is what makes the heading claim the
			    row; `min-w-0` is what lets its `truncate` still shorten instead of overflowing. Without
			    the pair, four fifths of the row is dead — a smaller target than the full-width
			    `<button>` this replaced, and every other Collapsible in the console keeps `w-full`.
			    (`SectionHeading` renders no count, so nothing else competes for the row.) */}
			<SectionHeading
				className="py-2.5 [&>div]:w-full [&_h2]:min-w-0 [&_h2]:flex-1"
				level={2}
				title={
					// `ring-inset`, and it is load-bearing: `SectionHeading` renders its heading with
					// `truncate` (`overflow: hidden`), so a default focus outline — drawn OUTSIDE the
					// button's border box — is clipped on all four sides and the control becomes
					// invisible to a keyboard. An inset ring is drawn inside the box and survives.
					<CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm text-left text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
						{/* `data-panel-open`, NOT `data-state=open`: `@repo/ui/collapsible` is base-ui,
						    which renamed the attribute, and the Tailwind variant that reads the Radix
						    name compiles to a selector nothing ever matches — a chevron that silently
						    never turns. Its own header records the rename. */}
						<ChevronRight className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90" />
						{title}
					</CollapsibleTrigger>
				}
			/>
			<CollapsibleContent className="pb-4">{children}</CollapsibleContent>
		</Collapsible>
	);
}

const [DETAILS_TITLE, CONFIG_TITLE, METADATA_TITLE] = JOB_DETAIL_SECTIONS;

/** A pretty-printed JSONB payload — the config snapshot and the execution metadata. */
function JsonBlock({ value }: { value: unknown }) {
	return (
		<pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-ui-xs text-text-tertiary">
			{JSON.stringify(value, null, 2)}
		</pre>
	);
}

/**
 * A payload section's body: the JSON when the job recorded any, and otherwise one line saying it did
 * not. The section itself is drawn either way (`JOB_DETAIL_SECTIONS` says why), so an absent payload
 * is an answer the reader can open rather than a row that silently is not there.
 */
function PayloadBlock({ value, absent }: { value: unknown; absent: string }) {
	const empty = typeof value !== "object" || value === null || Object.keys(value).length === 0;
	if (empty) return <p className="text-ui-sm text-text-tertiary">{absent}</p>;
	return <JsonBlock value={value} />;
}

/** Widest text {@link LocalDateTime} prints, so its slot is that wide before hydration. */
const DATETIME_SIZER = "Sep 30, 2026, 12:00 PM";

/** A timestamp in the browser's timezone — read only after hydration, in a width-reserving slot. */
function LocalDateTime({ at }: { at: Date | string | null }) {
	const hydrated = useHydrated();
	// No instant, no clock: "—" is the same on the server and in the browser.
	if (at === null) return formatDate(null, "datetime");
	return <ClockSlot sizer={DATETIME_SIZER}>{hydrated ? formatDate(at, "datetime") : null}</ClockSlot>;
}

/**
 * Every query key that shows a job this page changes: the jobs reads, the shell's job list, and —
 * for a job of an environment — that environment's job history and status.
 */
function jobKeys(org: string, job: Pick<JobDetailRow, "project_id" | "environment_id"> | null): QueryKey[] {
	const keys: QueryKey[] = [orpc.jobs.key(), qk.jobs(org)];
	if (job?.project_id) {
		keys.push(
			qk.environmentJobs(job.project_id, job.environment_id),
			qk.environmentStatus(job.project_id, job.environment_id),
		);
	}
	return keys;
}

/**
 * What the re-run confirmation says a re-run will do. A plan or a deploy names the environment it
 * runs against and says it uses the project's current configuration — not the configuration this
 * job ran with, which is the difference a reader of an old job cannot see from the job itself.
 */
function rerunDescription(
	route: Exclude<RerunRoute, { kind: "refuse" }>,
	job: Pick<JobDetailRow, "project_name" | "environment_name">,
): string {
	if (route.kind === "copy") return "A new job is queued with the same input as this one.";
	const environment = job.environment_name
		? `the environment ${job.environment_name}`
		: "the project's default environment";
	const project = job.project_name ? ` of ${job.project_name}` : "";
	return `A new ${route.operation} is queued for ${environment}${project}. It runs with the project's current configuration, not the configuration this job ran with.`;
}

/**
 * Full-page job detail view with realtime log streaming (SSE).
 *
 * THE FRAME IS HYBRID, and `detail-column.ts` carries the reason: the log runs the full width of
 * the shell's frame while everything else — the status line, the outcome, the job's facts and the
 * two JSON payloads — sits in a narrower centred column, because one of those is scanned and the
 * rest are read.
 *
 * FIRST PAINT CARRIES THE JOB AND THE HEAD OF ITS LOG: `page.tsx` prefetches `jobs.detail` and
 * `jobs.logsHead` on the server, so nothing here fetches on mount. The status stays current through
 * the org's change stream — a `jobs` hint invalidates `jobs.detail` (`TOPIC_KEYS`,
 * lib/query/topics.ts), no poll here — and the log through its own event stream
 * (`useJobLogStream`), which resumes after the head's last line while the job runs and is not
 * opened at all for a job whose log is already complete.
 *
 * EVERY CONTROL ANSWERS FOR ITSELF. The job read carries what this reader may do (`job.can`,
 * decided by the question each write asks), so Cancel, Deploy and Re-run are disabled with the
 * reason for a reader who may not use them — never enabled and then refused.
 */
export function JobDetail({
	jobId,
	column,
}: {
	jobId: string;
	/** The prose column's width classes — the route's `JOB_DETAIL_COLUMN`, shared with its skeleton. */
	column: string;
}) {
	const { org } = useParams<{ org: string }>();
	const router = useRouter();

	const detail = useQuery(orpc.jobs.detail.queryOptions({ input: { id: jobId } }));
	const head = useQuery(orpc.jobs.logsHead.queryOptions({ input: { id: jobId } }));
	const job = detail.data ?? null;
	const jobState = job?.status ?? null;
	const jobError = job?.error_message ?? null;
	const isActive = jobState === "QUEUED" || jobState === "CLAIMED" || jobState === "PROCESSING";
	const isTerminal = jobState === "SUCCESS" || jobState === "FAILED" || jobState === "CANCELLED";
	// A finished job whose head is its whole log gets no stream; one that finishes while this page
	// is open is asked once for the rest (hooks/use-job-log-stream.ts).
	const log = useJobLogStream(jobId, head.data, !head.isPending, { finished: isTerminal });
	// Cancelling is not undoable — `cancelJob` writes CANCELLED and signals the runner to abort the
	// in-flight tofu run — so the click opens a confirmation rather than reaching the action.
	// Registry: `jobs.cancel` in apps/console/destructive-actions.yaml.
	const [confirmCancel, setConfirmCancel] = useState(false);
	// A re-run starts a new operation, so its click opens a confirmation too.
	// Registry: `jobs.rerun` in apps/console/destructive-actions.yaml.
	const [confirmRerun, setConfirmRerun] = useState(false);

	const invalidates = () => jobKeys(org, job);
	const rerun = useActionMutation(rerunJob, {
		invalidates,
		successMessage: "Job re-queued",
		onSuccess: (created) => {
			setConfirmRerun(false);
			router.push(`/${org}/~/jobs/${created.id}`);
		},
	});
	const cancel = useActionMutation(cancelJob, {
		invalidates,
		successMessage: "Job cancelled",
	});
	const apply = useActionMutation(applyPlan, {
		invalidates,
		successMessage: "Deploy job created",
		onSuccess: (created) => router.push(`/${org}/~/jobs/${created.jobId}`),
	});
	// One guard for the three: while any of them is in flight, none can be pressed again.
	const actionLoading = rerun.isPending || cancel.isPending || apply.isPending;

	// A QUEUED job has no runner and no run in flight: `cancelJob` only signals a runner when
	// `job.runner_id && (status === CLAIMED || PROCESSING)` (app/server/actions/jobs.ts). Told
	// unconditionally that "its runner is signalled to abort the run in flight" and "anything
	// already applied is not rolled back", an operator cancelling a job that has not started reads
	// the SAFE case as the dangerous one — and having been told once that a cancel leaves debris,
	// hesitates on every queued job after it. So the middle clause is conditioned on the state.
	// Anything that is not QUEUED takes the started copy, including a status that went terminal
	// while the dialog was open; the dialog is deliberately mounted outside `isActive`, so the
	// sentence tracks the job rather than freezing at click time.
	const cancelStarted = jobState !== "QUEUED";
	const isPlanSuccess = job?.job_type === "PLAN" && jobState === "SUCCESS";
	// How this job may be run again — the same rule `rerunJob` applies on the server
	// (lib/jobs/operation.ts). A kind it refuses (a destroy, a scan, a runner's lifecycle job) gets
	// no Re-run button: the control is absent rather than present and refused.
	const rerunRoute = job
		? rerunRouteOf({ job_type: job.job_type, project_id: job.project_id, environment_id: job.environment_id })
		: null;
	const rerunnable = rerunRoute !== null && rerunRoute.kind !== "refuse" ? rerunRoute : null;
	const info = job ? JOB_TYPES[job.job_type] : null;
	const Icon = info?.icon;

	// The route skeleton, not a spinner: the same shape as the page (B2). Reached only when the
	// server prefetch did not land (it normally does).
	if (detail.isPending) return <JobDetailLoading />;

	if (detail.isError) {
		// A refusal is not a failure, and neither is "nothing here" (RUBRIC B4): the same question
		// gets the same answer, so there is no retry on it.
		const refusal = readRefusalOf(detail.error);
		if (refusal) return <RegionRefusal className="min-h-[50dvh]" refusal={refusal} subject="this job" />;
		return (
			<RegionError
				className="min-h-[50dvh]"
				title="Couldn't load this job"
				description="Something went wrong fetching the job. Check your connection and try again."
				onRetry={() => void detail.refetch()}
			/>
		);
	}

	if (!job) {
		// The same state the route's `not-found.tsx` draws (D-25): one sentence and one way back,
		// however the address was wrong. `deploy-jobs.negative.spec` pins the sentence and the link.
		return <JobNotFoundState orgSlug={org} />;
	}

	return (
		<div className={cn("-m-4 flex flex-col sm:-m-6 lg:-m-8 xl:-m-10", JOB_VIEWPORT_HEIGHT)}>
			{/* Status header — the bar spans the frame, its contents sit in the detail column. */}
			<header className="shrink-0 border-b border-border/40 bg-muted/5 px-6 py-4">
				<div className={column}>
					<div className="flex items-start gap-3">
						{Icon && <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />}
						{/* No title: the breadcrumb resolves this job's UUID to the very same
						    `JOB_TYPES[...].label` this row used to repeat under it. What is left is the
						    job's live state and its actions, which the breadcrumb carries none of. */}
						<PageToolbar
							className="min-w-0 flex-1"
							description={
								<span className="flex flex-wrap items-center gap-x-2 gap-y-1">
									{/* Which project and environment this job ran for (#6134). Here and not
									    in the breadcrumb: a crumb is an ancestor ROUTE, and this job's route
									    is under `~`, not under the project — and the breadcrumb is hidden
									    below `md`, where this row is not. */}
									{job.project_slug && (
										<span>
											<Link
												href={`/${org}/${job.project_slug}`}
												className="text-text-primary underline-offset-4 hover:underline"
											>
												{job.project_name ?? job.project_slug}
											</Link>
											{job.environment_name && (
												<>
													{" / "}
													<Link
														href={`/${org}/${job.project_slug}/environments`}
														className="text-text-primary underline-offset-4 hover:underline"
													>
														{job.environment_name}
													</Link>
												</>
											)}
										</span>
									)}
									<StatusBadge status={jobState ?? job.status} />
									{/* The one duration wording the list uses too (`JobDuration`): a finished
									    job's is fixed, a running one's reads the clock after hydration, and a
									    job that never started says so and how long it waited (#6732). */}
									<JobDuration job={job} detail />
									<span className="font-mono">{job.id.slice(0, 8)}</span>
									{job.runner_id && (
										<span>
											· Runner <span className="font-mono">{job.runner_id.slice(0, 8)}</span>
										</span>
									)}
									{job.created_at && (
										<span>
											· <RelativeTime at={job.created_at} />
										</span>
									)}
								</span>
							}
							actions={
								// A control this reader may not use is DISABLED WITH ITS REASON (hover or
								// focus), never hidden and never left to fail (components/errors/manage-gate.ts).
								<TooltipProvider delayDuration={300}>
									{isActive && (
										<DisabledReason reason={job.can.cancel ? null : MANAGE_DENIED_REASON}>
											<Button
												variant="outline"
												size="sm"
												className="h-8 text-destructive hover:text-destructive"
												onClick={() => setConfirmCancel(true)}
												disabled={actionLoading}
											>
												{actionLoading ? (
													<Loader2 className="mr-1.5 size-3.5 animate-spin" />
												) : (
													<Ban className="mr-1.5 size-3.5" />
												)}
												Cancel
											</Button>
										</DisabledReason>
									)}
									{isPlanSuccess &&
										job.project_id &&
										(job.can.deploy ? (
											<RunnerSelectPopover
												trigger={
													<Button size="sm" className="h-8" disabled={actionLoading}>
														<Rocket className="mr-1.5 size-3.5" />
														{JOB_ACTION.deploy}
													</Button>
												}
												onConfirm={(runnerId) => apply.submit({ planJobId: job.id, runnerId })}
												disabled={actionLoading}
											/>
										) : (
											<DisabledReason reason={MANAGE_DENIED_REASON}>
												<Button size="sm" className="h-8">
													<Rocket className="mr-1.5 size-3.5" />
													{JOB_ACTION.deploy}
												</Button>
											</DisabledReason>
										))}
									{isTerminal && rerunnable && (
										<DisabledReason reason={job.can.rerun ? null : MANAGE_DENIED_REASON}>
											<Button
												variant="outline"
												size="sm"
												className="h-8"
												onClick={() => setConfirmRerun(true)}
												disabled={actionLoading}
											>
												{actionLoading ? (
													<Loader2 className="mr-1.5 size-3.5 animate-spin" />
												) : (
													<RefreshCw className="mr-1.5 size-3.5" />
												)}
												Re-run
											</Button>
										</DisabledReason>
									)}
								</TooltipProvider>
							}
						/>
					</div>

					{/* The outcome, next to the status it explains rather than below the log. A failure
					    message is bounded: an OpenTofu error can run to hundreds of lines, and letting
					    it grow here would push the log — the thing the page is for — off the screen.
					    A successful drift scan or plan states what it FOUND (#6134): `SUCCESS` only
					    says the job ran, and "21 resources drifted" is not a status. */}
					{jobState === "SUCCESS" && (
						<JobOutcome
							job={{ job_type: job.job_type, status: jobState, execution_metadata: job.execution_metadata }}
						/>
					)}
					{/* A plan somebody has asked to deploy or destroy from: the request waits on a
					    PERSON, for up to an hour, with no job to show for it. Said here so the wait
					    does not read as something stuck. */}
					{job.approval && <JobApprovalNotice approval={job.approval} org={org} />}
					{(jobState === "FAILED" || jobState === "CANCELLED") && (
						<div
							className={cn(
								"mt-3 rounded-md border px-3 py-2",
								jobState === "FAILED"
									? "border-destructive/30 bg-destructive/5"
									: "border-border bg-muted/30",
							)}
						>
							<p className="flex items-center gap-2 text-ui-md font-medium text-text-primary">
								{jobState === "FAILED" ? (
									<XCircle className="size-4 shrink-0 text-destructive" />
								) : (
									<Ban className="size-4 shrink-0 text-text-tertiary" />
								)}
								{jobState === "FAILED" ? "Job failed" : "Job cancelled"}
							</p>
							{jobError && (
								<p className="mt-1 max-h-24 overflow-y-auto break-all pl-6 text-ui-xs text-text-tertiary">
									{jobError}
								</p>
							)}
						</div>
					)}
					{/* What a deploy went on without. In any status: on a success it is the gap
					    between "the job ran" and "everything is deployed", on a failure often the cause. */}
					<DeployWarnings job={{ job_type: job.job_type, execution_metadata: job.execution_metadata }} />
				</div>
			</header>

			{/* The log — the ONE region that does not obey the detail column. See detail-column.ts. */}
			<JobLog
				logs={log.logs}
				status={jobState ?? job.status}
				active={isActive}
				createdAt={job.created_at}
				org={org}
				stream={log.state}
				onReconnect={log.reconnect}
			/>

			{/* The job's facts and its frozen payloads — back inside the detail column. */}
			<div className="max-h-[40dvh] shrink-0 overflow-y-auto border-t border-border/40 px-6">
				<div className={column}>
					<DetailSection title={DETAILS_TITLE}>
						{/* A `<dl>`, not the `grid grid-cols-2 md:grid-cols-3` of unlabelled `<p>` pairs
						    this replaces: assistive tech had no way to tell which value belonged to
						    which term, and on a narrow window the two-column wrap put them in an order
						    that did not read at all.

						    `Fact` TYPESETS EVERY VALUE IN MONO, and that is accepted here rather than
						    worked around. The grid this replaces was mixed — mono for the three ids,
						    proportional for the type and the three timestamps — and six of these seven
						    values are an identifier or a timestamp, both of which read BETTER in a
						    column that aligns. Only `Type` is prose, and one row of prose is not worth
						    either a `font-sans` override at the call site or a new prop on a component
						    #3628 is deciding the future of. */}
						<div className="overflow-hidden rounded-md border border-border">
							<FactList>
								<Fact label="Job ID" value={job.id} />
								<Fact label="Type" value={info?.label ?? job.job_type} />
								<Fact label="Runner" value={job.runner_id ?? "—"} />
								<Fact label="Created" value={<LocalDateTime at={job.created_at} />} />
								<Fact label="Started" value={<LocalDateTime at={job.started_at} />} />
								<Fact label="Completed" value={<LocalDateTime at={job.completed_at} />} />
								{job.project_id && (
									<Fact
										label="Project"
										value={job.project_name ? `${job.project_name} (${job.project_id})` : job.project_id}
									/>
								)}
							</FactList>
						</div>
					</DetailSection>

					<DetailSection title={CONFIG_TITLE}>
						<PayloadBlock value={job.config_snapshot} absent="No configuration snapshot was recorded for this job." />
					</DetailSection>

					<DetailSection title={METADATA_TITLE}>
						<PayloadBlock value={job.execution_metadata} absent="No execution metadata was recorded for this job." />
					</DetailSection>
				</div>
			</div>

			{/* Rendered OUTSIDE the `isActive` guard that gates the Cancel button. A job whose status
			    flips to terminal while the dialog is open would otherwise have its confirmation
			    unmounted mid-decision, which reads as the click having done something. Here the
			    dialog survives the transition and `cancelJob` refuses a non-cancellable status on the
			    server, so the worst case is an honest error toast rather than a vanished dialog.
			    `confirmLabel` is NOT "Cancel": the dialog's own way out is already called that, and
			    two buttons reading "Cancel" is the one confirmation that means nothing. */}
			<ConfirmAction
				open={confirmCancel}
				onOpenChange={setConfirmCancel}
				title="Cancel this job?"
				description={
					cancelStarted
						? "The job is marked cancelled and its runner is signalled to abort the run in flight. Anything already applied is not rolled back, and a cancelled job cannot be resumed — re-running it starts a new one."
						: "This job has not started — no runner has claimed it and nothing has been applied. It is marked cancelled and never runs. A cancelled job cannot be resumed — re-running it starts a new one."
				}
				confirmLabel="Cancel job"
				pendingLabel="Cancelling…"
				severity={{ level: "confirm" }}
				mutation={cancel}
				variables={{ jobId }}
			/>
			{/* Mounted on the route rather than on `isTerminal`, for the reason above. It stays open
			    while the re-run is in flight and closes when the new job exists; a refusal leaves the
			    question on screen with its sentence beside it. */}
			{rerunnable && (
				<ConfirmAction
					open={confirmRerun}
					onOpenChange={setConfirmRerun}
					title="Re-run this job?"
					description={rerunDescription(rerunnable, job)}
					confirmLabel="Re-run job"
					pendingLabel="Re-running…"
					severity={{ level: "confirm" }}
					mutation={rerun}
					variables={{ jobId }}
				/>
			)}
		</div>
	);
}
