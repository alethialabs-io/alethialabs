// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CanvasNode } from "./types";

/**
 * Projects the canvas graph onto the ProjectFormData shape so it persists through the
 * SAME `createProject` the form uses. Returns a plain object validated by
 * `projectFormSchema.safeParse` at save time (missing required nodes surface there).
 *
 * A component carries its own `cloud_identity_id` only when the node diverges from
 * the project CORE; otherwise the field is omitted and Milestone-1 resolution
 * inherits the project's primary identity.
 */
export function graphToForm(nodes: CanvasNode[]): Record<string, unknown> {
	const first = (kind: CanvasNode["data"]["kind"]) =>
		nodes.find((n) => n.data.kind === kind);

	const placement = (n?: CanvasNode) =>
		n?.data.cloud_identity_id
			? { cloud_identity_id: n.data.cloud_identity_id }
			: {};

	const ofKind = (kind: CanvasNode["data"]["kind"]) =>
		nodes
			.filter((n) => n.data.kind === kind)
			.map((n) => ({ ...n.data.config, ...placement(n) }));

	const project = first("project");
	const network = first("network");
	const cluster = first("cluster");
	const dns = first("dns");
	const repositories = first("repositories");

	// Source repos ride on the project-root config; lift them back to the top level so
	// they don't leak into the `project` sub-schema (which would strip them).
	const projectConfig: Record<string, unknown> = { ...(project?.data.config ?? {}) };
	const source_repos = Array.isArray(projectConfig.source_repos)
		? projectConfig.source_repos
		: [];
	delete projectConfig.source_repos;

	return {
		project: {
			...projectConfig,
			cloud_identity_id: project?.data.cloud_identity_id ?? "",
		},
		network: network
			? { ...network.data.config, ...placement(network) }
			: undefined,
		cluster: cluster
			? { ...cluster.data.config, ...placement(cluster) }
			: undefined,
		dns: dns ? { ...dns.data.config, ...placement(dns) } : { enabled: false },
		repositories: repositories?.data.config ?? {},
		source_repos,
		databases: ofKind("database"),
		caches: ofKind("cache"),
		queues: ofKind("queue"),
		topics: ofKind("topic"),
		nosql_tables: ofKind("nosql"),
		secrets: ofKind("secret"),
	};
}
