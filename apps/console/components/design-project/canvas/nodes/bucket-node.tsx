"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NodeProps } from "@xyflow/react";
import type { CanvasNode } from "../graph/types";
import { BaseNode } from "./base-node";

/** Object-storage bucket node (periphery). */
export function BucketNode({ id, data, selected }: NodeProps<CanvasNode<"bucket">>) {
	const c = data.config;
	const traits = [
		c.versioning ? "versioned" : null,
		c.encryption_enabled !== false ? "encrypted" : null,
		c.public_access ? "public" : "private",
	].filter(Boolean);
	return (
		<BaseNode
			id={id}
			title={c.name || "bucket"}
			selected={selected}
			handles={{ target: true }}
		>
			<div className="font-mono text-[10px] text-muted-foreground">
				{traits.join(" · ")}
			</div>
		</BaseNode>
	);
}
