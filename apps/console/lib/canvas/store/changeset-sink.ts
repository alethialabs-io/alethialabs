"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Where a reviewed changeset GOES (#6764).
//
// The review view does two things with a changeset: it asks for a plan of it, and it commits it.
// What those mean depends on how the project is managed, and the review view must not know which:
//
//   - `apply`        — the design is saved to the environment and planned; committing deploys
//                      exactly the plan that was reviewed.
//   - `pull-request` — the project is managed in git, so the design lives in `alethia.yaml`;
//                      committing opens a pull request that changes the file.
//
// Both kinds are part of the contract. Only the `apply` sink is implemented here; the pull-request
// sink is built against `packages/core/designfile`, whose `Edit` is what `ChangesetEdit` mirrors.
// No file in this directory reads a project's management mode: `useChangesetSink` is the one place
// that will choose.

import { useMemo } from "react";
import { planEnvironmentAction, saveDesignAction } from "@/app/server/actions/canvas-writes";
import { applyPlan } from "@/app/server/actions/jobs";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { ActionResult } from "@/lib/actions/result";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import { diffFields, diffNodes } from "./derive";
import type { FieldChange, PendingChange, StagedOperation } from "./types";

/** The two ways a changeset can leave the board. */
export type ChangesetSinkKind = "apply" | "pull-request";

/**
 * One component change, in the shape `packages/core/designfile`'s `Edit` takes: the environment's
 * name, the component kind as the design file spells it (`databases`, `cluster`), the component's
 * name (empty for a kind with one component per environment), what to do, and the fields to write.
 *
 * `fields` follows `Edit.Fields`: a field not named keeps what the file says, and a field named
 * with a null value is written as null. An `update` therefore names only the fields that changed.
 */
export interface ChangesetEdit {
	environment: string;
	kind: string;
	name: string;
	action: "create" | "update" | "remove";
	fields: Record<string, unknown>;
}

/** A changeset handed to a sink: the design to reach, and what differs from the saved design. */
export interface ChangesetInput {
	projectId: string;
	/** The environment's id; null means the project's default environment. */
	environmentId: string | null;
	/** The environment's name, as the design file names it. */
	environmentName: string;
	/** The whole drafted design, validated. The apply sink saves this. */
	design: ProjectFormData;
	/** What is pending, one row per node. */
	changes: PendingChange[];
	/** What is pending, one row per field. */
	fieldChanges: FieldChange[];
	/** The same changes as design-file edits. The pull-request sink writes these. */
	edits: ChangesetEdit[];
	/** Out-of-band operations staged with the design changes. */
	operations: StagedOperation[];
}

/** What a commit acts on: the plan that was reviewed. */
export interface CommitInput {
	projectId: string;
	environmentId: string | null;
	/** The plan `plan()` answered with, once it succeeded and was reviewed. */
	planJobId: string;
}

/** What a commit produced: a deploy job (apply), or a pull request's address (pull-request). */
export interface CommitOutcome {
	jobId?: string;
	url?: string;
}

/**
 * The seam between the review view and what a project does with a reviewed changeset. The review
 * view calls only this.
 */
export interface ChangesetSink {
	readonly kind: ChangesetSinkKind;
	/** The verb on the commit button: "Deploy" or "Open pull request". */
	readonly primaryLabel: string;
	/** Compute a plan of the changeset. Answers the plan job to review. */
	plan(input: ChangesetInput): Promise<ActionResult<{ planJobId: string }>>;
	/** Commit the reviewed plan. */
	commit(input: CommitInput): Promise<ActionResult<CommitOutcome>>;
}

/** The `apply` sink's own type, so a caller that needs to know can narrow by `kind`. */
export interface ApplyChangesetSink extends ChangesetSink {
	readonly kind: "apply";
}

/** The `pull-request` sink's own type. Declared here, implemented with the git wave. */
export interface PullRequestChangesetSink extends ChangesetSink {
	readonly kind: "pull-request";
}

/**
 * The pending changes as design-file edits.
 *
 * A new node is a `create` carrying its whole config; a removed node is a `remove`; a modified
 * node is an `update` carrying only the fields whose value changed (a field the draft dropped is
 * written as null). A re-placement onto another cloud identity is not a field of the design file's
 * component and is not carried: the file's `cloud.account` is project-wide.
 */
export function changesetEdits(
	environmentName: string,
	baseline: CanvasNode[],
	designNodes: CanvasNode[],
): ChangesetEdit[] {
	const byId = new Map(designNodes.map((n) => [n.id, n]));
	const saved = new Map(baseline.map((n) => [n.id, n]));
	const fieldRows = diffFields(baseline, designNodes);
	const edits: ChangesetEdit[] = [];
	for (const change of diffNodes(baseline, designNodes)) {
		const node = change.op === "removed" ? saved.get(change.id) : byId.get(change.id);
		if (!node) continue;
		const def = NODE_REGISTRY[node.data.kind];
		const head = {
			environment: environmentName,
			kind: def.schemaKey,
			name: def.cardinality === "array" ? (configName(node.data) ?? "") : "",
		};
		if (change.op === "removed") {
			edits.push({ ...head, action: "remove", fields: {} });
			continue;
		}
		if (change.op === "new") {
			edits.push({ ...head, action: "create", fields: { ...node.data.config } });
			continue;
		}
		const fields: Record<string, unknown> = {};
		for (const row of fieldRows) {
			if (row.id !== change.id || row.field === null || row.field === "cloud_identity_id") {
				continue;
			}
			fields[row.field] = row.after === undefined ? null : row.after;
		}
		if (Object.keys(fields).length > 0) edits.push({ ...head, action: "update", fields });
	}
	return edits;
}

/**
 * The `apply` sink: `plan` saves the drafted design to the environment and queues a plan of it;
 * `commit` deploys exactly the plan that was reviewed. Both run the server actions the board
 * already uses, so every authorization, gate and refusal is the one that already exists.
 */
export function createApplySink(): ApplyChangesetSink {
	return {
		kind: "apply",
		primaryLabel: "Deploy",
		plan: async (input) => {
			const saved = await saveDesignAction({
				projectId: input.projectId,
				environmentId: input.environmentId,
				design: input.design,
			});
			if (!saved.ok) return saved;
			const planned = await planEnvironmentAction({
				projectId: input.projectId,
				environmentId: saved.data.environmentId,
			});
			if (!planned.ok) return planned;
			return { ok: true, data: { planJobId: planned.data.jobId } };
		},
		commit: async (input) => {
			const applied = await applyPlan({ planJobId: input.planJobId, runnerId: null });
			if (!applied.ok) return applied;
			return { ok: true, data: { jobId: applied.data.jobId } };
		},
	};
}

/**
 * The sink for a project's changesets. Returns the `apply` sink for every project until the
 * pull-request sink lands; the choice between the two is made here and nowhere else.
 */
export function useChangesetSink(_projectId: string): ChangesetSink {
	return useMemo(() => createApplySink(), []);
}
