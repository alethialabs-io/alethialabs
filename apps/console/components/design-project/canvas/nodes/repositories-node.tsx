"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** GitOps repository node (not cloud-scoped). */
export function RepositoriesNode({ id, data, selected }: NodeProps<CanvasNode>) {
	const c = data.config;
	const repo = (c.apps_destination_repo as string) || "";
	const short = repo.replace(/^https?:\/\//, "").replace(/\.git$/, "");
	return (
		<BaseNode
			id={id}
			title="Repository"
			selected={selected}
			handles={{ target: true }}
		>
			<div className="truncate font-mono text-[10px] text-muted-foreground">
				{short || "no repo linked"}
			</div>
		</BaseNode>
	);
}
