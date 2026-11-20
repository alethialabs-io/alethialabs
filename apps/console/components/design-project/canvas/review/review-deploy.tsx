"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { StatusBadge } from "@repo/ui/status-badge";
import { useState } from "react";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import {
	countOf,
	DEPLOY_WAITING_EXPLANATION,
	destructiveCount,
	isJobWaiting,
	planCountsSentence,
	type DeployBlock,
} from "./changeset-status";
import { JobLink } from "./job-link";
import type { ReviewController } from "./use-review";

/** How many destroyed resources the confirmation names before it counts the rest. */
const NAMED_IN_CONFIRMATION = 6;

/**
 * Step three of the review: Deploy.
 *
 * The button is enabled only while the controller hands over a commit for the reviewed plan, which
 * it does only when the store's gate allows one. While it is disabled, the reason is on screen as a
 * sentence, beside the one action that removes it — never a dead button.
 *
 * A deploy that has been queued and not started is shown as waiting, with where to look. A plan
 * that destroys or replaces resources is deployed only after the environment's name is typed.
 */
export function ReviewDeployStep({
	review,
	environmentName,
	onShowIssues,
	onShowChanges,
}: {
	review: ReviewController;
	environmentName: string;
	/** Bring the issues list into view. */
	onShowIssues: () => void;
	/** Bring the changes list into view. */
	onShowChanges: () => void;
}) {
	const env = useEnvironmentStatus();
	const [confirming, setConfirming] = useState(false);
	const blocked = review.deployBlocked;
	const destroys = destructiveCount(review.server?.summary ?? null);
	const deployJob = env.activeJob?.type === "DEPLOY" ? env.activeJob : null;

	/** Deploys, or asks first when the plan destroys something. */
	const onDeploy = () => {
		if (!review.commitInput) return;
		if (destroys > 0) {
			review.clearDeployRefusal();
			setConfirming(true);
			return;
		}
		review.deploy();
	};

	const destroyed =
		review.resources.state === "ready"
			? review.resources.resources.filter((r) => r.action === "delete" || r.action === "replace")
			: [];
	const consequences = [
		...destroyed
			.slice(0, NAMED_IN_CONFIRMATION)
			.map((r) => `${r.action === "delete" ? "Destroys" : "Replaces"} ${r.displayName} (${r.address})`),
		...(destroyed.length > NAMED_IN_CONFIRMATION
			? [`and ${countOf(destroyed.length - NAMED_IN_CONFIRMATION, "more resource")}`]
			: []),
		...(destroyed.length === 0
			? [`Destroys or replaces ${countOf(destroys, "resource")}. The plan log lists them.`]
			: []),
	];

	return (
		<div className="space-y-3">
			{deployJob && (
				<div className="flex items-start gap-2.5" data-testid="deploy-in-flight">
					<span className="mt-0.5 shrink-0">
						{isJobWaiting(deployJob.status) ? (
							<StatusBadge status="queued" label="Waiting to start" />
						) : (
							<StatusBadge status="deploying" tier="live" label="Deploying" />
						)}
					</span>
					<div className="min-w-0 flex-1 space-y-1.5">
						<p className="text-ui-md">
							{isJobWaiting(deployJob.status)
								? `The deploy is queued and has not started. ${DEPLOY_WAITING_EXPLANATION}`
								: "The deploy is running. Its log shows each step as it happens."}
						</p>
						<JobLink jobId={deployJob.id}>
							{isJobWaiting(deployJob.status) ? "Open the job" : "View log"}
						</JobLink>
					</div>
				</div>
			)}

			{review.deployRefusal && (
				<Alert variant="destructive">
					<AlertDescription>The deploy was not queued. {review.deployRefusal}</AlertDescription>
				</Alert>
			)}

			{!deployJob && (
				<p className="text-ui-md" data-testid="deploy-reason" data-block={blocked?.code ?? "ready"}>
					{blocked
						? blocked.reason
						: review.server?.summary
							? `Ready. Deploy applies the plan you reviewed: ${planCountsSentence(review.server.summary)}.`
							: "Ready. Deploy applies the plan you reviewed."}
					{!blocked && destroys > 0
						? ` It destroys or replaces ${countOf(destroys, "resource")}, so you will be asked to confirm.`
						: null}
				</p>
			)}

			<div className="flex flex-wrap items-center justify-end gap-2">
				{blocked && !deployJob && (
					<BlockFixAction
						blocked={blocked}
						review={review}
						onShowIssues={onShowIssues}
						onShowChanges={onShowChanges}
					/>
				)}
				<DisabledReason
					reason={
						blocked
							? blocked.reason
							: review.commitInput
								? null
								: "There is no reviewed plan to deploy."
					}
				>
					<Button
						type="button"
						size="sm"
						variant={blocked ? "outline" : "default"}
						aria-busy={review.deployPending}
						disabled={review.deployPending}
						onClick={onDeploy}
					>
						{review.deployPending ? "Queueing deploy…" : review.deployLabel}
					</Button>
				</DisabledReason>
			</div>

			<ConfirmAction
				// A refused deploy closes the question: the reason is shown above, in the view.
				open={confirming && review.deployRefusal === null && review.commitInput !== null}
				onOpenChange={setConfirming}
				title="Deploy a plan that destroys resources?"
				description={`This plan destroys or replaces ${countOf(destroys, "resource")} in ${environmentName}. What is destroyed cannot be brought back.`}
				confirmLabel={review.deployLabel}
				pendingLabel="Queueing deploy…"
				severity={{ level: "destroy", subject: environmentName || "deploy", consequences }}
				mutation={review.commit}
				variables={review.commitInput}
			/>
		</div>
	);
}

/** The one action that removes the reason Deploy is disabled. Nothing when the person can only wait. */
function BlockFixAction({
	blocked,
	review,
	onShowIssues,
	onShowChanges,
}: {
	blocked: DeployBlock;
	review: ReviewController;
	onShowIssues: () => void;
	onShowChanges: () => void;
}) {
	switch (blocked.fix) {
		case "run-plan":
			return (
				<DisabledReason reason={review.planBlocked?.reason}>
					<Button
						type="button"
						size="sm"
						aria-busy={review.planPending}
						disabled={review.planPending}
						onClick={review.runPlan}
					>
						{review.planPending ? "Saving and queueing…" : "Run plan"}
					</Button>
				</DisabledReason>
			);
		case "use-plan":
			return (
				<Button type="button" size="sm" onClick={review.acceptPlan}>
					Use this plan
				</Button>
			);
		case "view-job":
			return blocked.jobId ? <JobLink jobId={blocked.jobId}>View log</JobLink> : null;
		case "show-issues":
			return (
				<Button type="button" size="sm" onClick={onShowIssues}>
					Show issues
				</Button>
			);
		case "show-changes":
			return (
				<Button type="button" size="sm" onClick={onShowChanges}>
					Show changes
				</Button>
			);
		case "retry-read":
			return (
				<Button type="button" size="sm" onClick={review.retryRead}>
					Try again
				</Button>
			);
		case null:
			return null;
	}
}
