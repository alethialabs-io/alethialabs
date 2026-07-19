"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow } from "@xyflow/react";
import { useCallback } from "react";

/**
 * W5 — where a newly-added node should land: the current viewport centre, in flow coordinates. This
 * replaces the old blind cascade offset (`{x: 120 + count*48, …}`) so an added node appears where the
 * user is looking rather than off in a corner. Must be called inside a ReactFlowProvider.
 */
export function useDropPosition(): () => { x: number; y: number } {
	const { screenToFlowPosition } = useReactFlow();
	return useCallback(
		() =>
			screenToFlowPosition({
				x: window.innerWidth / 2,
				y: window.innerHeight / 2,
			}),
		[screenToFlowPosition],
	);
}
