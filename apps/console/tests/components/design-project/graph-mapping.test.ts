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
	});
});
