// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
			const provider = action.cloudIdentityId
				? ((store.identities.find((i) => i.id === action.cloudIdentityId)
						?.provider as CloudProviderSlug) ?? null)
				: null;
			store.setNodeIdentity(action.nodeId, action.cloudIdentityId, provider);
		} else if (action.kind === "update_config") {
			store.updateNodeConfig(action.nodeId, action.patch);
		}
	}
}
