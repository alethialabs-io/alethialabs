"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Managed database node. */
export function DatabaseNode({ id, data, selected }: NodeProps<CanvasNode>) {
	const c = data.config;
	return (
		<BaseNode
			id={id}
			title={(c.name as string) || "database"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				{(c.engine as string) ?? "—"}
				{c.engine_version ? ` ${c.engine_version as string}` : ""}
			</div>
		</BaseNode>
	);
}
