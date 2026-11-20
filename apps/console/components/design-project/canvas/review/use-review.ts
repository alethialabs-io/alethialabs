"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The review view's logic (#6833): what it reads, the two things it can do, and whether each may
// be done right now.
//
// READS. The draft and its pending changes come from the board's hooks. The environment's latest
// plan is `canvas.reviewPlan`; the plan's resource list and a failed plan's message are
// `jobs.planResult` for that plan job. Both are queries: nothing is copied into a store, and a job
// that starts or finishes re-reads them through the change stream (`lib/query/topics.ts`).
//
// RUN PLAN goes through the changeset sink, which saves the draft and then queues a plan of it.
// When the sink answers, the draft IS the saved design, so the baseline is committed and the plan
// is recorded as the one this review is about. If the draft moved while the save was in flight,
// neither happens: the baseline and the record would both describe a design that was not saved.
//
// DEPLOY is offered through one door: `usePlanReview(serverCurrent).gate`. `serverCurrent` is true
// only when the server calls its latest plan current AND that plan is the one recorded here, so
// neither the board's record nor the server's answer is enough on its own. `deployBlock` then adds
// the reasons the gate does not know (the cloud is not offered, a job is in flight), and can only
// refuse.

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { track } from "@/lib/analytics/track";
import type { ReviewPlan } from "@/lib/canvas/component-status";
import { useEnvironmentStatus } from "@/lib/canvas/environment-status-context";
import { useBoard } from "@/lib/canvas/store/canvas-store-provider";
import {
	changesetEdits,
	useChangesetSink,
	type ChangesetInput,
	type CommitInput,
} from "@/lib/canvas/store/changeset-sink";
import { diffFields, diffNodes, draftRevision } from "@/lib/canvas/store/derive";
import {
	useDesignNodes,
	useFieldChanges,
	useOperations,
	usePendingChanges,
	usePlanReview,
} from "@/lib/canvas/store/use-board";
import type { FieldChange, PendingChange, StagedOperation } from "@/lib/canvas/store/types";
import { parsePlanJSON, type PlanResource } from "@/lib/plan/parse-plan";
import { environmentStatusInput } from "@/lib/query/use-environment-status-query";
import { orpc } from "@/lib/rpc/client";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import {
	deployBlock,
	planBlock,
	planPhase,
	serverCurrentFor,
	type DeployBlock,
	type PlanPhase,
} from "./changeset-status";
import { reviewIssues, type ReviewIssue } from "./review-issues";

/** The environment a review is of. */
export interface ReviewScope {
	projectId: string;
	/** Null means the project's default environment, which the server resolves. */
	environmentId: string | null;
	/** The environment's name, as the design file names it. */
	environmentName: string;
}

/** The plan's resource list, read from the plan job. */
export type PlanResources =
	| { state: "idle" }
	| { state: "loading" }
	| { state: "error" }
	| { state: "ready"; resources: PlanResource[] };

/** Everything the review view draws and does. */
export interface ReviewController {
	issues: ReviewIssue[];
	changes: PendingChange[];
	fieldChanges: FieldChange[];
	operations: StagedOperation[];
	/** The changes the last Run plan saved, still listed after they stop being pending. */
	saved: PendingChange[];

	/** The server's latest plan; undefined until the read answers. */
	server: ReviewPlan | undefined;
	phase: PlanPhase;
	resources: PlanResources;
	/** The first line of a failed plan's message; null when there is none to show. */
	planError: string | null;
	/** Re-reads the latest plan (after a failed read). */
	retryRead: () => void;

	/** Why Run plan is disabled; null when it may be pressed. */
	planBlocked: { reason: string; jobId: string | null } | null;
	planPending: boolean;
	/** The sentence a refused Run plan answered with; null when the last one was not refused. */
	planRefusal: string | null;
	/** True when the draft changed while the last Run plan was saving it. */
	draftMoved: boolean;
	runPlan: () => void;

	/** Why Deploy is disabled; null when it may be pressed. */
	deployBlocked: DeployBlock | null;
	deployPending: boolean;
	deployRefusal: string | null;
	/** The verb on the commit button: the sink's. */
	deployLabel: string;
	/** The commit to run for the reviewed plan; null while Deploy is blocked. */
	commitInput: CommitInput | null;
	/** The mutation behind Deploy, for a confirmation that drives it. */
	commit: ReturnType<typeof useCommit>;
	deploy: () => void;
	/** Records the server's current plan as reviewed: the answer to `not-reviewed`. */
	acceptPlan: () => void;
}

/** The query keys a save, a plan or a deploy of the environment moves. */
function reviewKeys() {
	return [
		orpc.canvas.environmentStatus.key(),
		orpc.canvas.environmentJobs.key(),
		orpc.canvas.reviewPlan.key(),
	];
}

/** The first non-empty line of a job's message. */
function firstLine(message: string | null | undefined): string | null {
	const line = message
		?.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return line ?? null;
}

/** The commit mutation: deploys exactly the reviewed plan. */
function useCommit(
	scope: ReviewScope,
	onRefused: (message: string) => void,
	onQueued: () => void,
) {
	const sink = useChangesetSink(scope.projectId);
	return useActionMutation((input: CommitInput) => sink.commit(input), {
		invalidates: reviewKeys(),
		onRefusal: (error) => onRefused(error.message),
		successMessage: "Deploy queued",
		onSuccess: onQueued,
	});
}

/** The review view's state and actions for one environment. */
export function useReview(scope: ReviewScope): ReviewController {
	const board = useBoard();
	const sink = useChangesetSink(scope.projectId);
	const env = useEnvironmentStatus();
	const designNodes = useDesignNodes();
	const changes = usePendingChanges();
	const fieldChanges = useFieldChanges();
	const operations = useOperations();
	const issues = useMemo(() => reviewIssues(designNodes), [designNodes]);

	const planQuery = useQuery({
		...orpc.canvas.reviewPlan.queryOptions({
			input: environmentStatusInput(scope.projectId, scope.environmentId),
		}),
		// Whether a plan is the one to deploy is asked again every time the view opens: an answer
		// from before a save or a run is the one answer this view must not show.
		staleTime: 0,
	});
	const server = planQuery.data;
	const phase = planPhase(
		server,
		planQuery.isPending ? "loading" : planQuery.isError ? "error" : "ready",
	);

	// The resource list of a finished plan, and the message of a failed one, are the plan JOB's.
	const settled =
		phase === "failed" ||
		phase === "cancelled" ||
		phase === "current" ||
		phase === "design-changed" ||
		phase === "run-since";
	const planJobId = server?.planJobId ?? null;
	const resultQuery = useQuery({
		...orpc.jobs.planResult.queryOptions({ input: { id: planJobId ?? "" } }),
		enabled: settled && planJobId !== null,
	});
	const resources = useMemo<PlanResources>(() => {
		if (!settled || planJobId === null || phase === "failed" || phase === "cancelled") {
			return { state: "idle" };
		}
		if (resultQuery.isPending) return { state: "loading" };
		const stored = resultQuery.data?.execution_metadata?.plan_result;
		if (resultQuery.isError || !stored) return { state: "error" };
		try {
			return { state: "ready", resources: parsePlanJSON(stored).resources };
		} catch {
			return { state: "error" };
		}
	}, [settled, planJobId, phase, resultQuery.isPending, resultQuery.isError, resultQuery.data]);
	const planError = phase === "failed" ? firstLine(resultQuery.data?.error_message) : null;

	const reviewedPlan = useStore(board.document, (s) => s.reviewedPlan);
	const review = usePlanReview(serverCurrentFor(server, reviewedPlan));
	const saved = useStore(board.view, (s) => s.review.saved);

	const [planRefusal, setPlanRefusal] = useState<string | null>(null);
	const [draftMoved, setDraftMoved] = useState(false);
	/** The draft's revision when the plan in flight was requested. */
	const requested = useRef<string | null>(null);

	const plan = useActionMutation((input: ChangesetInput) => sink.plan(input), {
		invalidates: reviewKeys(),
		onRefusal: (error) => setPlanRefusal(error.message),
		onSuccess: (data, variables) => {
			const document = board.document.getState();
			if (draftRevision(document.designNodes) !== requested.current) {
				// The draft is no longer what was saved. Committing the baseline now would hide the
				// edits made since, and recording the plan would call it a plan of them.
				setDraftMoved(true);
				return;
			}
			document.commitBaseline();
			document.recordReviewedPlan(data.planJobId);
			board.view.getState().setReviewSaved(variables.changes);
		},
	});

	const planBlocked = planBlock({
		refusal: env.deployRefusal,
		activeJob: env.activeJob,
		issues: issues.length,
	});

	const submitPlan = plan.submit;
	const runPlan = useCallback(() => {
		const document = board.document.getState();
		const parsed = projectFormSchema.safeParse(graphToForm(document.designNodes));
		// The issues list already says why; a design with issues is never sent.
		if (!parsed.success) return;
		requested.current = draftRevision(document.designNodes);
		setPlanRefusal(null);
		setDraftMoved(false);
		submitPlan({
			projectId: scope.projectId,
			environmentId: scope.environmentId,
			environmentName: scope.environmentName,
			design: parsed.data,
			changes: diffNodes(document.baseline, document.designNodes),
			fieldChanges: diffFields(document.baseline, document.designNodes),
			edits: changesetEdits(scope.environmentName, document.baseline, document.designNodes),
			operations: document.operations,
		});
	}, [board, scope.projectId, scope.environmentId, scope.environmentName, submitPlan]);

	const deployBlocked = deployBlock({
		gate: review.gate,
		refusal: env.deployRefusal,
		activeJob: env.activeJob,
		pendingDesign: changes.length,
		pendingOperations: operations.length,
		issues: issues.length,
		phase,
		planJobId,
	});

	const [deployRefusal, setDeployRefusal] = useState<string | null>(null);
	const resolvedEnvironmentId = server?.environmentId ?? scope.environmentId;
	const commit = useCommit(scope, setDeployRefusal, () => {
		// The plan has been spent: a deploy was queued after it, so it is no longer the plan to
		// deploy, on the server or here.
		board.document.getState().clearReviewedPlan();
		track("deploy_queued", { environmentId: resolvedEnvironmentId });
	});

	const commitInput = useMemo<CommitInput | null>(() => {
		if (deployBlocked !== null || !review.gate.allowed || review.gate.planJobId === null) return null;
		return {
			projectId: scope.projectId,
			environmentId: scope.environmentId,
			planJobId: review.gate.planJobId,
		};
	}, [deployBlocked, review.gate, scope.projectId, scope.environmentId]);

	const submitCommit = commit.submit;
	const deploy = useCallback(() => {
		if (!commitInput) return;
		setDeployRefusal(null);
		submitCommit(commitInput);
	}, [commitInput, submitCommit]);

	const acceptPlan = useCallback(() => {
		// Only the plan the server calls current, and only for a draft with nothing pending: then
		// the design on the board is the saved design that plan was computed for.
		if (!server?.current || server.planJobId === null) return;
		const document = board.document.getState();
		if (diffNodes(document.baseline, document.designNodes).length + document.operations.length > 0) return;
		document.recordReviewedPlan(server.planJobId);
	}, [board, server]);

	const refetchPlan = planQuery.refetch;
	const retryRead = useCallback(() => void refetchPlan(), [refetchPlan]);

	return {
		issues,
		changes,
		fieldChanges,
		operations,
		saved,
		server,
		phase,
		resources,
		planError,
		retryRead,
		planBlocked,
		planPending: plan.isPending,
		planRefusal,
		draftMoved,
		runPlan,
		deployBlocked,
		deployPending: commit.isPending,
		deployRefusal,
		deployLabel: sink.primaryLabel,
		commitInput,
		commit,
		deploy,
		acceptPlan,
	};
}
