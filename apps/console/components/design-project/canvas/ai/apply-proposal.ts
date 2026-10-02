// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { toast } from "sonner";
import { isCloudProviderSlug } from "@/lib/cloud-providers/provider-slug";
import type { AiProposalParsed } from "@/lib/ai/proposal";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** Applies an accepted proposal's actions onto the canvas store. */
export function applyProposal(proposal: AiProposalParsed): void {
	const store = useCanvasStore.getState();
	for (const action of proposal.actions) {
		if (action.kind === "add_node") {
			store.addNodeWithConfig(
				action.nodeKind,
				action.config,
				action.cloudIdentityId ?? null,
			);
		} else if (action.kind === "set_identity") {
			const found = store.identities.find(
				(i) => i.id === action.cloudIdentityId,
			)?.provider;
			const provider = found && isCloudProviderSlug(found) ? found : null;
			// A cluster moved to another cloud has its pinned machine type mapped (or defaulted)
			// there, and the user is TOLD — a silent swap of the machine is its own surprise (#5269).
			for (const w of store.setNodeIdentity(action.nodeId, action.cloudIdentityId, provider)) {
				toast.warning(w.message);
			}
		} else if (action.kind === "update_config") {
			store.updateNodeConfig(action.nodeId, action.patch);
		} else if (action.kind === "remove_node") {
			store.removeNodes([action.nodeId]);
		}
	}
}
