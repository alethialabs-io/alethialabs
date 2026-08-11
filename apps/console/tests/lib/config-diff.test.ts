// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { diffConfig } from "@/lib/config-diff";
import type { CreateProjectInput } from "@/app/server/actions/projects";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** A minimal, valid live design; override slices per test. */
function mkLive(overrides: Partial<ProjectFormData> = {}): ProjectFormData {
	const base: ProjectFormData = {
		project: {
			project_name: "app",
			environment_stage: "development",
			region: "eu-west-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.0.0",
		},
		network: {
			provision_network: true,
			cidr_block: "10.0.0.0/16",
			single_nat_gateway: true,
		},
		cluster: {
			cluster_version: "1.31",
			instance_types: ["m5.large"],
			node_min_size: 2,
			node_max_size: 5,
			node_desired_size: 2,
			cluster_admins: [],
			provider_config: {},
		},
		dns: { enabled: false },
		repositories: {},
		source_repos: [],
		databases: [],
		caches: [],
		queues: [],
		topics: [],
		nosql_tables: [],
		secrets: [],
		storage_buckets: [],
		container_registries: [],
		helm_registries: [],
		services: [],
	};
	return { ...base, ...structuredClone(overrides) };
}

/** A minimal, valid desired document (what a `project design apply` document decodes to). */
function mkDesired(overrides: Partial<CreateProjectInput> = {}): CreateProjectInput {
	const base: CreateProjectInput = {
		project: {
			project_name: "app",
			environment_stage: "development",
			region: "eu-west-1",
			cloud_identity_id: "ci-1",
			iac_version: "1.0.0",
		},
		network: {},
		cluster: {},
		dns: {},
		repositories: {},
	};
	return { ...base, ...structuredClone(overrides) };
}

describe("diffConfig — services / source_repos", () => {
	// This is the regression this test locks: updateProjectDesign's clearComponents issues an
	// unconditional DELETE for projectServices/projectSourceRepos, and writeComponents only
	// restores each `if (data.X?.length)`. A document that OMITS a populated collection must
	// therefore be reported by the diff (as DELETE rows) — not read as "no changes", or a
	// dry-run says nothing changes and the real apply then wipes every service/source repo.
	it("reports a populated `services` collection omitted from the desired document as DELETE, not silence", () => {
		const live = mkLive({
			services: [
				{
					name: "api",
					type: "deployment",
					source: { kind: "image", image: "ghcr.io/acme/api:latest" },
					env: [],
					ports: [],
					bindings: [],
					replicas: 2,
				},
			],
		});
		// The desired document has no `services` key at all — the CreateProjectInput field is
		// optional, exactly like a hand-written or older-format design document would omit it.
		const desired = mkDesired();

		const rows = diffConfig(live, desired);

		expect(rows).not.toHaveLength(0);
		const serviceRows = rows.filter((r) => r.component_type === "service");
		expect(serviceRows).toHaveLength(1);
		expect(serviceRows[0]).toMatchObject({ op: "DELETE" });
	});

	it("reports a populated `source_repos` collection omitted from the desired document as DELETE, not silence", () => {
		const live = mkLive({
			source_repos: [
				{ repo_url: "https://github.com/acme/app", ref: null, scan_path: "" },
			],
		});
		const desired = mkDesired();

		const rows = diffConfig(live, desired);

		expect(rows).not.toHaveLength(0);
		const sourceRepoRows = rows.filter((r) => r.component_type === "source_repo");
		expect(sourceRepoRows).toHaveLength(1);
		expect(sourceRepoRows[0]).toMatchObject({ op: "DELETE" });
	});

	it("reports no changes when both sides carry the same services and source_repos", () => {
		const shared: Partial<ProjectFormData> = {
			services: [
				{
					name: "api",
					type: "deployment",
					source: { kind: "image", image: "ghcr.io/acme/api:latest" },
					env: [],
					ports: [],
					bindings: [],
					replicas: 2,
				},
			],
			source_repos: [
				{ repo_url: "https://github.com/acme/app", ref: null, scan_path: "" },
			],
		};
		const live = mkLive(shared);
		const desired = mkDesired({
			services: [
				{
					name: "api",
					type: "deployment",
					source: { kind: "image", image: "ghcr.io/acme/api:latest" },
					env: [],
					ports: [],
					bindings: [],
					replicas: 2,
				},
			],
			source_repos: [
				{ repo_url: "https://github.com/acme/app", ref: null, scan_path: "" },
			],
		});

		const rows = diffConfig(live, desired);

		expect(rows.filter((r) => r.component_type === "service")).toHaveLength(0);
		expect(rows.filter((r) => r.component_type === "source_repo")).toHaveLength(0);
	});
});
