// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { PROJECT_NODE_ID } from "@/lib/stores/use-canvas-store";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";
import type { CanvasNode, NodeKind } from "./types";

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

	const makeNode = (
		kind: NodeKind,
		config: Record<string, unknown>,
		position: { x: number; y: number },
		ownIdentity?: string | null,
	): CanvasNode => {
		const own = ownIdentity ?? null;
		return {
			id: kind === "project" ? PROJECT_NODE_ID : `${kind}-${config.name ?? kind}`,
			type: kind,
			position,
			deletable: kind !== "project",
			data: {
				kind,
				config,
				cloud_identity_id: own,
				provider: providerOf(own ?? coreId),
			},
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

	// Array kinds laid out in rows below the cluster.
	const rows: { kind: NodeKind; items: Array<{ cloud_identity_id?: string | null }> }[] = [
		{ kind: "database", items: form.databases ?? [] },
		{ kind: "cache", items: form.caches ?? [] },
		{ kind: "queue", items: form.queues ?? [] },
		{ kind: "topic", items: form.topics ?? [] },
		{ kind: "nosql", items: form.nosql_tables ?? [] },
		{ kind: "secret", items: form.secrets ?? [] },
	];
	rows.forEach((row, rowIdx) => {
		row.items.forEach((item, i) => {
			nodes.push(
				makeNode(
					row.kind,
					{ ...item },
					{ x: 120 + i * 220, y: 340 + rowIdx * 130 },
					ownOf(item),
				),
			);
		});
	});

	return { nodes };
}
