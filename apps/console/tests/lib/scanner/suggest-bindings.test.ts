// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W3 Path-B seed (#620): the scanner-needs → suggested-bindings mapper. Suggestions must
// (a) target only components that EXIST in the design (the fail-closed gate rejects
// dangling targets), (b) default sensible injections per kind, (c) de-dupe per target,
// and (d) skip unmappable needs rather than inventing edges.

import { describe, expect, it } from "vitest";
import {
	bindableComponents,
	suggestBindings,
} from "@/lib/scanner/suggest-bindings";
import { projectFormSchema } from "@/lib/validations/project-form.schema";

const components = [
	{ kind: "database" as const, name: "main-db" },
	{ kind: "cache" as const, name: "cache" },
	{ kind: "queue" as const, name: "jobs" },
];

describe("suggestBindings", () => {
	it("maps needs to bindings targeting existing components with defaulted injections", () => {
		const got = suggestBindings({ needs: ["postgresql", "redis", "rabbitmq"] }, components);
		expect(got.map((b) => b.target)).toEqual([
			{ kind: "database", name: "main-db" },
			{ kind: "cache", name: "cache" },
			{ kind: "queue", name: "jobs" },
		]);
		const db = got[0];
		expect(db.inject).toEqual([
			{ env: "DATABASE_HOST", from: "endpoint" },
			{ env: "DATABASE_PORT", from: "port" },
			{ env: "DATABASE_USER", from: "username" },
			{ env: "DATABASE_PASSWORD", from: "password" },
		]);
	});

	it("de-dupes needs suggesting the same target (redis + task-queue → one cache binding)", () => {
		const got = suggestBindings({ needs: ["redis", "task-queue"] }, components);
		expect(got).toHaveLength(1);
		expect(got[0].target).toEqual({ kind: "cache", name: "cache" });
	});

	it("skips needs with no mappable kind and needs with no matching component", () => {
		// elasticsearch/object-storage have no bindable kind; mysql maps to database but
		// the design here has none.
		const got = suggestBindings(
			{ needs: ["elasticsearch", "object-storage", "mysql"] },
			[{ kind: "cache", name: "c" }],
		);
		expect(got).toEqual([]);
	});

	it("returns nothing for a service with no needs", () => {
		expect(suggestBindings({}, components)).toEqual([]);
		expect(suggestBindings({ needs: [] }, components)).toEqual([]);
	});

	it("suggestions parse through the real zod binding contract (never a dangling shape)", () => {
		const bindings = suggestBindings({ needs: ["postgresql", "redis"] }, components);
		// A full valid form with a service carrying the suggested bindings + the matching
		// components — the projectFormSchema (incl. serviceBindingSchema) must accept it.
		const form = {
			project: {
				project_name: "my-project",
				environment_stage: "development",
				region: "eu-west-1",
				cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
				iac_version: "1.11.4",
			},
			network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
			cluster: {
				cluster_version: "1.32",
				provider_config: {},
				instance_types: ["t3.medium"],
				node_min_size: 2,
				node_max_size: 5,
				node_desired_size: 2,
			},
			dns: { enabled: false },
			repositories: {},
			databases: [{ name: "main-db" }],
			caches: [{ name: "cache", engine: "redis" }],
			services: [
				{
					name: "api",
					source: { kind: "image", image: "ghcr.io/acme/api:1" },
					env: [],
					ports: [],
					bindings,
				},
			],
		};
		const r = projectFormSchema.safeParse(form);
		if (!r.success) throw new Error(JSON.stringify(r.error.issues));
		expect(r.data.services[0].bindings).toHaveLength(2);
	});
});

describe("bindableComponents", () => {
	it("flattens the form's component arrays into {kind, name} join keys", () => {
		expect(
			bindableComponents({
				databases: [{ name: "db1" }, { name: "db2" }],
				caches: [{ name: "c" }],
				queues: [],
				secrets: [{ name: "api-key" }],
			}),
		).toEqual([
			{ kind: "database", name: "db1" },
			{ kind: "database", name: "db2" },
			{ kind: "cache", name: "c" },
			{ kind: "secret", name: "api-key" },
		]);
	});

	it("surfaces BYO-IaC db/cache/queue resources as targets with address + outputs (#687)", () => {
		const out = bindableComponents({
			databases: [{ name: "first-class-db" }],
			iacOutputs: ["db_endpoint", "db_master_secret"],
			iacGroups: [
				{
					key: "database|module.db",
					kind: "database",
					module: "module.db",
					source: "scan",
					members: [
						{
							address: "module.db.aws_db_instance.main",
							type: "aws_db_instance",
							name: "main",
							module: "module.db",
						},
					],
				},
				{
					// A non-bindable kind (network) is skipped — not a backing resource.
					key: "network|",
					kind: "network",
					module: "",
					source: "scan",
					members: [
						{ address: "aws_vpc.main", type: "aws_vpc", name: "main", module: "" },
					],
				},
			],
		});
		expect(out).toEqual([
			{ kind: "database", name: "first-class-db" },
			{
				kind: "database",
				name: "main",
				address: "module.db.aws_db_instance.main",
				outputs: ["db_endpoint", "db_master_secret"],
			},
		]);
	});
});
