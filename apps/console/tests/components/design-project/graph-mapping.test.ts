// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Canvas node-config typing: the graph mappers (formToGraph/graphToForm) and the
// configName helper operate over the discriminated CanvasNodeData union. These pin the
// runtime contract — each node kind carries its typed config, names read per kind, and
// the graph→form round-trip re-derives a GUARANTEED-valid ProjectFormData.

import { describe, expect, it } from "vitest";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { formToGraph } from "@/components/design-project/canvas/graph/form-to-graph";
import { graphToForm } from "@/components/design-project/canvas/graph/graph-to-form";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import {
	type ProjectFormData,
	projectFormSchema,
} from "@/lib/validations/project-form.schema";

/** A valid ProjectFormData with a couple of named array resources. */
function sampleForm(): ProjectFormData {
	const base = buildDefaultFormValues();
	return {
		...base,
		project: {
			...base.project,
			project_name: "My App",
			region: "us-east-1",
			cloud_identity_id: "id-1",
		},
		databases: [
			{
				name: "primary",
				engine_family: "postgres",
				min_capacity: 0.5,
				max_capacity: 4,
				port: 5432,
				iam_auth: false,
			},
		],
		caches: [
			{
				name: "sessions",
				engine: "redis",
				node_type: "cache.t3.micro",
				num_cache_nodes: 1,
				multi_az: false,
			},
		],
		secrets: [{ name: "api-key", generate: true, length: 32, special_chars: true }],
		storage_buckets: [
			{
				name: "assets",
				versioning: true,
				encryption_enabled: true,
				public_access: false,
				cors_origins: ["https://app.example.com"],
			},
		],
		container_registries: [
			{ name: "apps", provider_config: { immutable_tags: true } },
		],
		helm_registries: [
			{ name: "ghcr-io", provider: "oci-github-cr", provider_config: {} },
			{
				name: "harbor-acme-io",
				provider: "oci-generic-cr",
				provider_config: { registry_host: "harbor.acme.io" },
			},
		],
		services: [
			{
				name: "api",
				type: "deployment",
				source: { kind: "repo", repo_url: "https://github.com/acme/api", path: "apps/api" },
				env: [{ name: "LOG_LEVEL", value: "info" }],
				bindings: [
					{
						target: { kind: "database", name: "orders-db" },
						inject: [
							{ env: "DATABASE_HOST", from: "endpoint" },
							{ env: "DATABASE_PASSWORD", from: "password" },
						],
					},
				],
				ports: [{ container_port: 8080, protocol: "TCP" }],
				replicas: 3,
			},
		],
	};
}

const IDENTITIES: CloudIdentityOption[] = [
	{ id: "id-1", name: "prod", displayId: "111122223333", provider: "aws" },
];

describe("configName", () => {
	it("reads the display name per kind from a built graph", () => {
		const { nodes } = formToGraph(sampleForm(), IDENTITIES);
		const byKind = (k: NodeKind) => {
			const node = nodes.find((n) => n.data.kind === k);
			if (!node) throw new Error(`no ${k} node`);
			return node;
		};
		// Array kinds → `name`; project → `project_name`.
		expect(configName(byKind("project").data)).toBe("My App");
		expect(configName(byKind("database").data)).toBe("primary");
		expect(configName(byKind("cache").data)).toBe("sessions");
		expect(configName(byKind("secret").data)).toBe("api-key");
		expect(configName(byKind("bucket").data)).toBe("assets");
		expect(configName(byKind("registry").data)).toBe("apps");
		expect(configName(byKind("service").data)).toBe("api");
		// Kinds with no name field.
		expect(configName(byKind("network").data)).toBeUndefined();
		expect(configName(byKind("cluster").data)).toBeUndefined();
	});
});

describe("formToGraph / graphToForm round-trip", () => {
	it("re-derives a valid ProjectFormData with the array items intact", () => {
		const form = sampleForm();
		const { nodes } = formToGraph(form, IDENTITIES);
		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.project.project_name).toBe("My App");
		expect(parsed.data.project.region).toBe("us-east-1");
		expect(parsed.data.databases).toHaveLength(1);
		expect(parsed.data.databases[0].name).toBe("primary");
		expect(parsed.data.caches[0].name).toBe("sessions");
		expect(parsed.data.secrets[0].name).toBe("api-key");
		// bucket/registry array kinds survive the round-trip with their config intact.
		expect(parsed.data.storage_buckets).toHaveLength(1);
		expect(parsed.data.storage_buckets[0]).toMatchObject({
			name: "assets",
			versioning: true,
			cors_origins: ["https://app.example.com"],
		});
		expect(parsed.data.container_registries).toHaveLength(1);
		expect(parsed.data.container_registries[0]).toMatchObject({
			name: "apps",
			provider_config: { immutable_tags: true },
		});
		// W1 — a service workload survives the round-trip with its full config.
		expect(parsed.data.services).toHaveLength(1);
		expect(parsed.data.services[0]).toMatchObject({
			name: "api",
			type: "deployment",
			source: { kind: "repo", repo_url: "https://github.com/acme/api", path: "apps/api" },
			replicas: 3,
		});
		expect(parsed.data.services[0].env).toEqual([{ name: "LOG_LEVEL", value: "info" }]);
		expect(parsed.data.services[0].ports[0].container_port).toBe(8080);
	});

	// REGRESSION: graphToForm used to omit `helm_registries` entirely. Because the field carries a
	// zod `.default([])`, the omission parsed clean as an EMPTY array — and updateProjectDesign
	// reconciles components by delete-then-insert, so every canvas deploy silently dropped the
	// environment's chart repos (and with them the ArgoCD repo-credentials that let private charts
	// pull). A silent `.default([])` is the trap: nothing errors, the rows just leave.
	it("carries chart repos through the round-trip so a deploy can't wipe them", () => {
		const form = sampleForm();
		const { nodes } = formToGraph(form, IDENTITIES);
		expect(nodes.filter((n) => n.data.kind === "helm_registry")).toHaveLength(2);

		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.helm_registries).toHaveLength(2);
		expect(parsed.data.helm_registries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "ghcr-io", provider: "oci-github-cr" }),
				expect.objectContaining({
					name: "harbor-acme-io",
					provider: "oci-generic-cr",
					provider_config: { registry_host: "harbor.acme.io" },
				}),
			]),
		);
	});
});

describe("helm registry selection validation", () => {
	const parseRow = (row: Record<string, unknown>) =>
		projectFormSchema.safeParse({ ...sampleForm(), helm_registries: [row] });

	it("rejects a selection with no provider — the runner would skip it silently", () => {
		const res = parseRow({ name: "charts" });
		expect(res.success).toBe(false);
	});

	it("rejects an any-host provider with no registry host", () => {
		const res = parseRow({ name: "charts", provider: "oci-generic-cr", provider_config: {} });
		expect(res.success).toBe(false);
	});

	it("rejects a classic HTTPS repo with no repository URL", () => {
		const res = parseRow({ name: "charts", provider: "helm-https", provider_config: {} });
		expect(res.success).toBe(false);
	});

	it("rejects a coming_soon provider", () => {
		const res = parseRow({ name: "charts", provider: "oci-ecr", provider_config: {} });
		expect(res.success).toBe(false);
	});

	it("accepts a fixed-host provider with no config at all", () => {
		const res = parseRow({ name: "ghcr-io", provider: "oci-github-cr", provider_config: {} });
		expect(res.success).toBe(true);
	});

	// Both knobs are concatenated into the seeded credential's URL, so a value that merely "looks
	// filled in" still breaks the repoURL prefix match ArgoCD authenticates by. Catch the shape here,
	// where the field is on screen, rather than at deploy.
	it("rejects a registry host carrying a scheme or a path", () => {
		for (const registry_host of [
			"https://harbor.acme.io",
			"harbor.acme.io/charts",
			"oci://harbor.acme.io",
		]) {
			const res = parseRow({
				name: "charts",
				provider: "oci-generic-cr",
				provider_config: { registry_host },
			});
			expect(res.success, `${registry_host} should be rejected`).toBe(false);
		}
	});

	it("accepts a registry host with a port", () => {
		const res = parseRow({
			name: "charts",
			provider: "oci-generic-cr",
			provider_config: { registry_host: "harbor.acme.io:5000" },
		});
		expect(res.success).toBe(true);
	});

	it("rejects a non-https repository URL", () => {
		for (const repo_url of ["charts.acme.io", "http://charts.acme.io"]) {
			const res = parseRow({
				name: "charts",
				provider: "helm-https",
				provider_config: { repo_url },
			});
			expect(res.success, `${repo_url} should be rejected`).toBe(false);
		}
	});
});
