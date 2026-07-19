// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the agent-context write path across the ALETHIA_ORG_AGENT_CONTEXT_ENABLED
// dark flag. OFF: byte-identical legacy behavior — requireOwner + withOwnerScope, org_id = user_id,
// NO PDP gate. ON: PDP-gated by scope (org:edit for the org-level row, project:edit for a project
// row) + withActorScope + org_id = actor.orgId. Captures the inserted values off a thenable
// drizzle-ish chain to assert the org stamp.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/org-agent-context-flag", () => ({ orgAgentContextEnabled: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn(), currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ withOwnerScope: vi.fn(), withActorScope: vi.fn() }));

import { upsertAgentContext } from "@/app/server/actions/agent-context";
import { orgAgentContextEnabled } from "@/lib/ai/org-agent-context-flag";
import { requireOwner } from "@/lib/auth/owner";
import { authorize } from "@/lib/authz/guard";
import { withActorScope, withOwnerScope } from "@/lib/db";

// Captures the object passed to `.values()` on the insert chain.
const captured: { values?: Record<string, unknown> } = {};

/** A thenable drizzle-ish insert chain that records the inserted values and returns a fake row. */
function makeTx() {
	const tx: Record<string, unknown> = {};
	Object.assign(tx, {
		insert: () => tx,
		values: (v: Record<string, unknown>) => {
			captured.values = v;
			return tx;
		},
		onConflictDoUpdate: () => tx,
		returning: async () => [{ id: "ctx-1", ...captured.values }],
	});
	return tx;
}

const INPUT = { instructions: "always require approval", documents: [] };
const PROJECT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.clearAllMocks();
	captured.values = undefined;
	vi.mocked(withOwnerScope).mockImplementation(
		((_owner: string, cb: (tx: unknown) => unknown) => cb(makeTx())) as never,
	);
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, cb: (tx: unknown) => unknown) => cb(makeTx())) as never,
	);
});

describe("upsertAgentContext — flag OFF (legacy per-user, byte-identical)", () => {
	beforeEach(() => {
		vi.mocked(orgAgentContextEnabled).mockReturnValue(false);
		vi.mocked(requireOwner).mockResolvedValue("user-1" as never);
	});

	it("uses requireOwner + withOwnerScope, stamps org_id = user_id, and does NOT gate on the PDP", async () => {
		await upsertAgentContext({ ...INPUT, projectId: null });
		expect(authorize).not.toHaveBeenCalled();
		expect(withOwnerScope).toHaveBeenCalledTimes(1);
		expect(withActorScope).not.toHaveBeenCalled();
		expect(captured.values).toMatchObject({ user_id: "user-1", org_id: "user-1", project_id: null });
	});
});

describe("upsertAgentContext — flag ON (org-shared, PDP-gated)", () => {
	beforeEach(() => {
		vi.mocked(orgAgentContextEnabled).mockReturnValue(true);
		vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	});

	it("gates the ORG-level row on org:edit and stamps org_id = actor.orgId", async () => {
		await upsertAgentContext({ ...INPUT, projectId: null });
		expect(authorize).toHaveBeenCalledWith("edit", { type: "org" });
		expect(withActorScope).toHaveBeenCalledTimes(1);
		expect(withOwnerScope).not.toHaveBeenCalled();
		expect(captured.values).toMatchObject({
			user_id: "user-1",
			org_id: "org-1", // the real org, NOT the user id
			project_id: null,
		});
	});

	it("gates a PROJECT row on project:edit for that project", async () => {
		await upsertAgentContext({ ...INPUT, projectId: PROJECT });
		expect(authorize).toHaveBeenCalledWith("edit", { type: "project", id: PROJECT });
		expect(captured.values).toMatchObject({ org_id: "org-1", project_id: PROJECT });
	});

	it("propagates a PDP denial (a member without the permission cannot write)", async () => {
		vi.mocked(authorize).mockRejectedValueOnce(new Error("Forbidden"));
		await expect(upsertAgentContext({ ...INPUT, projectId: null })).rejects.toThrow(/Forbidden/);
		expect(withActorScope).not.toHaveBeenCalled();
	});
});
