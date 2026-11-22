"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The changeset bar (#6833): bottom-centre of the board, and always there.
//
// It answers one question at a glance — where does this design stand between "edited" and
// "running" — and offers one way forward: Review plan, which opens the review-and-deploy view.
// It never deploys: that happens in the view, in order, behind a plan.
//
//   edits pending           Pending changes [3] · 1 added · 2 edited    Discard | Review plan
//   never deployed          Not deployed yet                                      Review plan
//   saved, not deployed     Saved, not deployed                                   Review plan
//   in sync                 Up to date                                    Review plan (quiet)
//   a job is running        Deploying                                  View log | Review plan
//   the last deploy failed  Deploy failed                              View log | Review plan
//   issues in the draft     the "2 issues" button, in any of the states above
//
// The board's host draws this in its bottom-centre region. The review view is mounted from here,
// docked on the board's right edge, and the host's toolbar region gives the same `min(560px,100%)`
// back while it is open. The view gives way to the inspector: while a card is open on the rail the
// view is hidden, and it comes back when the card closes. That is what makes an issue's "Go to" a
// detour rather than a dead end.
//
// ⌘S opens the review (the `canvas.review-plan` row in `toolbar/canvas-keys.ts`). It is the chord
// people press when they are done with an edit, and the way forward from an edit is a plan.
//
// SAVE. Run plan, in the view, is what saves a design on its way to a deploy. The host's save
// (`onSave`) neither plans nor deploys; the bar keeps it as a quiet third action beside Discard,
// because a design on a project with no cloud account yet has no other way to be kept: Run plan
// would save and then be refused. It cannot reach a deploy.

import { AlertTriangle } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { Separator } from "@repo/ui/separator";
import { StatusBadge } from "@repo/ui/status-badge";
import { DiscardPrompt } from "@/components/confirm/use-unsaved-guard";
import { useByoChartCanvas } from "@/components/design-project/byo/byo-chart-canvas-context";
import { useClaimStagedOperations } from "@/components/design-project/canvas/inspector-shell/staged-operations";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import {
	useBoardActions,
	useDesignNodes,
	useOperations,
	usePendingChanges,
	useSubject,
} from "@/lib/canvas/store/use-board";
import { useShortcut } from "@/lib/shortcuts/use-shortcut";
import { barState, countOf } from "./review/changeset-status";
import { JobLink } from "./review/job-link";
import { reviewIssues } from "./review/review-issues";
import { ReviewView } from "./review/review-view";
import type { ReviewScope } from "./review/use-review";
import { SHORTCUT_CANVAS_REVIEW_PLAN } from "./toolbar/canvas-keys";

interface PendingChangesBarProps {
	/** The project the board edits. Read from the board's own context when it is not passed. */
	projectId?: string;
	/** The environment the board edits. Read from the environment status when it is not passed. */
	environmentId?: string | null;
	/** Clears the environment's staged rows on the server, after the board has reverted. */
	onDiscard?: () => void;
	/** A discard is in flight: the bar's actions wait for it. */
	discarding?: boolean;
	/** The host's save is in flight: the bar's actions wait for it. */
	saving?: boolean;
	/**
	 * Saves the design without planning or deploying it. Offered as a quiet action while there are
	 * pending changes; absent, the bar has no Save and Run plan is the only thing that saves.
	 */
	onSave?: () => void;
}

/**
 * The bar and, when it is open, the review view beside it. Rendered inside the board's positioned
 * container; it lays itself out over the board and lets every pointer event it does not own through.
 */
export function PendingChangesBar({
	projectId: givenProjectId,
	environmentId: givenEnvironmentId,
	onDiscard,
	discarding,
	onSave,
	saving,
}: PendingChangesBarProps) {
	const { discard } = useBoardActions();
	const board = useBoard();
	const env = useEnvironmentStatus();
	const host = useByoChartCanvas();
	const changes = usePendingChanges();
	const operations = useOperations();
	const designNodes = useDesignNodes();
	const subject = useSubject();
	const reviewOpen = useStore(board.view, (s) => s.review.open);
	const [askingToDiscard, setAskingToDiscard] = useState(false);
	const reviewButton = useRef<HTMLButtonElement>(null);
	// Staged operations are counted here and listed, applied and discarded in the review view, so
	// the rail does not draw a second control for them.
	useClaimStagedOperations();

	const issueCount = useMemo(() => reviewIssues(designNodes).length, [designNodes]);
	const state = barState({
		changes,
		operations,
		deployState: env.deployState,
		activeJob: env.activeJob,
		recentJobs: env.recentJobs,
	});
	const pendingCount = changes.length + operations.length;
	const busy = Boolean(discarding || saving);

	const projectId = givenProjectId ?? host?.projectId ?? null;
	const environmentId = givenEnvironmentId ?? env.environment?.id ?? host?.environmentId ?? null;
	const environmentName = env.environment?.name ?? "";
	const scope = useMemo<ReviewScope | null>(
		() => (projectId ? { projectId, environmentId, environmentName } : null),
		[projectId, environmentId, environmentName],
	);
	// The view gives way to the inspector, and returns when the inspector closes.
	const reviewVisible = reviewOpen && subject === null && scope !== null;

	const openReview = useCallback(() => {
		const view = board.view.getState();
		// One panel on the right at a time: the review takes the inspector's place.
		view.setSubject(null);
		view.openReview();
	}, [board]);

	const closeReview = useCallback(() => {
		board.view.getState().closeReview();
		reviewButton.current?.focus();
	}, [board]);

	const toggleReview = useCallback(() => {
		if (reviewVisible) closeReview();
		else openReview();
	}, [reviewVisible, closeReview, openReview]);

	// Always taken, so the browser's "save this page" never opens over the board; with no project
	// there is nothing to review and the press does nothing.
	useShortcut(SHORTCUT_CANVAS_REVIEW_PLAN, () => {
		if (scope !== null) openReview();
	});

	/** Puts the board back to the saved design, then clears what the server had staged. */
	const discardAll = () => {
		// The cards the design does not hold come from their queries and are never in the document,
		// so a discard cannot drop one; they are passed only so the view is reconciled against them.
		discard();
		onDiscard?.();
	};

	return (
		<div className="pointer-events-none absolute inset-0 z-[var(--z-raised)] flex overflow-hidden">
			<div className="relative min-w-0 flex-1">
				<div
					role="group"
					aria-label="Changes and deploy"
					data-testid={state.kind === "pending" ? "pending-changes-bar" : "changeset-bar"}
					data-state={state.kind}
					className="pointer-events-auto absolute bottom-4 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-none border border-border bg-card/95 p-1 shadow-[0_2px_10px_rgba(0,0,0,0.10)] backdrop-blur"
				>
					{/* The state is the live region itself: a change of state is announced once, in the
					    words that are on screen, with no hidden copy to read a second time. */}
					<div
						role="status"
						aria-live="polite"
						className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-sm"
					>
						<StatusBadge
							status={state.kind}
							tier={state.tier}
							showLabel={false}
							aria-hidden
							className="shrink-0"
						/>
						<span className="whitespace-nowrap font-medium">{state.label}</span>
						{state.kind === "pending" && (
							<span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 font-mono text-ui-2xs tabular-nums text-background">
								{pendingCount}
							</span>
						)}
						{state.detail && (
							<span className="hidden truncate text-ui-sm text-muted-foreground sm:inline">
								{state.detail}
							</span>
						)}
					</div>

					<Separator orientation="vertical" className="h-5" />

					{issueCount > 0 && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-8 text-xs"
							aria-label={`${countOf(issueCount, "issue")} in the design. Open the review to see ${issueCount === 1 ? "it" : "them"}.`}
							disabled={scope === null}
							onClick={openReview}
						>
							<AlertTriangle aria-hidden className="size-3.5" />
							{countOf(issueCount, "issue")}
						</Button>
					)}

					{state.kind === "pending" && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-8 text-xs"
							aria-busy={Boolean(discarding)}
							disabled={busy}
							onClick={() => setAskingToDiscard(true)}
						>
							Discard
						</Button>
					)}

					{state.kind === "pending" && onSave && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-8 text-xs"
							title="Save the design without planning or deploying it"
							aria-busy={Boolean(saving)}
							disabled={busy}
							onClick={onSave}
						>
							{saving ? "Saving…" : "Save"}
						</Button>
					)}

					{state.jobId && (state.kind === "running" || state.kind === "failed") && (
						<JobLink jobId={state.jobId} variant="ghost" className="h-8 text-xs">
							View log
						</JobLink>
					)}

					<DisabledReason
						reason={
							scope === null
								? "This board is not attached to a project, so there is nothing to plan."
								: null
						}
					>
						<Button
							ref={reviewButton}
							type="button"
							size="sm"
							variant={state.reviewIsPrimary ? "default" : "ghost"}
							className="h-8 text-xs"
							aria-expanded={reviewVisible}
							disabled={busy}
							onClick={toggleReview}
						>
							Review plan
						</Button>
					</DisabledReason>
				</div>
			</div>

			{reviewVisible && scope && <ReviewView scope={scope} onClose={closeReview} />}

			<DiscardPrompt
				open={askingToDiscard}
				onKeep={() => setAskingToDiscard(false)}
				onDiscard={() => {
					setAskingToDiscard(false);
					discardAll();
				}}
				title="Discard staged changes?"
				description={`This puts the board back to the saved design and drops ${countOf(pendingCount, "pending change")}. It cannot be undone.`}
				confirmLabel="Discard"
			/>
		</div>
	);
}
