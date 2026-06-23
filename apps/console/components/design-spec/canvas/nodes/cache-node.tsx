"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Managed cache node. */
export function CacheNode({ id, data, selected }: NodeProps<CanvasNode>) {
	const c = data.config;
	return (
		<BaseNode
			id={id}
			title={(c.name as string) || "cache"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				{(c.engine as string) ?? "redis"}
				{c.node_type ? ` · ${c.node_type as string}` : ""}
			</div>
		</BaseNode>
	);
}
