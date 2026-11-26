"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The review-and-deploy view (#6833): the one place a changed design becomes a running one.
//
// It reads top to bottom in the order the work happens, and the order is the point:
//
//   (issues, when there are any — nothing below can start until they are fixed)
//   1  Design changes   what the draft changes, from the board's own diff
//   2  Plan             Run plan saves the design, then shows what would change in the cloud
//   3  Deploy           applies exactly the plan above, and says why when it cannot
//
// Step three stays in view at the foot while the first two scroll, so the reason Deploy is
// disabled is never off screen.
//
// The view is a region docked on the board's right edge, not a dialog: the board stays live beside
// it, and a change made there shows up in step one at once.

import { X } from "lucide-react";
import {
	useCallback,
	useEffect,
	useRef,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
} from "react";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { forgetSecrets } from "@/components/design-project/canvas/inspector-shell/staged-operations";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import type { FieldChange } from "@/lib/canvas/store/types";
import { planCountsSentence } from "./changeset-status";
import { revertChange } from "./revert-change";
import { ReviewChanges } from "./review-changes";
import { ReviewDeployStep } from "./review-deploy";
import type { ReviewIssue } from "./review-issues";
import { ReviewPlanStep } from "./review-plan";
import { useReview, type ReviewController, type ReviewScope } from "./use-review";

/** Scrolls a section into view and moves focus to it. */
function reveal(section: HTMLElement | null): void {
	if (!section) return;
	// Not every environment implements it (a test's DOM does not); focus alone still lands.
	if (typeof section.scrollIntoView === "function") section.scrollIntoView({ block: "start" });
	section.focus();
}

/** What a screen reader is told when the review's state moves. */
function announcement(review: ReviewController): string {
	if (review.deployPending) return "Queueing the deploy.";
	if (review.planPending) return "Saving the design and queueing a plan.";
	switch (review.phase) {
		case "waiting":
			return "The plan is queued.";
		case "running":
			return "The plan is running.";
		case "failed":
			return "The plan failed.";
		case "current":
			return review.server?.summary
				? `Plan complete: ${planCountsSentence(review.server.summary)}.`
				: "Plan complete.";
		default:
			return "";
	}
}

/** A numbered step of the review: its heading and its body. */
function Step({
	number,
	title,
	children,
	ref,
}: {
	number: number;
	title: string;
	children: ReactNode;
	ref?: Ref<HTMLElement>;
}) {
	return (
		<section
			ref={ref}
			tabIndex={-1}
			aria-label={`Step ${number}: ${title}`}
			className="space-y-3 outline-none"
		>
			<SectionHeading
				level={3}
				title={
					<>
						<span aria-hidden className="mr-2 font-mono text-ui-sm text-muted-foreground">
							{number}
						</span>
						{title}
					</>
				}
			/>
			{children}
		</section>
	);
}

/** The issues list: every reason the design cannot be saved, each with the way to it. */
function Issues({
	issues,
	onGoTo,
	ref,
}: {
	issues: readonly ReviewIssue[];
	onGoTo: (issue: ReviewIssue) => void;
	ref: Ref<HTMLElement>;
}) {
	return (
		<section
			ref={ref}
			tabIndex={-1}
			aria-label="Issues to fix before planning"
			className="space-y-3 outline-none"
			data-testid="review-issues"
		>
			<SectionHeading
				level={3}
				title="Fix before planning"
				description="The design cannot be saved until these are fixed, and a plan saves it first."
			/>
			<ul className="space-y-1">
				{issues.map((issue) => (
					<li
						key={issue.key}
						className="flex items-start gap-2 border border-border bg-surface-sunken px-2.5 py-2"
					>
						<span className="min-w-0 flex-1 text-ui-md">
							<span className="font-medium">{issue.subject}</span>
							{issue.field ? <span className="text-muted-foreground"> · {issue.field}</span> : null}
							<span className="block text-ui-sm text-muted-foreground">{issue.message}</span>
						</span>
						{issue.nodeId && (
							<Button
								type="button"
								variant="outline"
								size="xs"
								aria-label={`Go to ${issue.subject}${issue.field ? `, ${issue.field}` : ""}`}
								onClick={() => onGoTo(issue)}
							>
								Go to
							</Button>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * The review-and-deploy view for one environment. `onClose` closes it; Escape inside it does the
 * same. Focus moves into it when it opens, and its caller returns focus when it closes.
 */
export function ReviewView({ scope, onClose }: { scope: ReviewScope; onClose: () => void }) {
	const board = useBoard();
	const review = useReview(scope);
	const root = useRef<HTMLElement>(null);
	const issuesRef = useRef<HTMLElement>(null);
	const changesRef = useRef<HTMLElement>(null);

	// Opening the view puts the keyboard in it: what is read next is its name and first step.
	useEffect(() => {
		root.current?.focus();
	}, []);

	/** Escape closes the view, unless it belongs to a dialog opened from inside it. */
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		if (
			event.target instanceof Element &&
			event.target.closest('[role="dialog"],[role="alertdialog"],[role="menu"]')
		) {
			return;
		}
		event.stopPropagation();
		onClose();
	};

	/** Opens the inspector on the card an issue is about, with its field in focus. */
	const goTo = useCallback(
		(issue: ReviewIssue) => {
			if (!issue.nodeId) return;
			const view = board.view.getState();
			if (issue.fieldPath) view.focusField(issue.nodeId, issue.fieldPath);
			else view.setSubject({ kind: "node", id: issue.nodeId }, "configure");
		},
		[board],
	);

	const revert = useCallback((change: FieldChange) => revertChange(board, change), [board]);
	const unstage = useCallback(
		(operationId: string) => {
			board.document.getState().unstageOperation(operationId);
			// What was typed into the operation's secret fields goes with it.
			forgetSecrets(operationId);
		},
		[board],
	);

	return (
		<section
			ref={root}
			tabIndex={-1}
			aria-label="Review and deploy"
			data-testid="review-view"
			data-phase={review.phase}
			onKeyDown={onKeyDown}
			className="pointer-events-auto flex h-full w-full max-w-[560px] shrink-0 flex-col border-l border-border bg-card outline-none"
		>
			<div className="border-b border-border px-4 py-3">
				<SectionHeading
					title="Review and deploy"
					description={`${scope.environmentName || "This environment"}: check what changed, run the plan, then deploy it.`}
					actions={
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Close review"
							onClick={onClose}
						>
							<X aria-hidden className="size-4" />
						</Button>
					}
				/>
			</div>

			<p role="status" aria-live="polite" className="sr-only">
				{announcement(review)}
			</p>

			<div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4">
				{review.issues.length > 0 && (
					<Issues issues={review.issues} onGoTo={goTo} ref={issuesRef} />
				)}
				<Step
					number={1}
					title="Design changes"
					ref={changesRef}
				>
					<ReviewChanges
						fieldChanges={review.fieldChanges}
						operations={review.operations}
						saved={review.saved}
						onRevert={revert}
						onUnstage={unstage}
						operationsRefusal={review.operationsRefusal}
					/>
				</Step>
				<Step number={2} title="Plan">
					<ReviewPlanStep review={review} />
				</Step>
			</div>

			<div className="border-t border-border px-4 py-3">
				<Step number={3} title={review.deployLabel}>
					<ReviewDeployStep
						review={review}
						environmentName={scope.environmentName}
						onShowIssues={() => reveal(issuesRef.current)}
						onShowChanges={() => reveal(changesRef.current)}
					/>
				</Step>
			</div>
		</section>
	);
}
