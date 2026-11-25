// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default dependencies of the MCP design tools (lib/ai/mcp/design.ts): the server actions the
// canvas and the CLI design route write through, and the revision and key reads of
// lib/ai/mcp/design-store.ts.

import "server-only";
import { getProjectAsFormData, tryCreateProject, updateProjectDesign } from "@/app/server/actions/projects";
import { CredentialKnobRefusedError } from "@/lib/cloud-providers/credential-knobs";
import { CloudIdentityRefusedError } from "@/lib/cloud-providers/design-identities";
import { resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";
import type { DesignDeps } from "./design";
import { designKeyHash, findKeyedDesignWrite, findProjectByName, readDesignRevision } from "./design-store";

/** The default design dependencies. */
export const defaultDesignDeps: DesignDeps = {
	readDesign: async (projectId, environmentId) => (await getProjectAsFormData(projectId, environmentId)).formData,
	designRevision: readDesignRevision,
	findKeyedWrite: findKeyedDesignWrite,
	findProjectByName,
	keyHash: designKeyHash,
	writeDesign: async ({ projectId, environmentId, design, keyHash }) => {
		// Reached only after `readDesign` authorized the caller for the project.
		const target = await resolveCliWriteEnvironment(projectId, environmentId);
		if (!target.ok) return { ok: false, error: "That environment was not found in this project." };
		try {
			await updateProjectDesign(projectId, target.id, design, { idempotencyKey: keyHash });
			return { ok: true, value: null };
		} catch (err) {
			// The two refusals a caller can act on name the component and key, or where in the design,
			// and never a secret value. Anything else is a fault, not advice.
			if (err instanceof CredentialKnobRefusedError || err instanceof CloudIdentityRefusedError) {
				return { ok: false, error: err.message };
			}
			throw err;
		}
	},
	createProject: async ({ design, keyHash }) => {
		const created = await tryCreateProject(design, { idempotencyKey: keyHash });
		return created.ok ? { ok: true, value: { projectId: created.project.id } } : { ok: false, error: created.error };
	},
};
