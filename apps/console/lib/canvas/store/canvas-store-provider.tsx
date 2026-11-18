"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// How the shell reaches the board's stores, and the server data the board reads beside them
// (#6764).
//
// The identity list is server data. It is handed down from the page as a prop and read from this
// context — it is not copied into a store, so there is no effect keeping a copy in step and no
// moment at which the copy is stale.

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { board, type Board } from "./board";

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
 * Publishes the board for one project:environment, with the identity list the page read. Mounted
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
	const value = useMemo(() => ({ board, scope, identities }), [scope, identities]);
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
