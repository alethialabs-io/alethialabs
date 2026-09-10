"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@repo/ui/status-badge";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { ago, JOB_LABEL, JOB_STATUS } from "@/lib/canvas/job-display";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/**
 * One line, top-left of the board: the job running now, else the last one — "Deploy · Running ·
 * 2m" — that opens the Activity card. It reads the environment status the shell already polls,
 * so it costs no query of its own, and it renders nothing until something has run.
 *
 * This is what remains of the floating activity list: the one fact worth having over the board
 * (is something running, did the last thing fail), with the history one click away on the rail.
 */
export function ActivityStatusLine() {
	const env = useEnvironmentStatus();
	const openCard = useCanvasStore((s) => s.openCard);

	const active = env.activeJob;
	const last = env.recentJobs[0];
	if (!active && !last) return null;

	// The in-flight job carries no timestamp (it is a live fact, not a row); the last settled one does.
	const job = active ?? last;
	if (!job) return null;
	const status = job.status;
	const createdAt = active ? null : last ? last.createdAt : null;
	// `live` blinks; a settled job takes its status's resting tier.
	const vx = active ? "live" : (JOB_STATUS[status] ?? "idle");
	// "Running" is the WORD for an in-flight job — its row status is QUEUED/CLAIMED/PROCESSING,
	// none of which is what a person means when they ask whether something is running.
	const word = active ? "Running" : status.charAt(0) + status.slice(1).toLowerCase();

	return (
		<button
			type="button"
			onClick={() => openCard({ kind: "activity" })}
			// The visible text is the job, so it is the accessible name unless one is given —
			// "DEPLOY · Running · 2m" says what it shows, never what pressing it does.
			aria-label="Open the activity log"
			title="Open the activity log"
			className="absolute left-3 top-3 z-10 flex h-8 items-center gap-2 border border-border bg-card px-2.5 font-mono text-ui-2xs uppercase tracking-wide transition-colors hover:bg-muted"
		>
			<StatusBadge status={status} tier={vx} showLabel={false} className="shrink-0" />
			<span className="truncate">{JOB_LABEL[job.type] ?? job.type}</span>
			<span className="text-muted-foreground">·</span>
			<span className="text-muted-foreground">{word}</span>
			{createdAt && (
				<>
					<span className="text-muted-foreground">·</span>
					<span className="text-muted-foreground">{ago(createdAt)}</span>
				</>
			)}
		</button>
	);
}
