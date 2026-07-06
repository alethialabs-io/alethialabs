"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Fixed root node carrying the project basics + the stack's CORE cloud identity. */
export function ProjectNode({ id, data, selected }: NodeProps<CanvasNode>) {
	const c = data.config;
	const name = (c.project_name as string) || "Untitled project";
	return (
		<BaseNode id={id} title={name} selected={selected} handles={{ source: true }}>
			<div className="font-mono text-[10px] text-muted-foreground">
				{(c.environment_stage as string) ?? "development"}
				{c.region ? ` · ${c.region as string}` : ""}
			</div>
		</BaseNode>
	);
}
