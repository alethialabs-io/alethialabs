// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every reason the draft cannot be planned, as a list a person can act on (#6833).
//
// A card shows its FIRST issue. The review view shows all of them, each mapped to the card and the
// field it is about, because "Run plan" saves the design first and a design with issues is not
// sent. The validation is the plan path's own (`graphToForm` + `projectFormSchema`), so what is
// listed here is exactly what a plan would refuse. The board's plain Save validates with
// `designSaveSchema`, which differs only in not requiring a cloud account (#7272), and tells its
// refusal through `schemaIssues` + `saveRefusalMessage` below, in the same words.
//
// A validator path never reaches the screen. An issue is told as the card's kind and name, the
// field's label, and the validator's sentence; an issue that belongs to no card is told by the part
// of the design it is about.

import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import { OUT_OF_BAND } from "@/lib/canvas/store/derive";
import { projectFormSchema } from "@/lib/validations/project-form.schema";
import { fieldLabel } from "./changeset-status";

/** One reason the draft cannot be saved. */
export interface ReviewIssue {
	/** Stable within one list, for a React key. */
	key: string;
	/** The card the issue is on; null for an issue that belongs to no card. */
	nodeId: string | null;
	/** What the issue is on, in words: "Database orders", or "Cluster" for a part with no card. */
	subject: string;
	/** The field's label; null when the issue is about the card as a whole. */
	field: string | null;
	/** The field's path inside the card's config, for the inspector's focus; null with `field`. */
	fieldPath: string | null;
	/** The validator's sentence. */
	message: string;
}

/** A design kind and whether a design holds many of it. */
interface KindEntry {
	kind: NodeKind;
	array: boolean;
}

/** The project root: where source repositories are edited. */
const PROJECT_ENTRY: KindEntry = { kind: "project", array: false };

/** The design kinds by the key their config is saved under. */
function kindsBySchemaKey(): Map<string, KindEntry> {
	const byKey = new Map<string, KindEntry>();
	for (const def of Object.values(NODE_REGISTRY)) {
		if (OUT_OF_BAND.has(def.kind)) continue;
		byKey.set(def.schemaKey, { kind: def.kind, array: def.cardinality === "array" });
	}
	return byKey;
}

/** A card in words: its kind's label and, when it has one, its name. */
function subjectOf(node: CanvasNode): string {
	const label = NODE_REGISTRY[node.data.kind].label;
	const name = configName(node.data);
	return name ? `${label} ${name}` : label;
}

/** The label of the last named segment of a path: `["node_groups", 0, "instance_type"]` reads "Instance type". */
function labelOfPath(path: readonly PropertyKey[]): string | null {
	const named = path.filter((segment): segment is string => typeof segment === "string");
	const last = named.at(-1);
	return last === undefined ? null : fieldLabel(last);
}

/** A path as the inspector addresses a field: its segments joined with dots. */
function dotted(path: readonly PropertyKey[]): string | null {
	const parts = path.filter(
		(segment): segment is string | number =>
			typeof segment === "string" || typeof segment === "number",
	);
	return parts.length === 0 ? null : parts.join(".");
}

/** One validator finding, as zod reports it: where in the design, and its sentence. */
interface ValidatorIssue {
	path: readonly PropertyKey[];
	message: string;
}

/**
 * The validator's findings on the design `nodes` describe, each told as the card (or part of the
 * design) it is about, the field's label and the sentence — never as the validator's path. Shared by
 * the review's list and the board's Save, so the two cannot tell the same problem two ways.
 */
export function schemaIssues(
	nodes: CanvasNode[],
	validatorIssues: readonly ValidatorIssue[],
): ReviewIssue[] {
	const issues: ReviewIssue[] = [];
	const byKey = kindsBySchemaKey();
	const project = nodes.find((n) => n.data.kind === "project");
	for (const [index, issue] of validatorIssues.entries()) {
		const [head, second, ...rest] = issue.path;
		const key = `schema-${index}`;
		if (typeof head !== "string") {
			issues.push({ key, nodeId: null, subject: "Design", field: null, fieldPath: null, message: issue.message });
			continue;
		}
		// Source repositories are saved beside the project and edited on its card.
		const entry = head === "source_repos" ? PROJECT_ENTRY : byKey.get(head);
		let node: CanvasNode | undefined;
		let within: readonly PropertyKey[] = [];
		if (head === "source_repos") {
			node = project;
			within = issue.path;
		} else if (entry?.array && typeof second === "number") {
			node = nodes.filter((n) => n.data.kind === entry.kind)[second];
			within = rest;
		} else if (entry && !entry.array) {
			node = nodes.find((n) => n.data.kind === entry.kind);
			within = issue.path.slice(1);
		}
		if (!node) {
			// A part of the design with no card on the board: say which part, in words.
			issues.push({
				key,
				nodeId: null,
				subject: entry ? NODE_REGISTRY[entry.kind].label : fieldLabel(head),
				field: labelOfPath(issue.path.slice(1)),
				fieldPath: null,
				message: issue.message,
			});
			continue;
		}
		issues.push({
			key,
			nodeId: node.id,
			subject: subjectOf(node),
			field: labelOfPath(within),
			fieldPath: dotted(within),
			message: issue.message,
		});
	}
	return issues;
}

/**
 * The sentence a toast shows for a design that could not be saved: its first issue, in the words the
 * review uses ("Database orders · Engine version — …"). A validator path such as
 * `project.cloud_identity_id` never reaches it (#7272, CON-G1).
 */
export function saveRefusalMessage(issues: readonly ReviewIssue[]): string {
	const first = issues[0];
	if (!first) return "Can't save this design. Open the review to see what needs fixing.";
	const where = first.field ? `${first.subject} · ${first.field}` : first.subject;
	return `Can't save: ${where} — ${first.message}`;
}

/**
 * Every issue in the design `nodes` describe, in the order the validator reports them, followed by
 * each service binding whose target is not on the board. A draft that cannot be validated at all
 * yields one issue that says so, never an empty list: an empty list means "this can be saved".
 */
export function reviewIssues(nodes: CanvasNode[]): ReviewIssue[] {
	const issues: ReviewIssue[] = [];
	let result: ReturnType<typeof projectFormSchema.safeParse>;
	try {
		result = projectFormSchema.safeParse(graphToForm(nodes));
	} catch {
		return [
			{
				key: "unreadable",
				nodeId: null,
				subject: "Design",
				field: null,
				fieldPath: null,
				message: "This draft could not be checked. Discard it, or undo the last change, and try again.",
			},
		];
	}

	if (!result.success) issues.push(...schemaIssues(nodes, result.error.issues));

	// A binding to a resource that is not on the board cannot deploy, and the schema cannot see it:
	// it checks one card at a time.
	for (const service of nodes) {
		if (service.data.kind !== "service") continue;
		for (const [index, binding] of (service.data.config.bindings ?? []).entries()) {
			const placed = nodes.some(
				(n) => n.data.kind === binding.target.kind && configName(n.data) === binding.target.name,
			);
			if (placed) continue;
			issues.push({
				key: `binding-${service.id}-${index}`,
				nodeId: service.id,
				subject: subjectOf(service),
				field: "Connections",
				fieldPath: "bindings",
				message: `It connects to ${binding.target.kind} "${binding.target.name}", which is not on the board. Add it, or remove the connection.`,
			});
		}
	}
	return issues;
}
