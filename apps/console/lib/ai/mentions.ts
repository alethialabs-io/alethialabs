// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

/** The resource families a user can @-reference in the Elench composer. */
export const MENTION_TYPES = [
	"project",
	"cluster",
	"connector",
	"job",
	"runner",
	"identity",
] as const;

export type MentionType = (typeof MENTION_TYPES)[number];

/** The read tool Elench should reach for to act on each mention type. */
export const MENTION_TOOL: Record<MentionType, string> = {
	project: "get_project(projectId)",
	cluster: "list_clusters",
	connector: "list_connectors",
	job: "get_job(jobId)",
	runner: "list_runners",
	identity: "list_cloud_identities",
};

/** A resolved @-mention attached to a sent message. */
export interface Mention {
	/** The stable resource id (or name, for catalog resources like connectors). */
	id: string;
	type: MentionType;
	/** The human label shown as the token (e.g. the project/cluster name). */
	label: string;
}

/** A candidate returned by the mention search (label + a disambiguating sub-line). */
export interface MentionResult extends Mention {
	sublabel: string;
}

export const mentionSchema = z.object({
	id: z.string(),
	type: z.enum(MENTION_TYPES),
	label: z.string(),
});

export const mentionsSchema = z.array(mentionSchema).max(20).optional();

/**
 * Render the @-referenced resources as a compact system-prompt block so the model
 * knows exactly what each reference points to — its id, type, and the read tool to
 * resolve it with. Returns "" when there are no mentions.
 */
export function formatMentionsForPrompt(mentions: Mention[] | undefined): string {
	if (!mentions || mentions.length === 0) return "";
	const lines = mentions.map(
		(m) =>
			`- @${m.label} → ${m.type} id="${m.id}" (resolve with ${MENTION_TOOL[m.type]})`,
	);
	return [
		"The user referenced these resources with @mentions in their latest message.",
		"Treat each @name as pointing to the exact resource below — do not guess; use the",
		"named id with the matching read tool before acting:",
		...lines,
	].join("\n");
}
