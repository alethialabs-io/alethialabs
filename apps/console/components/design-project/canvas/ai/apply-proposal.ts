// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { toast } from "sonner";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import type { AiProposalParsed } from "@/lib/ai/proposal";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { applySizingOneWriter } from "@/lib/cloud-providers/node-sizing";
import { activeBoardActions, activeCanvas } from "@/lib/canvas/store/active-canvas";
import { nodeIndex } from "@/lib/canvas/store/use-board";

/**
 * A proposal's config patch under the cluster one-writer rule (#5267, #5291): on a cluster, a patch
 * setting `node_size` also clears `instance_types`, and one pinning a type also clears `node_size` —
 * exactly what the inspector and the CLI write. A patch naming both is refused with a toast and
 * skipped (null), as the CLI refuses it. Patches to any other kind pass through unchanged.
 */
function sizedPatch(
	nodeId: string,
	patch: Record<string, unknown>,
): Record<string, unknown> | null {
	const node = nodeIndex(activeCanvas().board.document.getState().designNodes).get(nodeId);
	if (node?.data.kind !== "cluster") return patch;
	const result = applySizingOneWriter(patch);
	if (!result.ok) {
		toast.error(result.error);
		return null;
	}
	// The rule clears a size with `null` (the CLI upserts, so it must be explicit); the canvas holds
	// "no size" as an absent value, which is what the inspector writes.
	if (!("node_size" in result.values)) return result.values;
	return { ...result.values, node_size: result.values.node_size ?? undefined };
}

/**
 * Applies an accepted proposal's actions onto the board on screen. The assistant panel is not drawn
 * inside the workbench, so the board comes from `activeCanvas()` rather than from context.
 */
export function applyProposal(proposal: AiProposalParsed): void {
	const { board, identities } = activeCanvas();
	const actions = activeBoardActions();
	for (const action of proposal.actions) {
		if (action.kind === "add_node") {
			actions.addNodeWithConfig(
				action.nodeKind,
				action.config,
				action.cloudIdentityId ?? null,
			);
		} else if (action.kind === "set_identity") {
			const found = identities.find(
				(i) => i.id === action.cloudIdentityId,
			)?.provider;
			const provider = found && isCloudProviderSlug(found) ? found : null;
			// A cluster moved to another cloud has its pinned machine type mapped (or defaulted)
			// there, and the user is TOLD — a silent swap of the machine is its own surprise (#5269).
			const moved = board.document
				.getState()
				.setNodeIdentity(action.nodeId, action.cloudIdentityId, provider);
			for (const w of moved) {
				toast.warning(w.message);
			}
		} else if (action.kind === "update_config") {
			const patch = sizedPatch(action.nodeId, action.patch);
			if (patch) board.document.getState().updateNodeConfig(action.nodeId, patch);
		} else if (action.kind === "remove_node") {
			actions.removeNodes([action.nodeId]);
		}
	}
}
