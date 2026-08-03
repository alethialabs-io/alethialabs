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
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";
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
		secrets: [
			{
				name: "api-key",
				generate: true,
				length: 32,
				special_chars: true,
				provider: "vault",
				provider_config: { mount_path: "secret", kv_version: "2" },
			},
		],
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
			// Both switches OFF on purpose: they default to TRUE (#1811), so asserting the ON
			// position would pass just as well if the round-trip dropped them and the default
			// filled the hole back in.
			{
				name: "apps",
				immutable_tags: false,
				vulnerability_scanning: false,
				provider_config: {},
			},
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
			immutable_tags: false,
			vulnerability_scanning: false,
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

	// #1412: dns is a singleton, so it round-trips through `first("dns")` rather than ofKind — a
	// different code path from the array kinds, and one with zero prior coverage.
	it("carries the DNS connector through the round-trip", () => {
		const form = sampleForm();
		form.dns = {
			enabled: true,
			provider: "cloudflare",
			domain_name: "acme.io",
			zone_id: "zone-123",
			provider_config: { proxied: true },
		};
		const { nodes } = formToGraph(form, IDENTITIES);

		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.dns).toEqual(
			expect.objectContaining({
				provider: "cloudflare",
				zone_id: "zone-123",
				provider_config: { proxied: true },
			}),
		);
	});

	// REGRESSION (#1412): the same silent-wipe shape, one table over. A secret's `provider` /
	// `provider_config` say WHICH store the environment reads through; if they don't survive the
	// round-trip, delete-then-insert re-creates every secret as native and the environment quietly
	// stops using Vault — no error, just secrets that resolve from the wrong place.
	it("carries the secret store through the round-trip so a deploy can't wipe it", () => {
		const form = sampleForm();
		const { nodes } = formToGraph(form, IDENTITIES);

		const parsed = projectFormSchema.safeParse(graphToForm(nodes));
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.secrets).toEqual([
			expect.objectContaining({
				name: "api-key",
				provider: "vault",
				provider_config: { mount_path: "secret", kv_version: "2" },
			}),
		]);
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

// #1767 — the overlay path has to survive the canvas round-trip, which is the SAME
// delete-then-insert the save path runs (updateProjectDesign → writeComponents). Anything
// formToGraph declines to put on the graph is gone from the next save with no error, which is
// exactly the silent-wipe class this issue exists to close.
describe("repositories.apps_path survives the canvas round-trip (#1767)", () => {
	const roundTrip = (repositories: ProjectFormData["repositories"]) => {
		const { nodes } = formToGraph({ ...sampleForm(), repositories }, IDENTITIES);
		return { nodes, parsed: projectFormSchema.safeParse(graphToForm(nodes)) };
	};

	it("round-trips the overlay path alongside the repo", () => {
		const { parsed } = roundTrip({
			apps_destination_repo: "https://github.com/acme/apps",
			apps_path: "overlays/dev",
		});
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.repositories).toMatchObject({
			apps_destination_repo: "https://github.com/acme/apps",
			apps_path: "overlays/dev",
		});
	});

	// The CLI can set the two columns independently (`--set apps_path=overlays/dev`), so a
	// repo-less row is reachable. Gating the node on the repo URL alone silently dropped it.
	it("keeps an overlay path set WITHOUT an apps repo — the CLI can set them independently", () => {
		const { nodes, parsed } = roundTrip({ apps_path: "overlays/dev" });
		expect(nodes.filter((n) => n.data.kind === "repositories")).toHaveLength(1);
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.repositories.apps_path).toBe("overlays/dev");
	});

	it("still builds no node when neither column is set", () => {
		const { nodes } = roundTrip({ apps_destination_repo: "", apps_path: "" });
		expect(nodes.filter((n) => n.data.kind === "repositories")).toHaveLength(0);
	});

	// The save gate itself: design-project-canvas's handleSave/handleDeploy both run this exact
	// parse, so a traversal is refused in the console rather than at deploy time.
	it("refuses a traversal at the whole-graph save parse", () => {
		const { parsed } = roundTrip({
			apps_destination_repo: "https://github.com/acme/apps",
			apps_path: "../../etc",
		});
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.path.join(".")).toBe("repositories.apps_path");
		}
	});
});

describe("secret store selection validation", () => {
	const parseSecret = (row: Record<string, unknown>) =>
		projectFormSchema.safeParse({ ...sampleForm(), secrets: [row] });

	// Native is the default and needs no connector — the common case must stay valid.
	it.each([
		["no provider at all", { name: "api-key" }],
		["the explicit native sentinel", { name: "api-key", provider: "native" }],
	])("accepts a native secret with %s", (_label, row) => {
		expect(parseSecret(row).success).toBe(true);
	});

	it("accepts a store whose required knobs are filled", () => {
		const res = parseSecret({
			name: "api-key",
			provider: "vault",
			provider_config: { mount_path: "secret" },
		});
		expect(res.success).toBe(true);
	});

	// Fail-closed: without the mount path the store renders but reads nothing, and the failure only
	// shows up at deploy as a secret that never syncs.
	it("rejects a store missing a required knob", () => {
		const res = parseSecret({ name: "api-key", provider: "vault", provider_config: {} });
		expect(res.success).toBe(false);
	});

	it("rejects a slug the catalog doesn't have", () => {
		expect(parseSecret({ name: "api-key", provider: "not-a-store" }).success).toBe(false);
	});

	it("rejects a store that isn't available yet", () => {
		// The *-xacct stores are coming_soon until their in-cluster e2e is green (#1268).
		const res = parseSecret({
			name: "api-key",
			provider: "aws-sm-xacct",
			provider_config: {
				target_account_id: "222222222222",
				region: "us-east-1",
				target_role_arn: "arn:aws:iam::222222222222:role/read",
			},
		});
		expect(res.success).toBe(false);
	});

	// NOT rejected: `onepassword` is `active` and the runtime accepts it, so failing it closed would
	// break projects already configured through the CLI. The picker disables it instead. `infisical`
	// is here for a different reason — since the ESO 0.9.20 pin it is fully selectable — and it carries
	// BOTH project identifiers (workspace_id for the tofu write, project_slug for the in-cluster read),
	// so this also pins that neither is dropped by the provider_config schema's `.strip()`.
	it.each([
		["infisical", { workspace_id: "ws-1", project_slug: "ws-slug" }],
		["onepassword", { vault: "Private" }],
	] as const)("accepts %s at the schema level, keeping every knob", (provider, knobs) => {
		const res = parseSecret({ name: "api-key", provider, provider_config: knobs });
		expect(res.success).toBe(true);
		if (res.success) {
			expect(res.data.secrets[0].provider_config).toEqual(knobs);
		}
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

// ── the provider_config schema must cover every knob the catalog declares ────────────────────
//
// secretsProviderConfigSchema STRIPS unknown keys (so a stray token can't ride into the persisted
// config_snapshot). The cost of stripping is that a knob the schema doesn't know about is dropped
// SILENTLY — a Doppler `project` quietly lost, the store then reading the wrong scope, with nothing
// failing until deploy. This pins the schema against the catalog so that can't happen unnoticed.
//
// It was already out of sync before this guard existed: the JSONB interface knew nothing about
// doppler's project/config, infisical's four knobs, or 1Password's vault.
describe("secrets provider_config schema covers the catalog", () => {
	it("keeps every non-secret knob any secrets connector declares", () => {
		const declared = new Set<string>();
		for (const provider of getProvidersForCategory("secrets")) {
			for (const field of provider.providerConfigFields) {
				if (!field.secret) declared.add(field.key);
			}
		}
		expect(declared.size).toBeGreaterThan(0);

		// Round-trip a bag holding every declared knob; anything the schema doesn't know is stripped.
		const input = Object.fromEntries([...declared].map((k) => [k, `v-${k}`]));
		const parsed = projectFormSchema.safeParse({
			...sampleForm(),
			secrets: [{ name: "probe", provider: "native", provider_config: input }],
		});
		if (!parsed.success) throw parsed.error;

		const kept = new Set(Object.keys(parsed.data.secrets[0].provider_config ?? {}));
		const dropped = [...declared].filter((k) => !kept.has(k));
		expect(dropped).toEqual([]);
	});

	it("strips a key no connector declares, so it can't reach the config snapshot", () => {
		const parsed = projectFormSchema.safeParse({
			...sampleForm(),
			secrets: [
				{
					name: "probe",
					provider: "native",
					// The failure this guards: a token pasted into the wrong field would otherwise be
					// stored verbatim and spread whole into the Postgres-persisted config_snapshot.
					provider_config: { mount_path: "secret", token: "s3cr3t-should-not-persist" },
				},
			],
		});
		if (!parsed.success) throw parsed.error;
		expect(parsed.data.secrets[0].provider_config).toEqual({ mount_path: "secret" });
	});
});
