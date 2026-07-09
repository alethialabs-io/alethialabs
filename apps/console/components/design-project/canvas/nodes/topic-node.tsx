"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Pub/sub topic node. */
export function TopicNode({ id, data, selected }: NodeProps<CanvasNode<"topic">>) {
	const c = data.config;
	const subs = c.subscriptions?.length ?? 0;
	return (
		<BaseNode
			id={id}
			title={c.name || "topic"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				{subs} subscription{subs === 1 ? "" : "s"}
			</div>
		</BaseNode>
	);
}
