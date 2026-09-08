// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The HITL operation tool (lib/ai/tools/operations.ts). A proposal carries the environment it
// targets; when the conversation is scoped to one, the tool's description names that id so the
// model fills it in — an omitted id reaches planProject/provisionProject as "the project's
// default environment", which is the wrong target on any other environment.

import { describe, expect, it } from "vitest";
import { operationSchema } from "@/lib/ai/operation";
import { operationTools } from "@/lib/ai/tools/operations";

const ENV_ID = "3f7c1a2e-8b4d-4c6e-9a1b-2d3e4f5a6b7c";

describe("operationSchema", () => {
	it("accepts environmentId on both variants", () => {
		expect(
			operationSchema.parse({ operation: "plan_project", projectId: "p1", environmentId: ENV_ID }),
		).toEqual({ operation: "plan_project", projectId: "p1", environmentId: ENV_ID });
		expect(
			operationSchema.parse({
				operation: "provision_project",
				projectId: "p1",
				planJobId: "j1",
				environmentId: ENV_ID,
			}),
		).toMatchObject({ environmentId: ENV_ID });
	});

	it("still accepts a proposal that omits it (the card then falls back to the surface's scope)", () => {
		const parsed = operationSchema.parse({ operation: "plan_project", projectId: "p1" });
		expect(parsed.environmentId).toBeUndefined();
	});
});

describe("operationTools", () => {
	it("names the scoped environment id in the description so the model copies it", () => {
		const { propose_operation } = operationTools({ environmentId: ENV_ID });
		expect(propose_operation.description).toContain(ENV_ID);
		expect(propose_operation.description).toContain("set environmentId to exactly that id");
	});

	it("leaves the org agent's description unscoped when no environment is given", () => {
		const unscoped = operationTools().propose_operation.description ?? "";
		expect(unscoped).not.toContain("scoped to environment");
		expect(operationTools({ environmentId: null }).propose_operation.description).toBe(unscoped);
		// The scoped description is the unscoped one plus the scope sentence — nothing else moves.
		expect(operationTools({ environmentId: ENV_ID }).propose_operation.description).toMatch(
			new RegExp(`^${unscoped.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
		);
	});

	it("stays a HITL tool: no execute, so the turn pauses on the proposal", () => {
		expect(operationTools({ environmentId: ENV_ID }).propose_operation.execute).toBeUndefined();
	});
});
