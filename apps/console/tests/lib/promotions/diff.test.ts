// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { diffDesigns, mergeChangeset } from "@/lib/promotions/diff";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

/** A minimal, valid design; override slices per test. */
function mkDesign(overrides: Partial<ProjectFormData> = {}): ProjectFormData {
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
	};
	return { ...base, ...structuredClone(overrides) };
}

describe("diffDesigns — identity", () => {
	it("reports no changes for identical designs", () => {
		const d = diffDesigns(mkDesign(), mkDesign());
		expect(d.changes).toHaveLength(0);
		expect(d.summary).toHaveLength(0);
	});
});

describe("diffDesigns — additions", () => {
	it("flags a source-only database as CREATE", () => {
		const source = mkDesign({
			databases: [{ name: "orders", engine: "aurora-postgresql" }],
		});
		const target = mkDesign();
		const d = diffDesigns(source, target);
		expect(d.changes).toEqual([
			{ component_type: "databases", key: "orders", op: "CREATE" },
		]);
		expect(d.summary[0]).toContain("Add database `orders`");
	});
});

describe("diffDesigns — structural vs tunable", () => {
	it("flags an engine_version bump as UPDATE (structural)", () => {
		const source = mkDesign({
			databases: [{ name: "orders", engine: "aurora-postgresql", engine_version: "16" }],
		});
		const target = mkDesign({
			databases: [{ name: "orders", engine: "aurora-postgresql", engine_version: "15" }],
		});
		const d = diffDesigns(source, target);
		expect(d.changes).toHaveLength(1);
		expect(d.changes[0].op).toBe("UPDATE");
		expect(d.changes[0].fields?.engine_version).toEqual({ from: "15", to: "16" });
	});

	it("ignores a pure sizing (tunable) difference", () => {
		const source = mkDesign({
			databases: [
				{ name: "orders", engine: "aurora-postgresql", instance_class: "db.r6g.large", max_capacity: 4 },
			],
		});
		const target = mkDesign({
			databases: [
				{ name: "orders", engine: "aurora-postgresql", instance_class: "db.r6g.xlarge", max_capacity: 16 },
			],
		});
		const d = diffDesigns(source, target);
		expect(d.changes).toHaveLength(0);
	});

	it("flags a cluster_version bump but not node-size differences", () => {
		const source = mkDesign({
			cluster: {
				cluster_version: "1.32",
				instance_types: ["m5.large"],
				node_min_size: 2,
				node_max_size: 5,
				node_desired_size: 2,
				cluster_admins: [],
				provider_config: {},
			},
		});
		const target = mkDesign({
			cluster: {
				cluster_version: "1.31",
				instance_types: ["m5.large"],
				node_min_size: 6,
				node_max_size: 20,
				node_desired_size: 10,
				cluster_admins: [],
				provider_config: {},
			},
		});
		const d = diffDesigns(source, target);
		expect(d.changes).toHaveLength(1);
		expect(d.changes[0]).toMatchObject({ component_type: "cluster", op: "UPDATE" });
		expect(d.changes[0].fields?.cluster_version).toEqual({ from: "1.31", to: "1.32" });
	});
});

describe("diffDesigns — removals", () => {
	it("lists a target-only database as DELETE regardless of includeRemovals", () => {
		const source = mkDesign();
		const target = mkDesign({ databases: [{ name: "legacy", engine: "mysql" }] });
		expect(diffDesigns(source, target, false).changes[0].op).toBe("DELETE");
		expect(diffDesigns(source, target, true).include_removals).toBe(true);
	});
});

describe("mergeChangeset", () => {
	it("adds a source-only database (copying its full config)", () => {
		const source = mkDesign({
			databases: [
				{ name: "orders", engine: "aurora-postgresql", instance_class: "db.r6g.large" },
			],
		});
		const target = mkDesign();
		const merged = mergeChangeset(source, target);
		expect(merged.databases).toHaveLength(1);
		expect(merged.databases[0]).toMatchObject({
			name: "orders",
			engine: "aurora-postgresql",
			instance_class: "db.r6g.large",
		});
	});

	it("promotes structural fields but preserves the target's sizing on UPDATE", () => {
		const source = mkDesign({
			databases: [
				{ name: "orders", engine: "aurora-postgresql", engine_version: "16", instance_class: "db.r6g.large", max_capacity: 4 },
			],
		});
		const target = mkDesign({
			databases: [
				{ name: "orders", engine: "aurora-postgresql", engine_version: "15", instance_class: "db.r6g.4xlarge", max_capacity: 64 },
			],
		});
		const merged = mergeChangeset(source, target);
		const db = merged.databases[0];
		expect(db.engine_version).toBe("16"); // structural promoted
		expect(db.instance_class).toBe("db.r6g.4xlarge"); // tunable preserved
		expect(db.max_capacity).toBe(64); // tunable preserved
	});

	it("preserves the target's cluster node sizing on a version promotion", () => {
		const source = mkDesign({
			cluster: {
				cluster_version: "1.32",
				instance_types: ["m5.large"],
				node_min_size: 2,
				node_max_size: 5,
				node_desired_size: 2,
				cluster_admins: [],
				provider_config: {},
			},
		});
		const target = mkDesign({
			cluster: {
				cluster_version: "1.31",
				instance_types: ["m5.large"],
				node_min_size: 6,
				node_max_size: 20,
				node_desired_size: 10,
				cluster_admins: [],
				provider_config: {},
			},
		});
		const merged = mergeChangeset(source, target);
		expect(merged.cluster.cluster_version).toBe("1.32");
		expect(merged.cluster.node_max_size).toBe(20);
		expect(merged.cluster.node_desired_size).toBe(10);
	});

	it("keeps target-only components unless removals are opted in", () => {
		const source = mkDesign();
		const target = mkDesign({ databases: [{ name: "legacy", engine: "mysql" }] });
		expect(mergeChangeset(source, target, false).databases).toHaveLength(1);
		expect(mergeChangeset(source, target, true).databases).toHaveLength(0);
	});
});
