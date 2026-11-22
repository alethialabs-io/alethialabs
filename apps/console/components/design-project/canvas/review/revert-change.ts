// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Taking ONE pending change back (#6833): the per-row discard of the review view.
//
// Each revert is one undo step, made through the document's own actions, so it is recorded,
// persisted and undone like any other edit — and it changes the draft, which makes a plan computed
// before it stale by the same rule as any other edit.

import type { Board } from "@/lib/canvas/store/board";
import { placeNodes } from "@/lib/canvas/store/document-store";
import type { FieldChange } from "@/lib/canvas/store/types";

/**
 * Reverts one row of the changes list:
 * - a new card is removed;
 * - a removed card is put back as it was saved, where it was;
 * - a changed field takes its saved value again (a field the saved design did not have is unset);
 * - a re-placement returns the card to the cloud account it was saved on.
 *
 * A row whose card is no longer where the row says (already reverted, or undone) does nothing.
 */
export function revertChange(board: Board, change: FieldChange): void {
	const document = board.document.getState();
	const saved = document.baseline.find((n) => n.id === change.id);

	if (change.op === "new") {
		if (document.removeNodes([change.id]).length === 0) return;
		const view = board.view.getState();
		view.setSelection(view.selection.filter((id) => id !== change.id));
		return;
	}

	if (change.op === "removed") {
		if (!saved || document.designNodes.some((n) => n.id === change.id)) return;
		document.transact("restore", () => {
			const now = board.document.getState();
			// The design is held without positions, so each card is handed back at its place: the
			// replace writes every position it is given.
			now.replaceNodes([...placeNodes(now.designNodes, now.positions), saved]);
		});
		return;
	}

	if (!saved || change.field === null) return;
	if (change.field === "cloud_identity_id") {
		document.setNodeIdentity(
			change.id,
			saved.data.cloud_identity_id,
			saved.data.provider,
		);
		return;
	}
	document.updateNodeConfig(change.id, { [change.field]: change.before });
}
