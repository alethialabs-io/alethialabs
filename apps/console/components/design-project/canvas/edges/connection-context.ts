"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createContext, useContext } from "react";

/** What an edge can ask of the board it is drawn on. */
export interface BoardConnections {
	/** Remove the binding or bindings the edge with this id stands for, as one undo step. */
	remove: (edgeId: string) => void;
}

/** The board's connection commands. Provided by `CanvasFlow`; a no-op anywhere else. */
export const BoardConnectionsContext = createContext<BoardConnections>({ remove: () => {} });

/** The connection commands of the board in scope. */
export function useBoardConnections(): BoardConnections {
	return useContext(BoardConnectionsContext);
}
