// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The changeset sink (#6764): the seam between the review view and what a project does with a
// reviewed changeset. The contract names two kinds; the `apply` sink is the one built here, and it
// is pinned to the server actions it runs and the order it runs them in.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
	saveDesignAction: vi.fn(),
	planEnvironmentAction: vi.fn(),
	applyPlan: vi.fn(),
}));
vi.mock("@/app/server/actions/canvas-writes", () => ({
	saveDesignAction: actions.saveDesignAction,
	planEnvironmentAction: actions.planEnvironmentAction,
}));
vi.mock("@/app/server/actions/jobs", () => ({ applyPlan: actions.applyPlan }));

import {
	changesetEdits,
	createApplySink,
	useChangesetSink,
	type ChangesetInput,
	type ChangesetSink,
	type ChangesetSinkKind,
	type PullRequestChangesetSink,
} from "@/lib/canvas/store/changeset-sink";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import { diffFields, diffNodes } from "@/lib/canvas/store/derive";
import {
	cacheNode,
	databaseNode,
	projectNode,
} from "@/tests/fixtures/canvas/nodes";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";

/** A changeset: one database edited against a saved design. */
function changeset(): ChangesetInput {
	const baseline = [projectNode(), databaseNode("orders")];
	const draft = [projectNode(), databaseNode("orders", 6543)];
	return {
		projectId: PROJECT,
		environmentId: null,
		environmentName: "prod",
		design: buildDefaultFormValues(),
		changes: diffNodes(baseline, draft),
		fieldChanges: diffFields(baseline, draft),
		edits: changesetEdits("prod", baseline, draft),
		operations: [],
	};
}

const refusal = { ok: false, error: { kind: "conflict", message: "A job is already running." } } as const;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the contract", () => {
	it("names both kinds of sink", () => {
		expectTypeOf<ChangesetSinkKind>().toEqualTypeOf<"apply" | "pull-request">();
		expectTypeOf<PullRequestChangesetSink["kind"]>().toEqualTypeOf<"pull-request">();
		// A sink of either kind is a `ChangesetSink`: the review view holds one without knowing which.
		const kinds: ChangesetSink["kind"][] = ["apply", "pull-request"];
		expect(kinds).toHaveLength(2);
	});

	it("useChangesetSink answers the apply sink, the same one across renders", () => {
		const { result, rerender } = renderHook(() => useChangesetSink(PROJECT));
		const first = result.current;
		expect(first.kind).toBe("apply");
		expect(first.primaryLabel).toBe("Deploy");
		rerender();
		expect(result.current).toBe(first);
	});
});

describe("the apply sink", () => {
	it("plan saves the drafted design, then plans the environment the save resolved", async () => {
		actions.saveDesignAction.mockResolvedValue({ ok: true, data: { environmentId: ENVIRONMENT } });
		actions.planEnvironmentAction.mockResolvedValue({ ok: true, data: { jobId: "plan-1" } });
		const input = changeset();

		const result = await createApplySink().plan(input);

		expect(result).toEqual({ ok: true, data: { planJobId: "plan-1" } });
		expect(actions.saveDesignAction).toHaveBeenCalledWith({
			projectId: PROJECT,
			environmentId: null,
			design: input.design,
		});
		expect(actions.planEnvironmentAction).toHaveBeenCalledWith({
			projectId: PROJECT,
			environmentId: ENVIRONMENT,
		});
		expect(actions.saveDesignAction.mock.invocationCallOrder[0]).toBeLessThan(
			actions.planEnvironmentAction.mock.invocationCallOrder[0],
		);
		// Planning deploys nothing.
		expect(actions.applyPlan).not.toHaveBeenCalled();
	});

	it("plan answers a refused save as it is, and plans nothing", async () => {
		actions.saveDesignAction.mockResolvedValue(refusal);
		expect(await createApplySink().plan(changeset())).toEqual(refusal);
		expect(actions.planEnvironmentAction).not.toHaveBeenCalled();
	});

	it("plan answers a refused plan as it is", async () => {
		actions.saveDesignAction.mockResolvedValue({ ok: true, data: { environmentId: ENVIRONMENT } });
		actions.planEnvironmentAction.mockResolvedValue(refusal);
		expect(await createApplySink().plan(changeset())).toEqual(refusal);
	});

	it("commit applies exactly the reviewed plan, and nothing else", async () => {
		actions.applyPlan.mockResolvedValue({ ok: true, data: { jobId: "deploy-1" } });

		const result = await createApplySink().commit({
			projectId: PROJECT,
			environmentId: ENVIRONMENT,
			planJobId: "plan-1",
		});

		expect(result).toEqual({ ok: true, data: { jobId: "deploy-1" } });
		expect(actions.applyPlan).toHaveBeenCalledWith({ planJobId: "plan-1", runnerId: null });
		expect(actions.saveDesignAction).not.toHaveBeenCalled();
		expect(actions.planEnvironmentAction).not.toHaveBeenCalled();
	});

	it("commit answers a refused apply as it is", async () => {
		actions.applyPlan.mockResolvedValue(refusal);
		expect(
			await createApplySink().commit({ projectId: PROJECT, environmentId: null, planJobId: "plan-1" }),
		).toEqual(refusal);
	});
});

describe("changesetEdits", () => {
	it("an edit is an update naming only the fields that changed, under the design file's kind", () => {
		const baseline = [projectNode(), databaseNode("orders")];
		const draft = [projectNode(), databaseNode("orders", 6543)];
		expect(changesetEdits("prod", baseline, draft)).toEqual([
			{ environment: "prod", kind: "databases", name: "orders", action: "update", fields: { port: 6543 } },
		]);
	});

	it("a new node is a create with its whole config; a removed node is a remove", () => {
		const baseline = [projectNode(), cacheNode("sessions")];
		const draft = [projectNode(), databaseNode("orders")];
		expect(changesetEdits("prod", baseline, draft)).toEqual([
			{
				environment: "prod",
				kind: "databases",
				name: "orders",
				action: "create",
				fields: { name: "orders", engine_family: "postgres", port: 5432, iam_auth: false },
			},
			{ environment: "prod", kind: "caches", name: "sessions", action: "remove", fields: {} },
		]);
	});

	it("a field the draft dropped is written as null", () => {
		const baseline = [projectNode(), databaseNode("orders")];
		const edited = databaseNode("orders");
		if (edited.data.kind !== "database") throw new Error("the fixture is a database");
		const { port: _port, ...withoutPort } = edited.data.config;
		const dropped = { ...edited, data: { ...edited.data, config: withoutPort } } as CanvasNode;
		const draft = [projectNode(), dropped];
		expect(changesetEdits("prod", baseline, draft)[0].fields).toEqual({ port: null });
	});

	it("an unchanged design has no edits", () => {
		const design = [projectNode(), databaseNode("orders")];
		expect(changesetEdits("prod", design, design)).toEqual([]);
	});
});
