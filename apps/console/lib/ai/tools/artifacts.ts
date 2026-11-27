// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { tool } from "ai";
import { z } from "zod";
import {
	getArtifact,
	listArtifacts,
	updateArtifact,
} from "@/app/server/actions/artifacts";
import { artifactSpecSchema } from "@/lib/ai/artifact-spec";

/**
 * Saved-artifact tools (in-app only): artifacts are named widget/dashboard specs the user
 * promoted from a chat's grid, PRIVATE to that user (app/server/actions/artifacts.ts reads them
 * under withOwnerScope; sharing goes through the separate shares ACL, which these tools do not
 * read). Any later chat of the same user can @-reference, load, and edit them. `update_artifact`
 * writes server-side (precedent: scan_repo's in-app write) — the blast radius is the caller's own
 * display spec, owner-scoped by RLS, so no HITL pause; the client lane syncs open widgets after
 * the edit. The descriptions below say "the user's own" because they once said "the org's", which
 * told the model teammates could see an artifact that only its creator can.
 */
export function artifactTools() {
	return {
		list_artifacts: tool({
			description:
				"List the user's own saved artifacts (named widget/dashboard specs they promoted from chat grids). Artifacts are private to their creator; artifacts teammates shared are not listed here. RLS-scoped read.",
			inputSchema: z.object({}),
			execute: async () => {
				const rows = await listArtifacts();
				return {
					artifacts: rows.map((a) => ({
						id: a.id,
						name: a.name,
						kind: a.kind,
						widgets: a.spec.widgets.length,
						updated_at: a.updated_at,
					})),
				};
			},
		}),

		get_artifact: tool({
			description:
				"Load one of the user's own saved artifacts by id or exact name — returns its full widget spec so you can discuss or edit it. Use when the user @-references an artifact. RLS-scoped read.",
			inputSchema: z.object({ idOrName: z.string() }),
			execute: async ({ idOrName }) => {
				const a = await getArtifact(idOrName);
				if (!a) return { found: false };
				return {
					found: true,
					id: a.id,
					name: a.name,
					kind: a.kind,
					spec: a.spec,
				};
			},
		}),

		update_artifact: tool({
			description:
				"Replace a saved artifact's spec (widgets + layout) after the user asked you to edit it. Load it with get_artifact first, modify the spec (same schema as pin_widget blocks/sources + position/size), and write it back whole in the SAME turn. The user's edit request is the go-ahead: do not stop to ask for confirmation. An 'add a widget' request adds one, even when a similar widget is already in the artifact (the user can remove it); keep every existing widget unless they asked to change or remove it. Only the user's own artifacts; display data only.",
			inputSchema: z.object({
				artifactId: z.string().uuid(),
				spec: artifactSpecSchema,
			}),
			execute: async ({ artifactId, spec }) => {
				const updated = await updateArtifact(artifactId, spec);
				return updated
					? { updated: true, id: updated.id, widgets: updated.spec.widgets.length }
					: { updated: false };
			},
		}),
	};
}
