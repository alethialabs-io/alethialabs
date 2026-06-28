// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// inferredStackToFormData turns the AI scanner's read of a repo into a GUARANTEED-valid
// ProjectFormData (it asserts projectFormSchema internally). Pure + deterministic — these tests pin
// the name/region/engine mapping and the "always valid" contract.

import { describe, expect, it } from "vitest";
import { DEFAULT_REGION } from "@/lib/cloud-providers";
import { inferredStackToFormData } from "@/lib/scanner/to-project";
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
});
