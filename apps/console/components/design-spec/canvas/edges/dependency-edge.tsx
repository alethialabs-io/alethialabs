"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BaseEdge, getSmoothStepPath, type EdgeProps } from "@xyflow/react";

/** Solid hairline dependency edge (network→cluster, cluster→resource). */
export function DependencyEdge({
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	markerEnd,
}: EdgeProps) {
	const [path] = getSmoothStepPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});
	return (
		<BaseEdge
			path={path}
			markerEnd={markerEnd}
			style={{ stroke: "var(--border, #d4d4d4)", strokeWidth: 1.5 }}
		/>
	);
}
