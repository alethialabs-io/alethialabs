// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The nodes the board's own tests (#6835) need beyond the shared canvas fixtures: a bucket (a card
// nothing connects to), a queue, and secrets (the kind that collapses into the vault).

import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";

/** A storage bucket named `name`. */
export function bucketNode(name: string): CanvasNode {
	return {
		id: `bucket-${name}`,
		type: "bucket",
		position: { x: 560, y: 340 },
		data: {
			kind: "bucket",
			config: { ...NODE_REGISTRY.bucket.defaultData("aws"), name },
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** A secret named `name`. */
export function secretNode(name: string): CanvasNode {
	return {
		id: `secret-${name}`,
		type: "secret",
		position: { x: 780, y: 340 },
		data: {
			kind: "secret",
			config: { ...NODE_REGISTRY.secret.defaultData("aws"), name },
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/**
 * The project root on AWS, from the registry's own defaults. The shared fixture's root has no
 * cloud; a test that reads a card's STATUS wants a design the project schema accepts.
 */
export function awsProjectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		deletable: false,
		data: {
			kind: "project",
			config: NODE_REGISTRY.project.defaultData("aws"),
			cloud_identity_id: null,
			provider: "aws",
		},
	};
}

/** A database named `name` on AWS, complete by the registry's defaults: it reads as Ready. */
export function awsDatabaseNode(name: string): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 120, y: 340 },
		data: {
			kind: "database",
			config: { ...NODE_REGISTRY.database.defaultData("aws"), name },
			cloud_identity_id: null,
			provider: "aws",
		},
	};
}
