// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID } from "@/lib/stores/use-canvas-store";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import { configName } from "./node-config";
import type { CanvasNode, CanvasNodeData, NodeConfigMap, NodeKind } from "./types";

/**
 * Seeds the canvas from a ProjectFormData object (initial mount / source project / the
 * form→canvas bridge). Each component becomes a node; per-component
 * `cloud_identity_id` (if any) is carried as the node's own placement, otherwise
 * the node inherits the project CORE. Layout is a simple project→core→leaf tree.
 */
export function formToGraph(
	form: ProjectFormData,
	identities: CloudIdentityOption[],
): { nodes: CanvasNode[] } {
	const providerOf = (id?: string | null): CloudProviderSlug | null =>
		id
			? ((identities.find((i) => i.id === id)?.provider as CloudProviderSlug) ??
				null)
			: null;

	const coreId = form.project.cloud_identity_id || null;

	const makeNode = <K extends NodeKind>(
		kind: K,
		config: NodeConfigMap[K],
		position: { x: number; y: number },
		ownIdentity?: string | null,
	): CanvasNode => {
		const own = ownIdentity ?? null;
		// The kind↔config correlation can't be carried into the union type for a generic
		// K, so the assembled data asserts its membership (both come from the same K).
		const data = {
			kind,
			config,
			cloud_identity_id: own,
			provider: providerOf(own ?? coreId),
		} as CanvasNodeData;
		return {
			id:
				kind === "project"
					? PROJECT_NODE_ID
					: `${kind}-${configName(data) ?? kind}`,
			type: kind,
			position,
			deletable: kind !== "project",
			data,
		};
	};

	const nodes: CanvasNode[] = [
		makeNode(
			"project",
			{
				project_name: form.project.project_name,
				environment_stage: form.project.environment_stage,
				region: form.project.region,
				iac_version: form.project.iac_version,
				// Scanned source repos (1:N) ride on the project root — not their own nodes —
				// so they survive the canvas round-trip and reach createProject.
				source_repos: form.source_repos ?? [],
			},
			{ x: 260, y: 0 },
			coreId,
		),
	];

	const ownOf = (c: { cloud_identity_id?: string | null }) =>
		c.cloud_identity_id && c.cloud_identity_id !== coreId
			? c.cloud_identity_id
			: null;

	if (form.network)
		nodes.push(
			makeNode("network", { ...form.network }, { x: 60, y: 180 }, ownOf(form.network)),
		);
	if (form.cluster)
		nodes.push(
			makeNode("cluster", { ...form.cluster }, { x: 360, y: 180 }, ownOf(form.cluster)),
		);
	if (form.dns?.enabled)
		nodes.push(makeNode("dns", { ...form.dns }, { x: 680, y: 180 }, ownOf(form.dns)));
	if (form.repositories?.apps_destination_repo)
		nodes.push(
			makeNode("repositories", { ...form.repositories }, { x: 900, y: 180 }),
		);

	// Array kinds laid out in rows below the cluster. Each call correlates the literal
	// kind with its matching item array, so `makeNode` stays fully typed per kind.
	const pushItems = <
		K extends
			| "database"
			| "cache"
			| "queue"
			| "topic"
			| "nosql"
			| "secret"
			| "bucket"
			| "registry"
			| "service",
	>(
		kind: K,
		items: NodeConfigMap[K][],
		rowIdx: number,
	) => {
		items.forEach((item, i) => {
			nodes.push(
				makeNode(kind, item, { x: 120 + i * 220, y: 340 + rowIdx * 130 }, ownOf(item)),
			);
		});
	};
	pushItems("database", form.databases ?? [], 0);
	pushItems("cache", form.caches ?? [], 1);
	pushItems("queue", form.queues ?? [], 2);
	pushItems("topic", form.topics ?? [], 3);
	pushItems("nosql", form.nosql_tables ?? [], 4);
	pushItems("secret", form.secrets ?? [], 5);
	pushItems("bucket", form.storage_buckets ?? [], 6);
	pushItems("registry", form.container_registries ?? [], 7);
	pushItems("service", form.services ?? [], 8);

	return { nodes };
}
