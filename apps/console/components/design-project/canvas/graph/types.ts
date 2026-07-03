// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Edge, Node } from "@xyflow/react";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

/**
 * Node kinds in the Milestone-2a canvas slice. "project" is the fixed root that
 * carries the project basics (name/region/environment) and the CORE cloud
 * identity every other node inherits from.
 */
export type NodeKind =
	| "project"
	| "cluster"
	| "network"
	| "database"
	| "dns"
	| "cache"
	| "queue"
	| "topic"
	| "nosql"
	| "secret"
	| "repositories";

/**
 * Data carried on every React Flow node. `config` is the resource configuration
 * shaped to its matching ProjectFormData fragment; `cloud_identity_id` is the node's
 * own placement (null = inherit the project root's CORE identity). `provider` is
 * derived from the effective identity and used only for UI/option-table lookups.
 */
export type CanvasNodeData = {
	kind: NodeKind;
	config: Record<string, unknown>;
	cloud_identity_id: string | null;
	provider: CloudProviderSlug | null;
};

export type CanvasNode = Node<CanvasNodeData>;
export type CanvasEdge = Edge;
