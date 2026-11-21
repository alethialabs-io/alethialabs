// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The board on screen, for code that is not drawn inside it (#7129).
//
// The assistant panel is docked in the app shell, outside the workbench, so React context cannot
// reach it: it reads the board when a message is sent (`snapshotCanvas`), shows a proposal against
// it (`ProposalDiff`) and applies an accepted one (`applyProposal`). This holds WHICH board that is,
// with the identity list and the out-of-band cards the workbench already holds for it.
//
// It is not a copy for the board to read. Nothing on the board reads it, nothing derives from it,
// nothing persists it, and its value is the very objects the workbench's providers hold — the same
// arrays, not a rebuilt list — so it cannot disagree with what the board draws. When the board
// unmounts, it goes back to the board outside any workbench.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { board, type Board } from "./board";
import { boardActions, type BoardActions } from "./board-actions";

/** The board on screen and the server data its workbench holds for it. */
export interface ActiveCanvas {
	board: Board;
	identities: readonly CloudIdentityOption[];
	/** The cards the design does not own, as the workbench built them from their queries. */
	others: CanvasNode[];
}

/** No board on screen: the board outside any workbench, with nothing beside it. */
const OUTSIDE: ActiveCanvas = { board, identities: [], others: [] };

const active = createStore<ActiveCanvas>()(() => OUTSIDE);

/** The board on screen right now. For a handler that runs on an event, not during render. */
export function activeCanvas(): ActiveCanvas {
	return active.getState();
}

/** The board on screen right now, with its commands bound. */
export function activeBoardActions(): BoardActions {
	const { board: current, others, identities } = active.getState();
	return boardActions(current, others, identities);
}

/** The board on screen, as a component outside the workbench reads it: re-rendered when it changes. */
export function useActiveCanvas(): ActiveCanvas {
	return useStore(active);
}

/**
 * Name `value` as the board on screen. Returns the call that takes it back down, which restores
 * the board outside any workbench only if `value` is still the one named — so an unmount that runs
 * after the next board mounted cannot take that one down.
 */
export function publishActiveCanvas(value: ActiveCanvas): () => void {
	active.setState(value, true);
	return () => {
		if (active.getState() === value) active.setState(OUTSIDE, true);
	};
}
