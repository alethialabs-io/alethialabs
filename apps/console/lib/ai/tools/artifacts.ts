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
 * Saved-artifact tools (in-app only): artifacts are named, org-scoped widget/dashboard
 * specs the user promoted from a chat's grid; any later chat can @-reference, load, and
 * edit them. `update_artifact` writes server-side (precedent: scan_repo's in-app write)
 * — the blast radius is a display spec, org-scoped by RLS, so no HITL pause; the client
 * lane syncs open widgets after the edit.
 */
export function artifactTools() {
	return {
		list_artifacts: tool({
			description:
				"List the org's saved artifacts (named widget/dashboard specs promoted from chat grids). PDP/RLS-scoped read.",
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
				"Load one saved artifact by id or exact name — returns its full widget spec so you can discuss or edit it. Use when the user @-references an artifact. PDP/RLS-scoped read.",
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
				"Replace a saved artifact's spec (widgets + layout) after the user asked you to edit it. Load it with get_artifact first, modify the spec (same schema as pin_widget blocks/sources + position/size), and write it back whole. Org-scoped; display data only.",
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
