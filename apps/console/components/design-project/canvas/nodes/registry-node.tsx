"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import { getProvider } from "@/lib/cloud-providers";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Container-registry node (periphery). */
export function RegistryNode({
	id,
	data,
	selected,
}: NodeProps<CanvasNode<"registry">>) {
	const c = data.config;
	// The effective cloud's registry service name (ECR / Artifact Registry / ACR / …).
	const service = data.provider
		? getProvider(data.provider).registryService
		: "container registry";
	return (
		<BaseNode
			id={id}
			title={c.name || "registry"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">{service}</div>
		</BaseNode>
	);
}
