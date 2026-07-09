"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Kubernetes cluster node. */
export function ClusterNode({ id, data, selected }: NodeProps<CanvasNode<"cluster">>) {
	const c = data.config;
	const instances = c.instance_types ?? [];
	return (
		<BaseNode
			id={id}
			title="Cluster"
			selected={selected}
			handles={{ source: true, target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				k8s {c.cluster_version ?? "—"}
				{instances[0] ? ` · ${instances[0]}` : ""}
			</div>
			<div className="font-mono text-[10px] text-muted-foreground">
				nodes {c.node_min_size ?? 2}–{c.node_max_size ?? 5}
			</div>
		</BaseNode>
	);
}
