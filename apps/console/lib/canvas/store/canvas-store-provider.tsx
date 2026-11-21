"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How the shell reaches the board's stores, and the server data the board reads beside them
// (#6764, #7129).
//
// Each project:environment has its own board (`boardFor`): the provider publishes the one for its
// scope. The identity list and the cards the design does not own are server data. They are handed
// down — the identity list from the page as a prop, the out-of-band cards from their queries
// (`use-board-sources.ts`) — and read from context. Neither is copied into a store, so there is no
// effect keeping a copy in step and no moment at which the copy is stale.

import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { publishActiveCanvas } from "./active-canvas";
import { board, boardFor, type Board } from "./board";

/** What the provider publishes. */
interface CanvasStoreContextValue {
	board: Board;
	/** The project:environment the board is drafting, or null outside a workbench. */
	scope: string | null;
	identities: readonly CloudIdentityOption[];
}

const NO_IDENTITIES: readonly CloudIdentityOption[] = [];

const CanvasStoreContext = createContext<CanvasStoreContextValue>({
	board,
	scope: null,
	identities: NO_IDENTITIES,
});

/**
 * Publishes the board of one project:environment, with the identity list the page read. Mounted
 * by the workbench around everything that draws or edits the design.
 */
export function CanvasStoreProvider({
	scope,
	identities,
	children,
}: {
	scope: string;
	identities: readonly CloudIdentityOption[];
	children: ReactNode;
}) {
	const value = useMemo(() => ({ board: boardFor(scope), scope, identities }), [scope, identities]);
	return <CanvasStoreContext.Provider value={value}>{children}</CanvasStoreContext.Provider>;
}

/** The board in scope: its document store, its view store and its commands. */
export function useBoard(): Board {
	return useContext(CanvasStoreContext).board;
}

/** The project:environment the board in scope is drafting, or null outside a workbench. */
export function useBoardScope(): string | null {
	return useContext(CanvasStoreContext).scope;
}

/** The verified cloud identities the page read, for label and provider lookup. */
export function useIdentities(): readonly CloudIdentityOption[] {
	return useContext(CanvasStoreContext).identities;
}

/** The server data drawn on the board beside the design. */
interface BoardSourcesValue {
	/** The cards the design does not own: charts, workloads, add-ons, a module's resources. */
	others: CanvasNode[];
	/** The BYO-IaC module's root output names: the choices a service binding offers. */
	iacOutputs: string[];
}

const NO_NODES: CanvasNode[] = [];
const NO_OUTPUTS: string[] = [];

const BoardSourcesContext = createContext<BoardSourcesValue>({
	others: NO_NODES,
	iacOutputs: NO_OUTPUTS,
});

/**
 * Publishes the cards the design does not own and the module's output names, as the canvas built
 * them from their queries, to everything drawn on the board. It also names this board as the one on
 * screen (`active-canvas.ts`) for the assistant panel, which is not drawn inside it.
 *
 * Pass stable arrays (the `useMemo` results of `useOutOfBandNodes` and `useIacOutputs`).
 */
export function BoardSourcesProvider({
	others,
	iacOutputs,
	children,
}: {
	others: CanvasNode[];
	iacOutputs: string[];
	children: ReactNode;
}) {
	const current = useBoard();
	const identities = useIdentities();
	const value = useMemo(() => ({ others, iacOutputs }), [others, iacOutputs]);
	useEffect(
		() => publishActiveCanvas({ board: current, identities, others }),
		[current, identities, others],
	);
	return <BoardSourcesContext.Provider value={value}>{children}</BoardSourcesContext.Provider>;
}

/** The cards the design does not own. Empty outside a `BoardSourcesProvider`. */
export function useOthers(): CanvasNode[] {
	return useContext(BoardSourcesContext).others;
}

/** The BYO-IaC module's root output names. Empty outside a `BoardSourcesProvider`. */
export function useBoardIacOutputs(): string[] {
	return useContext(BoardSourcesContext).iacOutputs;
}
