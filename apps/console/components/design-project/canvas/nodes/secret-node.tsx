"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Secret node (periphery). */
export function SecretNode({ id, data, selected }: NodeProps<CanvasNode>) {
	const c = data.config;
	return (
		<BaseNode
			id={id}
			title={(c.name as string) || "secret"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				{c.generate ? `generated · ${(c.length as number) ?? 32} chars` : "manual"}
			</div>
		</BaseNode>
	);
}
