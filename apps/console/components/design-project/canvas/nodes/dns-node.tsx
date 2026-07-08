"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** DNS node (periphery — may sit on any vendor). */
export function DnsNode({ id, data, selected }: NodeProps<CanvasNode<"dns">>) {
	const c = data.config;
	return (
		<BaseNode id={id} title="DNS" selected={selected} handles={{ target: true }}>
			<div className="font-mono text-[10px] text-muted-foreground">
				{c.domain_name || "no domain"}
				{c.provider ? ` · ${c.provider}` : ""}
			</div>
		</BaseNode>
	);
}
