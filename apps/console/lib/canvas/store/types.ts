// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canvas store's shared vocabulary (#6764). Types and constants only, so every other module in
// this directory — and the shell lanes behind it — can import the contract without importing a
// store.

import type { XYPosition } from "@xyflow/react";
import type {
	CanvasNode,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

/** The id of the project root: the graph's data anchor, never drawn as a card. */
export const PROJECT_NODE_ID = "project-root";

/** Where every card sits, by node id. Design cards and out-of-band cards share the one map. */
export type Positions = Record<string, XYPosition>;

/**
 * What the inspector is showing. One value, so "which card is on the rail" and "what is selected"
 * cannot disagree.
 */
export type Subject =
	| { kind: "node"; id: string }
	| { kind: "collection"; nodeKind: NodeKind }
	| { kind: "environment" }
	| { kind: "selection"; ids: string[] };

/** The inspector's tabs. Which of them a subject offers is the inspector's decision. */
export type InspectorTab = "configure" | "connections" | "status" | "sources" | "activity";

/** A field the inspector should scroll to and focus: the review view's "Go to". */
export interface FieldFocus {
	nodeId: string;
	path: string;
}

/** A staged difference between the canvas (desired) and the saved baseline. */
export interface PendingChange {
	id: string;
	op: "new" | "modified" | "removed";
	kind: NodeKind;
	name: string;
}

/** One changed field of one node, with the saved value and the drafted one. */
export interface FieldChange {
	id: string;
	op: "new" | "modified" | "removed";
	kind: NodeKind;
	name: string;
	/** The config key that changed, or `cloud_identity_id` for a re-placement. Null for a node that
	 * is wholly new or wholly removed. */
	field: string | null;
	before: unknown;
	after: unknown;
}

/**
 * Where the persisted draft came from. `scope` is the project:environment the draft belongs to;
 * `revision` is the server design's content hash at the time it was seeded. `reseed` compares both
 * so a server re-render that changed nothing is a no-op instead of a graph reset.
 */
export interface DraftSeed {
	scope: string;
	revision: string;
}

/**
 * A change that is not a design edit: an add-on install, update or removal, or a chart workload's
 * overlay. It is staged beside the design edits, listed in review, and run through its own server
 * action when the changeset is applied.
 */
export interface StagedOperation {
	/** Stable per target, so staging the same target again replaces the earlier entry. */
	id: string;
	target: "addon" | "chart-workload";
	verb: "install" | "update" | "remove" | "overlay";
	/** The add-on's catalog id or the workload's id. */
	targetId: string;
	/** The line the review view shows. */
	summary: string;
	/** The input the operation's own server action takes; that action validates it. */
	input: unknown;
}

/**
 * What the wizard hands the board to start from, already parsed. The hand-off contract's
 * `CanvasSeed` (`lib/projects/canvas-handoff.ts`) is assignable to this: a template id is a string
 * here so the store does not depend on the create flow's catalogue. The store never parses or
 * validates a seed — the caller does, through that contract, with the offered-cloud list the server
 * gave it — and a seed carries no environments and no cloud account.
 */
export type BoardSeed =
	| { readonly kind: "proposal"; readonly proposalId: string }
	| { readonly kind: "template"; readonly templateId: string; readonly provider: CloudProviderSlug }
	| { readonly kind: "blank" }
	| { readonly kind: "byo"; readonly attach: "chart" | "iac" };

/** The plan a person last reviewed, and the design it was computed for. */
export interface ReviewedPlan {
	planJobId: string;
	/** `draftRevision` of the design nodes at the moment the plan was requested. */
	designRevision: string;
}

/**
 * The legacy rail card. The six-member union the shell reads until the one inspector replaces it;
 * `Subject` is what it maps onto.
 */
export type WorkspaceCard =
	| { kind: "inspector"; nodeId: string }
	| { kind: "env-settings" }
	| { kind: "activity" }
	| { kind: "addon"; itemId: string }
	| { kind: "chart-scan"; chartId: string }
	| { kind: "iac-scan" };

/**
 * React Flow's own per-node view state (selected, measured, dragging and the like): everything on a
 * board node that is neither the design nor where the card sits.
 */
export type NodeViewFlags = Omit<CanvasNode, "id" | "type" | "data" | "position" | "deletable">;
