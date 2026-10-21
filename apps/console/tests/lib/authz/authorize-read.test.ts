// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127 / #6209 review: `authorizeRead` — quiet when ALLOWED (no activity row, no action event per
// live refetch), ON THE RECORD when DENIED (the activity row and the action event `enforce()` would
// have written, then ForbiddenError). Driven through the real `enforceDecision`; only the PDP
// answer, the activity-log insert and the event emitter are stand-ins.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	can: vi.fn(),
	values: vi.fn(),
	emitActionEvent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn(), tenancyMode: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: h.can }) }));
vi.mock("@/lib/authz/actor-context", () => ({
	getInjectedActor: () => ({ userId: "user-1", orgId: "org-1" }),
}));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: h.emitActionEvent }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({ insert: () => ({ values: h.values }) }),
}));

import { authorizeRead } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";

const BILLING = { type: "billing" } as const;

beforeEach(() => {
	vi.clearAllMocks();
	h.values.mockReturnValue({ catch: () => undefined });
});

describe("authorizeRead", () => {
	it("ALLOWED: answers with the actor, writes NO activity row and emits NO action event", async () => {
		h.can.mockResolvedValue({ allowed: true });
		await expect(authorizeRead("manage_billing", BILLING)).resolves.toEqual({
			userId: "user-1",
			orgId: "org-1",
		});
		expect(h.values).not.toHaveBeenCalled();
		expect(h.emitActionEvent).not.toHaveBeenCalled();
	});

	it("DENIED: records the denial, emits it as an action event, and throws ForbiddenError", async () => {
		h.can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		await expect(authorizeRead("manage_billing", BILLING)).rejects.toBeInstanceOf(ForbiddenError);
		expect(h.values).toHaveBeenCalledWith(
			expect.objectContaining({
				org_id: "org-1",
				actor_id: "user-1",
				action: "manage_billing",
				resource_type: "billing",
				decision: false,
				reason: "no_grant",
			}),
		);
		expect(h.emitActionEvent).toHaveBeenCalledWith(
			{ userId: "user-1", orgId: "org-1" },
			"manage_billing",
			{ type: "billing", id: undefined },
			false,
		);
	});

	it("DENIED on a project's `view`: the same record, naming the project", async () => {
		h.can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		await expect(authorizeRead("view", { type: "project", id: "p-1" })).rejects.toBeInstanceOf(ForbiddenError);
		expect(h.values).toHaveBeenCalledWith(
			expect.objectContaining({ action: "view", resource_type: "project", resource_id: "p-1", decision: false }),
		);
		expect(h.emitActionEvent).toHaveBeenCalledWith(expect.anything(), "view", { type: "project", id: "p-1" }, false);
	});
});
