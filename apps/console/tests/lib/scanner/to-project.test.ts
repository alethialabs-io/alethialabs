// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// inferredStackToFormData turns the AI scanner's read of a repo into a GUARANTEED-valid
// ProjectFormData (it asserts projectFormSchema internally). Pure + deterministic — these tests pin
// the name/region/engine mapping and the "always valid" contract.

import { describe, expect, it } from "vitest";
import { DEFAULT_REGION } from "@/lib/cloud-providers";
import { inferredStackToFormData, mergeScansToFormData } from "@/lib/scanner/to-project";
import type { InferredStack } from "@/lib/scanner/schema";

function stack(needs: InferredStack["needs"]): InferredStack {
	return {
		runtime: "node",
		summary: "A web app.",
		scale: "small",
		container: { dockerfile: true, port: 3000 },
		needs,
	};
}

const OPTS = {
	identityId: "id-1",
	provider: "aws" as const,
	repoUrl: "https://github.com/acme/My-Cool.App.git",
};

describe("inferredStackToFormData", () => {
	it("derives a slugged project_name from the repo URL", () => {
		const project = inferredStackToFormData(stack([]), OPTS);
		expect(project.project.project_name).toBe("my-cool-app");
		expect(project.repositories.apps_destination_repo).toBe(OPTS.repoUrl);
	});

	it("defaults the region to the provider default, or honors an explicit one", () => {
		expect(inferredStackToFormData(stack([]), OPTS).project.region).toBe(DEFAULT_REGION.aws);
		expect(
			inferredStackToFormData(stack([]), { ...OPTS, region: "eu-central-1" }).project.region,
		).toBe("eu-central-1");
	});

	it("maps service needs into the right component arrays", () => {
		const project = inferredStackToFormData(
			stack([
				{ kind: "database", engine: "mysql", confidence: 0.9, rationale: "prisma mysql" },
				{ kind: "database", confidence: 0.5, rationale: "second db" },
				{ kind: "cache", engine: "redis", confidence: 0.8, rationale: "redis client" },
				{ kind: "secret", name: "API Key!", confidence: 0.7, rationale: "env secret" },
			]),
			OPTS,
		);
		expect(project.databases).toHaveLength(2);
		expect(project.caches).toHaveLength(1);
		expect(project.secrets).toHaveLength(1);
		// The two databases get distinct names (count suffix on the second).
		expect(project.databases[0].name).not.toBe(project.databases[1].name);
	});

	it("picks a MySQL engine for a mysql hint", () => {
		const project = inferredStackToFormData(
			stack([{ kind: "database", engine: "mysql", confidence: 0.9, rationale: "x" }]),
			OPTS,
		);
		expect(project.databases[0].engine).toMatch(/mysql/i);
	});

	it("slugifies an explicit resource name", () => {
		const project = inferredStackToFormData(
			stack([{ kind: "secret", name: "API Key!", confidence: 0.7, rationale: "x" }]),
			OPTS,
		);
		expect(project.secrets[0].name).toBe("api-key");
	});

	it("always returns a schema-valid project (no throw) for an empty stack", () => {
		const project = inferredStackToFormData(stack([]), OPTS);
		expect(project.project.cloud_identity_id).toBe("id-1");
		expect(project.databases).toEqual([]);
	});

	it("records the scanned repo (+ monorepo services) as a source_repos row", () => {
		const project = inferredStackToFormData(stack([]), {
			...OPTS,
			ref: "main",
			services: [
				{ path: "apps/api", name: "api", hasDockerfile: true, runtime: "go", port: 8080 },
			],
		});
		expect(project.source_repos).toHaveLength(1);
		expect(project.source_repos[0]).toMatchObject({
			repo_url: OPTS.repoUrl,
			ref: "main",
			scan_path: "",
		});
		expect(project.source_repos[0].services?.[0]?.name).toBe("api");
	});
});

const MERGE_OPTS = { identityId: "id-1", provider: "aws" as const };

describe("mergeScansToFormData", () => {
	it("attaches one source_repos row per repo and unions their needs", () => {
		const project = mergeScansToFormData(
			[
				{
					stack: stack([
						{ kind: "database", engine: "postgresql", confidence: 0.9, rationale: "pg" },
					]),
					repoUrl: "https://github.com/acme/api.git",
				},
				{
					stack: stack([
						{ kind: "cache", engine: "redis", confidence: 0.8, rationale: "redis" },
					]),
					repoUrl: "https://github.com/acme/web.git",
				},
			],
			MERGE_OPTS,
		);
		expect(project.source_repos.map((r) => r.repo_url)).toEqual([
			"https://github.com/acme/api.git",
			"https://github.com/acme/web.git",
		]);
		expect(project.databases).toHaveLength(1);
		expect(project.caches).toHaveLength(1);
		// The first repo seeds the project name + GitOps destination.
		expect(project.project.project_name).toBe("api");
		expect(project.repositories.apps_destination_repo).toBe(
			"https://github.com/acme/api.git",
		);
	});

	it("gives merged components unique names (no (project,env,name) clash)", () => {
		const pgNeed = { kind: "database" as const, engine: "postgresql", confidence: 0.9, rationale: "pg" };
		const project = mergeScansToFormData(
			[
				{ stack: stack([pgNeed]), repoUrl: "https://github.com/acme/a.git" },
				{ stack: stack([pgNeed]), repoUrl: "https://github.com/acme/b.git" },
			],
			MERGE_OPTS,
		);
		// Two repos each needing Postgres → two databases with DISTINCT names + two source repos.
		expect(project.databases).toHaveLength(2);
		const names = project.databases.map((d) => d.name);
		expect(new Set(names).size).toBe(2);
		expect(project.source_repos).toHaveLength(2);
	});
});
