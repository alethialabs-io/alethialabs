// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W6 (Path B): a scan should yield FIRST-CLASS W1 services, not just the read-only overlay.
// mergeScansToFormData now promotes every Dockerfile'd DetectedService to a `services[]` entry —
// repo-sourced (W1/W2 build), with W3 bindings suggested from the service's detected `needs`.

import { describe, expect, it } from "vitest";
import {
	inferredStackToFormData,
	mergeScansToFormData,
} from "@/lib/scanner/to-project";
import type { InferredStack } from "@/lib/scanner/schema";
import type { DetectedService } from "@/types/jsonb.types";

const OPTS = {
	identityId: "id-1",
	provider: "aws" as const,
	repoUrl: "https://github.com/acme/shop.git",
};

function stack(needs: InferredStack["needs"]): InferredStack {
	return {
		runtime: "node",
		summary: "shop",
		scale: "small",
		container: { dockerfile: true, port: 3000 },
		needs,
	};
}

describe("scan → first-class services[] (W6 Path-B bridge)", () => {
	it("promotes a Dockerfile'd detected service to a buildable, bound first-class service", () => {
		const services: DetectedService[] = [
			{ path: "services/api", name: "API", hasDockerfile: true, port: 8080, needs: ["postgresql"] },
			{ path: "libs/util", name: "util", hasDockerfile: false }, // not deployable → overlay only
		];
		const form = inferredStackToFormData(
			stack([{ kind: "database", engine: "postgres", confidence: 0.9, rationale: "prisma" }]),
			{ ...OPTS, services },
		);

		// Exactly one first-class service — the Dockerfile'd one.
		expect(form.services).toHaveLength(1);
		const svc = form.services[0];
		expect(svc.name).toBe("api");
		expect(svc.source).toMatchObject({ kind: "repo", repo_url: OPTS.repoUrl, path: "services/api" });
		expect(svc.build).toMatchObject({ dockerfile: "Dockerfile" });
		expect(svc.ports).toEqual([{ container_port: 8080 }]);

		// The postgresql need suggests a binding to the provisioned database component.
		expect(svc.bindings).toHaveLength(1);
		expect(svc.bindings[0].target.kind).toBe("database");
		expect(svc.bindings[0].inject.map((i) => i.from)).toContain("password");

		// The read-only overlay still carries every detection (both coexist).
		expect(form.source_repos[0].services).toHaveLength(2);
	});

	it("emits no first-class service when nothing has a Dockerfile", () => {
		const form = inferredStackToFormData(stack([]), {
			...OPTS,
			services: [{ path: "docs", name: "docs", hasDockerfile: false }],
		});
		expect(form.services).toHaveLength(0);
	});

	it("de-dupes service names across repos", () => {
		const form = mergeScansToFormData(
			[
				{
					stack: stack([]),
					repoUrl: "https://github.com/acme/a.git",
					services: [{ path: "", name: "api", hasDockerfile: true }],
				},
				{
					stack: stack([]),
					repoUrl: "https://github.com/acme/b.git",
					services: [{ path: "", name: "api", hasDockerfile: true }],
				},
			],
			OPTS,
		);
		expect(form.services.map((s) => s.name).sort()).toEqual(["api", "api-2"]);
	});

	it("keeps producing a schema-valid project (services included)", () => {
		// inferredStackToFormData asserts projectFormSchema internally, so this not throwing is the
		// proof that the promoted services[] entries satisfy serviceItemSchema.
		expect(() =>
			inferredStackToFormData(stack([]), {
				...OPTS,
				services: [{ path: "svc", name: "svc", hasDockerfile: true, port: 9000, needs: ["redis"] }],
			}),
		).not.toThrow();
	});
});
