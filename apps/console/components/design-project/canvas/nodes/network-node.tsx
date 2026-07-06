"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** VPC / VNet node. */
export function NetworkNode({ id, data, selected }: NodeProps<CanvasNode>) {
	const c = data.config;
	const provision = c.provision_network !== false;
	return (
		<BaseNode id={id} title="Network" selected={selected} handles={{ source: true }}>
			<div className="font-mono text-[10px] text-muted-foreground">
				{provision
					? `new · ${(c.cidr_block as string) ?? "10.0.0.0/16"}`
					: `existing · ${(c.network_id as string) || "—"}`}
			</div>
		</BaseNode>
	);
}
