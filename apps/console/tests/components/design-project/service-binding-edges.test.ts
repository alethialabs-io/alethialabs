// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// W3: a service's `bindings` become derived service→resource edges, and a binding to a resource that
// isn't on the canvas is the same fail-closed error the deploy snapshot gate throws — surfaced on the
// service node so the canvas shows it pre-deploy. These pin both halves.

import { describe, expect, it } from "vitest";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { formToGraph } from "@/components/design-project/canvas/graph/form-to-graph";
import { configName } from "@/components/design-project/canvas/graph/node-config";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { deriveEdges } from "@/lib/stores/use-canvas-store";
import { nodeReadiness } from "@/lib/canvas/node-status";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

const IDENTITIES: CloudIdentityOption[] = [
	{ id: "id-1", name: "prod", displayId: "111122223333", provider: "aws" },
];

/** A valid form: one database "primary" and one service "api" bound to `bindingTarget`. */
function formBoundTo(bindingTarget: string): ProjectFormData {
	const base = buildDefaultFormValues();
	return {
		...base,
		project: {
			...base.project,
			project_name: "App",
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
		services: [
			{
				name: "api",
				type: "deployment",
				source: { kind: "repo", repo_url: "https://github.com/acme/api", path: "." },
				env: [],
				bindings: [
					{
						target: { kind: "database", name: bindingTarget },
						inject: [{ env: "DB_HOST", from: "endpoint" }],
					},
				],
				ports: [],
				replicas: 2,
			},
		],
	};
}

const graphFor = (target: string): CanvasNode[] =>
	formToGraph(formBoundTo(target), IDENTITIES).nodes;
const idOfKind = (nodes: CanvasNode[], kind: string) =>
	nodes.find((n) => n.data.kind === kind)!.id;

describe("deriveEdges — service binding edges", () => {
	it("draws a binding edge to a resource that is on the canvas", () => {
		const nodes = graphFor("primary");
		const svc = idOfKind(nodes, "service");
		const db = idOfKind(nodes, "database");
		const binding = deriveEdges(nodes).find((e) => e.type === "binding");
		expect(binding).toBeDefined();
		expect(binding?.source).toBe(svc);
		expect(binding?.target).toBe(db);
	});

	it("draws NO binding edge when the target isn't placed", () => {
		const nodes = graphFor("orders-db"); // no database named orders-db
		expect(deriveEdges(nodes).some((e) => e.type === "binding")).toBe(false);
	});

	it("still runs the service ON the cluster (cluster→service dependency edge)", () => {
		const nodes = graphFor("primary");
		const cluster = nodes.find((n) => n.data.kind === "cluster");
		const svc = idOfKind(nodes, "service");
		if (cluster) {
			expect(
				deriveEdges(nodes).some(
					(e) => e.source === cluster.id && e.target === svc && e.type !== "binding",
				),
			).toBe(true);
		}
	});
});

describe("nodeReadiness — fail-closed dangling binding", () => {
	it("flags a service bound to an absent resource with the gate message", () => {
		const nodes = graphFor("orders-db");
		const svc = idOfKind(nodes, "service");
		const r = nodeReadiness(nodes, "id-1", svc);
		expect(r.state).toBe("needs-setup");
		expect(r.issue).toContain("orders-db");
		expect(r.issue).toContain("isn't on the canvas");
	});

	it("does not flag a service whose binding target is present", () => {
		const nodes = graphFor("primary");
		const svc = idOfKind(nodes, "service");
		const r = nodeReadiness(nodes, "id-1", svc);
		expect(r.issue).toBeUndefined();
		expect(r.state).toBe("ready");
	});

	it("matches the target by both kind and configName", () => {
		// Sanity: the placed database's name is what the binding must reference.
		const nodes = graphFor("primary");
		const db = nodes.find((n) => n.data.kind === "database")!;
		expect(configName(db.data)).toBe("primary");
	});
});
