// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The proposal contract: what a design proposal IS once it reaches the canvas, and the calls that
// read one and decide on its changes.
//
// A proposal is what a repository scan (or a re-scan, or the agent) suggests for a project. It is
// never applied directly. It is shown as a CHANGESET — one proposed change per component, each with
// the evidence for it and what it would cost — and a person accepts, edits or rejects each change.
// An accepted or edited change goes into the same staging area the canvas already writes to; a
// rejected one is only recorded as rejected. Nothing here writes a component.
//
// This file is the seam between three lanes that land separately: the server that stores and
// materialises proposals, the create flow that attaches one to a new project, and the canvas that
// draws one. It is a CONTRACT — the schemas, the types inferred from them and the call signatures —
// and it reads no database and makes no call, so the browser can import it too.
//
// THE SHAPES ARE STATED ONCE, AS ZOD SCHEMAS. The types are inferred from them, so the shape a
// stored proposal is validated against and the shape the canvas is typed against cannot drift.

import { z } from "zod";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import type { StagedChangePayload } from "@/types/jsonb.types";

// ── The design file's vocabulary ──────────────────────────────────────────────────────────

/**
 * What can happen to one thing a design file is compared against, in the words of
 * `packages/core/designfile` (compare.go, `Action`). The two that look alike are not:
 *
 *   - `omitted` is the only thing an absence in the file can produce. The thing is left exactly as
 *     it is; nothing is deleted.
 *   - `remove` is an explicit request to take an entry OUT OF THE FILE. No reading of a file
 *     produces it.
 */
export const DESIGN_FILE_ACTIONS = ["create", "update", "unchanged", "omitted", "remove"] as const;

/** One of {@link DESIGN_FILE_ACTIONS}. */
export type DesignFileAction = (typeof DESIGN_FILE_ACTIONS)[number];

/** The three actions a change made outside the file can ask of it (edit.go, `Edit.Action`). */
export type DesignFileEditAction = Extract<DesignFileAction, "create" | "update" | "remove">;

/**
 * One change to a component that the design file should now state — `designfile.Edit`, with its
 * fields named the way this console names JSON. `kind` is the file's component kind (`databases`,
 * `cluster`), `name` is absent for a kind with one component per environment, and `fields` are the
 * fields to write: a field not named keeps what the file says.
 */
export interface DesignFileEdit {
	environment: string;
	kind: string;
	name?: string;
	action: DesignFileEditAction;
	fields: StagedChangePayload;
}

// ── A proposed change ─────────────────────────────────────────────────────────────────────

/** What a proposed change does to a component — the values of the `change_op` enum. */
export const PROPOSAL_CHANGE_OPS = ["CREATE", "UPDATE", "DELETE"] as const;

/** One of {@link PROPOSAL_CHANGE_OPS}. */
export type ProposalChangeOp = (typeof PROPOSAL_CHANGE_OPS)[number];

/**
 * Where a person has got to with one proposed change. `pending` is undecided; `accepted` and
 * `edited` are staged (an edited one with the person's payload in place of the proposed one);
 * `rejected` is recorded and staged nowhere.
 */
export const PROPOSAL_DECISIONS = ["pending", "accepted", "edited", "rejected"] as const;

/** One of {@link PROPOSAL_DECISIONS}. */
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

/** What produced a proposal. */
export const PROPOSAL_ORIGINS = ["scan", "rescan", "agent"] as const;

/** One of {@link PROPOSAL_ORIGINS}. */
export type ProposalOrigin = (typeof PROPOSAL_ORIGINS)[number];

/**
 * One reason a change is proposed: a signal found in a repository file.
 *
 * `verified` is the server's statement, not the model's: true only when `path` is a file in the
 * scanned digest and `signal` was located in it, in which case `line` is where. Evidence that could
 * not be located is kept and shown as unverified rather than dropped.
 */
export const proposalEvidenceSchema = z.object({
	repo_url: z.string(),
	path: z.string(),
	line: z.number().int().positive().optional(),
	signal: z.string(),
	verified: z.boolean(),
});

/** See {@link proposalEvidenceSchema}. */
export type ProposalEvidence = z.infer<typeof proposalEvidenceSchema>;

/**
 * What one proposed component costs per month. `basis` says where the price came from: `live`
 * from the provider's current prices, `fallback` from the built-in table used when those could not
 * be read.
 */
export const proposalCostSchema = z.object({
	monthly: z.number().nonnegative(),
	currency: z.literal("USD"),
	basis: z.enum(["live", "fallback"]),
});

/** See {@link proposalCostSchema}. */
export type ProposalCost = z.infer<typeof proposalCostSchema>;

/**
 * One proposed change to one component.
 *
 * `key` identifies the change across revisions of the proposal (see {@link proposalChangeKey}), so
 * a decision survives a re-materialisation. `component_type`, `component_id`, `op` and `payload`
 * are exactly what a staged change row holds, which is what lets an accepted change be staged
 * without translation. `cost` is null when no cloud is chosen to price it on.
 */
export const proposalChangeSchema = z.object({
	key: z.string().min(1),
	op: z.enum(PROPOSAL_CHANGE_OPS),
	component_type: z.string().min(1),
	component_id: z.uuid().optional(),
	payload: z.record(z.string(), z.unknown()),
	why: z.array(proposalEvidenceSchema),
	confidence: z.number().min(0).max(1),
	cost: proposalCostSchema.nullable(),
	decision: z.enum(PROPOSAL_DECISIONS),
});

/** See {@link proposalChangeSchema}. */
export type ProposalChange = z.infer<typeof proposalChangeSchema>;

/**
 * Every cloud a proposal can be placed on. Written as a record so the compiler requires one entry
 * per provider slug: a slug added to the catalog fails the build here until it is listed. Whether a
 * cloud is OFFERED to this organization is a separate, server-side question this does not answer.
 */
const PLACEMENT_PROVIDERS: Record<CloudProviderSlug, true> = {
	aws: true,
	gcp: true,
	azure: true,
	hetzner: true,
	alibaba: true,
};

/** True when the value is the slug of a cloud a proposal can be placed on. */
export function isPlacementProvider(value: unknown): value is CloudProviderSlug {
	return typeof value === "string" && Object.hasOwn(PLACEMENT_PROVIDERS, value);
}

/** The cloud account and region a changeset was materialised for. */
export const proposalPlacementSchema = z.object({
	identity_id: z.uuid(),
	provider: z.custom<CloudProviderSlug>(isPlacementProvider),
	region: z.string().min(1),
});

/** See {@link proposalPlacementSchema}. */
export type ProposalPlacement = z.infer<typeof proposalPlacementSchema>;

/**
 * A proposal, materialised for one placement.
 *
 * `revision` rises every time the changeset changes — a decision, an edit, a new placement — and is
 * what a decision is checked against. `base_design_revision` is the revision of the design the
 * changes were computed against, and null for a project that has no design yet. `placement` is null
 * while no verified cloud account is chosen: the changes are still listed, without a cost.
 */
export const proposalChangesetSchema = z.object({
	proposal_id: z.uuid(),
	revision: z.number().int().nonnegative(),
	base_design_revision: z.string().nullable(),
	placement: proposalPlacementSchema.nullable(),
	changes: z.array(proposalChangeSchema),
});

/** See {@link proposalChangesetSchema}. */
export type ProposalChangeset = z.infer<typeof proposalChangesetSchema>;

// ── Keys, and the way to the design file ──────────────────────────────────────────────────

/**
 * The key of a proposed change: `component_type:name`, or the bare `component_type` for a kind with
 * one component per environment. The same component gets the same key in every revision.
 */
export function proposalChangeKey(componentType: string, name?: string): string {
	return name === undefined || name === "" ? componentType : `${componentType}:${name}`;
}

/**
 * Reads a key back into its parts. The component type ends at the FIRST colon, so a name may hold
 * one. Returns null for a key with no component type.
 */
export function parseProposalChangeKey(key: string): { componentType: string; name?: string } | null {
	const at = key.indexOf(":");
	if (at === -1) return key === "" ? null : { componentType: key };
	const componentType = key.slice(0, at);
	const name = key.slice(at + 1);
	if (componentType === "") return null;
	return name === "" ? { componentType } : { componentType, name };
}

/** One design-file action per change op; the type requires all three. */
const DESIGN_FILE_ACTION_FOR_OP: Record<ProposalChangeOp, DesignFileEditAction> = {
	CREATE: "create",
	UPDATE: "update",
	DELETE: "remove",
};

/**
 * The design-file action a proposed change stands for. A `DELETE` becomes `remove`: the entry is
 * taken out of the file. By the file's own reading rule that deletes nothing — a component the file
 * stops mentioning is left running — so destroying one is never something a proposal can reach.
 */
export function designFileActionForOp(op: ProposalChangeOp): DesignFileEditAction {
	return DESIGN_FILE_ACTION_FOR_OP[op];
}

// ── Reading a proposal ────────────────────────────────────────────────────────────────────

/**
 * A proposal as a reader sees it. The three states are the three things the canvas can say:
 * the scan is still running, it failed, or here is the changeset.
 *
 * `pending_scans` counts the scans not yet finished. `failure` is a sentence for the person, and
 * a failed proposal can be retried or set aside — never silently treated as an empty one.
 */
export type ProposalView =
	| { state: "scanning"; proposal_id: string; origin: ProposalOrigin; pending_scans: number }
	| { state: "failed"; proposal_id: string; origin: ProposalOrigin; failure: string }
	| { state: "ready"; proposal_id: string; origin: ProposalOrigin; changeset: ProposalChangeset };

/**
 * Reads one proposal by id. A proposal the caller may not see is `null`, the same as one that does
 * not exist. Reading never runs a scan and never calls a model.
 */
export type ReadProposal = (proposalId: string) => Promise<ProposalView | null>;

/**
 * Reads the proposal attached to a project and still open on it, or `null` when there is none.
 * The same visibility rule as {@link ReadProposal}.
 */
export type ReadProjectProposal = (projectId: string) => Promise<ProposalView | null>;

// ── Deciding ──────────────────────────────────────────────────────────────────────────────

/** What every decision names: the proposal, the revision the person was looking at, the change. */
const decisionTarget = {
	proposal_id: z.uuid(),
	revision: z.number().int().nonnegative(),
	key: z.string().min(1),
};

/**
 * A decision on one proposed change, as it arrives from a person.
 *
 * `accepted` stages the change as proposed; `edited` stages it with `payload` in place of the
 * proposed one; `rejected` records the rejection; `pending` takes a decision back.
 */
export const decideProposalChangeSchema = z.discriminatedUnion("decision", [
	z.object({ ...decisionTarget, decision: z.literal("accepted") }),
	z.object({
		...decisionTarget,
		decision: z.literal("edited"),
		payload: z.record(z.string(), z.unknown()),
	}),
	z.object({ ...decisionTarget, decision: z.literal("rejected") }),
	z.object({ ...decisionTarget, decision: z.literal("pending") }),
]);

/** See {@link decideProposalChangeSchema}. */
export type DecideProposalChangeInput = z.infer<typeof decideProposalChangeSchema>;

/**
 * Why a decision, or a new placement, was not taken. Nothing is staged and nothing is changed in
 * any of these cases.
 *
 *   - `not_found`         — no such proposal, or not one the caller may see.
 *   - `not_ready`         — the proposal has no changeset yet (still scanning, or failed).
 *   - `stale_revision`    — the changeset has moved on from the revision named; read it again.
 *   - `unknown_change`    — the changeset has no change with that key.
 *   - `invalid_payload`   — an edited payload is not a valid configuration for that component.
 *   - `base_moved`        — the design the changes were computed against has since changed.
 *   - `unusable_identity` — the cloud account named is not one the caller may place a project on.
 */
export const PROPOSAL_REFUSAL_REASONS = [
	"not_found",
	"not_ready",
	"stale_revision",
	"unknown_change",
	"invalid_payload",
	"base_moved",
	"unusable_identity",
] as const;

/** One of {@link PROPOSAL_REFUSAL_REASONS}. */
export type ProposalRefusalReason = (typeof PROPOSAL_REFUSAL_REASONS)[number];

/** The changeset after a call that changed it, or the reason it was left as it was. */
export type ProposalChangeResult =
	| { ok: true; changeset: ProposalChangeset }
	| { ok: false; reason: ProposalRefusalReason };

/** Takes one decision on one change and returns the changeset at its new revision. */
export type DecideProposalChange = (input: DecideProposalChangeInput) => Promise<ProposalChangeResult>;

/** A cloud account and region to materialise a proposal for, as it arrives from a person. */
export const placeProposalSchema = z.object({
	proposal_id: z.uuid(),
	revision: z.number().int().nonnegative(),
	identity_id: z.uuid(),
	region: z.string().min(1),
});

/** See {@link placeProposalSchema}. */
export type PlaceProposalInput = z.infer<typeof placeProposalSchema>;

/**
 * Materialises a proposal for a placement and returns the changeset at its new revision. Decisions
 * already taken are carried over by key. It prices the changes again; it does not scan again and
 * does not call a model.
 */
export type PlaceProposal = (input: PlaceProposalInput) => Promise<ProposalChangeResult>;
