// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hand-built canvas nodes for the canvas safety-net tests (#6762).
//
// Every node here is written out as a literal that the `CanvasNode` union type-checks, so a test
// that uses one is not exercising `formToGraph`, the node registry's defaults or the store's
// `addNode` on the way to the thing it measures. Ids follow the form-derived convention
// (`${kind}-${name}`) the saved design produces.

import type {
	CanvasNode,
	NodeConfigMap,
} from "@/components/design-project/canvas/graph/types";
import { PROJECT_NODE_ID } from "@/lib/stores/use-canvas-store";

/** The project root, with no cloud identity chosen. */
export function projectNode(): CanvasNode {
	return {
		id: PROJECT_NODE_ID,
		type: "project",
		position: { x: 0, y: 0 },
		deletable: false,
		data: {
			kind: "project",
			config: {
				project_name: "Acme Shop",
				environment_stage: "production",
				region: "eu-central-1",
				iac_version: "1.11.4",
			},
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** A database named `name`, listening on `port`. */
export function databaseNode(name: string, port = 5432): CanvasNode {
	return {
		id: `database-${name}`,
		type: "database",
		position: { x: 120, y: 340 },
		data: {
			kind: "database",
			config: { name, engine_family: "postgres", port, iam_auth: false },
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** A cache named `name`. */
export function cacheNode(name: string): CanvasNode {
	return {
		id: `cache-${name}`,
		type: "cache",
		position: { x: 340, y: 340 },
		data: {
			kind: "cache",
			config: { name, engine: "redis", num_cache_nodes: 1, multi_az: false },
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** A service named `name` carrying `bindings`. */
export function serviceNode(
	name: string,
	bindings: NodeConfigMap["service"]["bindings"],
): CanvasNode {
	return {
		id: `service-${name}`,
		type: "service",
		position: { x: 120, y: 600 },
		data: {
			kind: "service",
			config: {
				name,
				type: "deployment",
				source: { kind: "image", image: `ghcr.io/acme/${name}:1` },
				env: [],
				ports: [],
				bindings,
			},
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** An attached bring-your-own chart (out-of-band), as the board draws it: `chart-${id}`. */
export function chartNode(id: string): CanvasNode {
	return {
		id: `chart-${id}`,
		type: "chart",
		position: { x: 900, y: 160 },
		deletable: false,
		data: {
			kind: "chart",
			config: {
				id,
				repoUrl: "https://github.com/acme/charts",
				chartPath: `charts/${id}`,
				ref: "main",
				namespace: "default",
			},
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** A described workload of chart `chartId` (out-of-band), carrying `bindings`: `cw-${id}`. */
export function chartWorkloadNode(
	id: string,
	chartId: string,
	bindings: NodeConfigMap["chart_workload"]["bindings"],
): CanvasNode {
	return {
		id: `cw-${id}`,
		type: "chart_workload",
		position: { x: 940, y: 310 },
		deletable: false,
		data: {
			kind: "chart_workload",
			config: {
				id,
				chartId,
				name: "web",
				kind: "deployment",
				rendered: { image: "ghcr.io/acme/web:1", ports: [], env_keys: [] },
				bindings,
				config: {},
				valuePaths: {},
			},
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** An installed marketplace add-on (out-of-band): `addon-${id}`. */
export function addonNode(id: string, version = "8.1.2"): CanvasNode {
	return {
		id: `addon-${id}`,
		type: "addon",
		position: { x: 120, y: 520 },
		deletable: false,
		data: {
			kind: "addon",
			config: { id, name: id, version, namespace: "monitoring" },
			cloud_identity_id: null,
			provider: null,
		},
	};
}

/** One card of a bring-your-own IaC module (out-of-band): `external-${key}`. */
export function externalNode(key: string): CanvasNode {
	return {
		id: `external-${key}`,
		type: "external",
		position: { x: 120, y: 340 },
		deletable: false,
		data: {
			kind: "external",
			config: { key, mappedKind: "database", module: "", source: "scan", members: [] },
			cloud_identity_id: null,
			provider: null,
		},
	};
}
