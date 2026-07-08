"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** NoSQL table node. */
export function NosqlNode({ id, data, selected }: NodeProps<CanvasNode<"nosql">>) {
	const c = data.config;
	return (
		<BaseNode
			id={id}
			title={c.name || "table"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				pk: {c.partition_key || "id"}
				{c.sort_key ? ` · sk: ${c.sort_key}` : ""}
			</div>
		</BaseNode>
	);
}
