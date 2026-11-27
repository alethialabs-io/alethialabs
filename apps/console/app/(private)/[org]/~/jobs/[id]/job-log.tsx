"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MARK_LOADER_PX } from "@repo/brand/loader";
import { formatDate, formatDuration, formatMinutes } from "@repo/format";
import { Button } from "@repo/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyState, EmptyTitle } from "@repo/ui/empty";
import { MarkGlyph } from "@repo/ui/spinner";
import { StatusBadge } from "@repo/ui/status-badge";
import { useHydrated } from "@repo/ui/use-hydrated";
import { cn } from "@repo/ui/utils";
import { ArrowDown, Clock, Terminal } from "lucide-react";
import Link from "next/link";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useSecondsClock } from "@/components/jobs/columns";
import type { EventStreamState } from "@/hooks/use-event-stream";
import type { JobLogEntry } from "@/hooks/use-job-log-stream";
import { globalHref } from "@/lib/routing";

import { JOB_LOG_STRIP } from "./detail-column";

/** How many lines the pane draws at first, and how many more "Show earlier lines" adds. */
export const LOG_WINDOW = 2_000;

/** How many lines one memoised block of the log holds. */
const LOG_BLOCK = 100;

/** How close to the end, in pixels, still counts as reading the end. */
const AT_END_SLACK = 32;

/** How long a job may sit queued before the pane says so and points at the runners. */
export const RUNNER_WAIT_NOTICE_MS = 2 * 60_000;

/** One block of consecutive log lines; `firstNumber` is the line number of its first line. */
interface LogBlockProps {
	lines: readonly JobLogEntry[];
	firstNumber: number;
	/** The browser's timezone is known: timestamps can be printed. */
	hydrated: boolean;
}

/**
 * A block of log lines. Memoised on what its lines ARE — the first and last id and the count — not
 * on the array handed in, which is a fresh slice every render. A log line never changes once
 * written, so a block whose ends and length are the same is the same block, and a new line
 * re-renders only the block it lands in.
 */
const LogBlock = memo(
	function LogBlock({ lines, firstNumber, hydrated }: LogBlockProps) {
		return (
			<>
				{lines.map((log, i) => (
					<div key={log.id} className="group flex gap-4 rounded px-2 py-0.5 transition-colors hover:bg-muted/40">
						<span className="w-12 shrink-0 select-none text-right text-text-tertiary">{firstNumber + i}</span>
						<span className="w-[85px] shrink-0 select-none text-text-tertiary">
							{/* The browser's timezone, so after hydration only; the span holds the width. */}
							{hydrated ? formatDate(log.created_at, "time") : null}
						</span>
						<span
							className={cn(
								"break-all leading-relaxed",
								log.stream_type === "STDERR" || log.stream_type === "stderr"
									? "text-destructive"
									: "text-muted-foreground",
							)}
						>
							{log.log_chunk}
						</span>
					</div>
				))}
			</>
		);
	},
	(prev, next) =>
		prev.hydrated === next.hydrated &&
		prev.firstNumber === next.firstNumber &&
		prev.lines.length === next.lines.length &&
		prev.lines[0]?.id === next.lines[0]?.id &&
		prev.lines.at(-1)?.id === next.lines.at(-1)?.id,
);

/** A job that has been queued long enough to say so: how long, and where the runners are. */
function QueuedWait({ createdAt, org }: { createdAt: string | Date | null; org: string }) {
	const now = useSecondsClock();
	const waited = now === null || createdAt === null ? 0 : now - new Date(createdAt).getTime();
	if (waited < RUNNER_WAIT_NOTICE_MS) {
		return (
			<EmptyState
				className="min-h-[40dvh] font-sans"
				icon={<Clock />}
				title="Waiting for a runner"
				description="This job is queued. A runner claims it when one is free, and its output appears here."
			/>
		);
	}
	return (
		<EmptyState
			className="min-h-[40dvh] font-sans"
			data-state="runner-wait"
			icon={<Clock />}
			title="Still waiting for a runner"
			description={`No runner has claimed this job in ${formatMinutes(waited / 60_000)}. It stays queued until one does: check that a runner is online and able to take it.`}
			action={
				<Button variant="outline" size="sm" nativeButton={false} render={<Link href={globalHref(org, "runners")} />}>
					View runners
				</Button>
			}
		/>
	);
}

/**
 * A job a runner holds that has printed nothing yet: the region-sized `[·]` mark over what is
 * happening, with a mono line of facts the page already has — the job's short id and how long ago
 * it was queued. Never a percentage: nothing here knows how far along the run is.
 *
 * The mark is DECORATIVE here, not a `MarkLoader`: the strip above the pane is the log's one
 * `role="status"` region and already announces where the stream stands, so a second live region
 * would make a screen reader hear the wait twice — and its elapsed line would be re-announced every
 * second. The title and sentence below the mark are ordinary text.
 */
function LogWaiting({
	title,
	description,
	jobId,
	createdAt,
}: {
	title: string;
	description: string;
	jobId: string | undefined;
	createdAt: string | Date | null;
}) {
	const now = useSecondsClock();
	const queuedAgo = now === null || createdAt === null ? null : now - new Date(createdAt).getTime();
	const facts = [jobId ? jobId.slice(0, 8) : null, queuedAgo === null ? null : `queued ${formatDuration(queuedAgo)} ago`]
		.filter((fact): fact is string => fact !== null)
		.join(" · ");
	return (
		<Empty className="min-h-[40dvh] font-sans" data-state="log-waiting">
			<EmptyHeader>
				<EmptyMedia>
					<MarkGlyph
						width={MARK_LOADER_PX.region}
						height={MARK_LOADER_PX.region}
						className="text-text-tertiary"
						aria-hidden="true"
					/>
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
			{facts ? (
				<p className="font-mono text-ui-xs tabular-nums text-text-tertiary" data-slot="log-waiting-facts">
					{facts}
				</p>
			) : null}
		</Empty>
	);
}

/**
 * What the pane says while a job has written nothing. One sentence per status, because they are
 * different situations: queued is a wait for a runner (and, past a threshold, a pointer at the
 * runners); claimed and running are a job that HAS a runner and has not printed yet. Saying
 * "waiting for a runner" over a job a runner is already running sent readers to look for a problem
 * that was not there.
 */
function LogEmpty({
	status,
	createdAt,
	org,
	jobId,
}: {
	status: string;
	createdAt: string | Date | null;
	org: string;
	jobId: string | undefined;
}) {
	if (status === "QUEUED") return <QueuedWait createdAt={createdAt} org={org} />;
	if (status === "CLAIMED") {
		return (
			<LogWaiting
				title="A runner has claimed this job"
				description="It is preparing the run. Output appears here when it starts."
				jobId={jobId}
				createdAt={createdAt}
			/>
		);
	}
	if (status === "PROCESSING") {
		return (
			<LogWaiting
				title="Running — no output yet"
				description="The job has started. Its output appears here as the runner writes it."
				jobId={jobId}
				createdAt={createdAt}
			/>
		);
	}
	return <EmptyState className="min-h-[40dvh] font-sans" icon={<Terminal />} title="No logs recorded for this job." />;
}

/**
 * The strip above the log: how many lines there are, and where the stream stands.
 *
 * - connecting — a request is out, or the next automatic attempt is scheduled;
 * - open — lines arrive as they are written ("Live"), or the rest of a finished job's log is on
 *   its way;
 * - closed — nothing more will arrive until the reader asks: the one state with a button;
 * - signed-out — nothing here: the shell shows the session's end (lib/stores/use-session-state.ts);
 * - no stream — the log is complete, and the strip only counts it.
 *
 * It is ALWAYS drawn, at one height (`JOB_LOG_STRIP`, shared with the skeleton), so the log under
 * it does not move when a stream opens, drops or ends.
 */
function LogStrip({
	count,
	active,
	state,
	onReconnect,
}: {
	count: number;
	active: boolean;
	state: EventStreamState | null;
	onReconnect: () => void;
}) {
	return (
		<div className={cn(JOB_LOG_STRIP, "font-sans text-ui-sm text-text-tertiary")} data-slot="job-log-strip">
			<span className="tabular-nums">{count === 1 ? "1 line" : `${count} lines`}</span>
			{/* Polite: a reader following the log is told when it stops being live, without the
			    page interrupting them. */}
			<span role="status" className="flex items-center gap-2" data-stream={state ?? "none"}>
				{state === "connecting" && (active ? "Connecting to the live log…" : "Loading the rest of the log…")}
				{state === "open" &&
					(active ? <StatusBadge status="live" tier="live" label="Live" /> : "Loading the rest of the log…")}
				{state === "closed" && (
					<>
						<span className="text-text-primary">
							{active ? "Live log disconnected" : "The rest of this log didn't load"}
						</span>
						<Button variant="outline" size="sm" className="h-6 px-2 text-ui-sm" onClick={onReconnect}>
							{active ? "Reconnect" : "Retry"}
						</Button>
					</>
				)}
			</span>
		</div>
	);
}

/** What the log pane is given. */
export interface JobLogProps {
	logs: readonly JobLogEntry[];
	/** The job's status, for the wording while it has written nothing. */
	status: string;
	/** Whether the job is still queued or running. */
	active: boolean;
	createdAt: string | Date | null;
	org: string;
	/** The job's id, for the facts line under the wait while it has printed nothing. */
	jobId?: string;
	/** The log stream's state; null when there is none (`useJobLogStream`). */
	stream: EventStreamState | null;
	onReconnect: () => void;
}

/**
 * The job's log: the ONE region of the job view that does not obey the detail column (see
 * detail-column.ts).
 *
 * IT FOLLOWS THE END ONLY WHILE THE READER IS AT THE END. A running deploy prints for minutes;
 * scrolling to the bottom on every line made it impossible to read an error further up while the
 * job was still going. The pane keeps to the end while the reader is there, stops the moment they
 * scroll away, and offers "Jump to latest" to go back.
 *
 * IT DRAWS A WINDOW, NOT THE WHOLE LOG. At most {@link LOG_WINDOW} lines are in the document at
 * first — the newest, since the end is where a run's outcome is — with "Show earlier lines" above
 * them, in blocks that re-render only when their own lines change. While the reader follows the
 * end the window slides with it; once they scroll away its first line is PINNED, so new output
 * extends the bottom and never pulls the lines they are reading out from under them. Line numbers
 * are the line's place in the whole log, whatever the window.
 */
export function JobLog({ logs, status, active, createdAt, org, jobId, stream, onReconnect }: JobLogProps) {
	const hydrated = useHydrated();
	const scroller = useRef<HTMLDivElement>(null);
	const [following, setFollowing] = useState(true);
	// The first line drawn while the reader is away from the end (or asked for earlier lines);
	// null while the window slides with the end.
	const [pinned, setPinned] = useState<number | null>(null);
	// The height the content had before earlier lines were added above it, so the lines the reader
	// was looking at can be put back where they were. Written by the click, used by the effect.
	const heightBefore = useRef<number | null>(null);

	const sliding = Math.max(0, logs.length - LOG_WINDOW);
	const first = pinned !== null ? Math.min(pinned, sliding) : sliding;

	useLayoutEffect(() => {
		const el = scroller.current;
		if (el === null) return;
		if (heightBefore.current !== null) {
			// Earlier lines were added above: keep the reader's place.
			el.scrollTop += el.scrollHeight - heightBefore.current;
			heightBefore.current = null;
			return;
		}
		if (following) el.scrollTop = el.scrollHeight;
	}, [logs.length, first, following]);

	/** Whether the pane is scrolled to (within a few pixels of) its end. */
	const atEnd = (el: HTMLDivElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_SLACK;

	/** The reader scrolled: follow the end exactly while they are at it. */
	const onScroll = (): void => {
		const el = scroller.current;
		if (el === null) return;
		const end = atEnd(el);
		if (end === following) return;
		setFollowing(end);
		// Leaving the end pins the window where it is; coming back lets it slide again.
		setPinned(end ? null : first);
	};

	/** Back to the newest line, and following again. */
	const jumpToLatest = (): void => {
		setFollowing(true);
		setPinned(null);
	};

	/** Draws one more window of lines above the first one drawn. */
	const showEarlier = (): void => {
		heightBefore.current = scroller.current?.scrollHeight ?? null;
		setFollowing(false);
		setPinned(Math.max(0, first - LOG_WINDOW));
	};

	// Blocks are cut at fixed places in the WHOLE log, so a block keeps its lines as the window
	// slides and its memo holds.
	const blocks: { start: number; end: number }[] = [];
	for (let start = first - (first % LOG_BLOCK); start < logs.length; start += LOG_BLOCK) {
		blocks.push({ start: Math.max(start, first), end: Math.min(start + LOG_BLOCK, logs.length) });
	}

	return (
		<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/20" data-slot="job-log">
			<LogStrip count={logs.length} active={active} state={stream} onReconnect={onReconnect} />
			{/* A plain scroller, focusable so the keyboard can scroll it, named for what it is. */}
			<div
				ref={scroller}
				onScroll={onScroll}
				tabIndex={0}
				role="region"
				aria-label="Job log"
				className="min-h-0 flex-1 overflow-y-auto p-6 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
			>
				{logs.length === 0 ? (
					<LogEmpty status={status} createdAt={createdAt} org={org} jobId={jobId} />
				) : (
					<div className="pb-10">
						{first > 0 && (
							<div className="mb-2 flex items-center gap-3 px-2 font-sans text-ui-sm text-text-tertiary">
								<Button variant="outline" size="sm" className="h-6 px-2 text-ui-sm" onClick={showEarlier}>
									Show earlier lines
								</Button>
								<span className="tabular-nums">
									{first === 1 ? "1 earlier line is not drawn" : `${first} earlier lines are not drawn`}
								</span>
							</div>
						)}
						{blocks.map((block) => (
							<LogBlock
								key={block.start - (block.start % LOG_BLOCK)}
								lines={logs.slice(block.start, block.end)}
								firstNumber={block.start + 1}
								hydrated={hydrated}
							/>
						))}
						{active && (
							<div className="mt-2 flex gap-4 px-2" aria-hidden>
								<span className="w-12" />
								<span className="w-[85px]" />
								<span className="block h-4 w-2 animate-pulse bg-muted-foreground/30" />
							</div>
						)}
					</div>
				)}
			</div>
			{!following && logs.length > 0 && (
				<Button
					variant="outline"
					size="sm"
					className="absolute bottom-4 right-6 z-[var(--z-raised)] bg-background font-sans shadow-sm"
					onClick={jumpToLatest}
				>
					<ArrowDown className="mr-1.5 size-3.5" aria-hidden />
					Jump to latest
				</Button>
			)}
		</div>
	);
}
