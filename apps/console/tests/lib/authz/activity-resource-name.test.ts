// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6733 / #6735: what the Activity writer records, and when.
//
//   * `authorizeDeferred` writes NO row for an allow (the caller records once the thing happened) and
//     the same denial row `enforce()` would;
//   * `recordAllowed` writes the allow with the name the caller passes;
//   * `recordActivity` with no name falls back to the resource's CURRENT name, read in the insert
//     itself and scoped to the actor's org — and never copies a person's name.
//
// Driven through the real guard and recorder; only the PDP answer, the insert and the event emitter
// are stand-ins. The fallback is asserted on the SQL it renders, because the point of it is WHICH
// row it can read: one in the actor's org, and no other.

import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
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

import { recordActivity, recordAllowed } from "@/lib/authz/activity";
import { authorizeDeferred } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";

const ACTOR = { userId: "user-1", orgId: "org-1" };

/** The single row the recorder wrote. */
function written(): Record<string, unknown> {
	expect(h.values).toHaveBeenCalledTimes(1);
	const [row] = h.values.mock.calls[0] ?? [];
	if (typeof row !== "object" || row === null) throw new Error("no row written");
	return { ...row };
}

/** Renders a recorded `resource_name` SQL fallback to its text and bound parameters. */
function rendered(value: unknown): { sql: string; params: unknown[] } {
	if (!(value instanceof SQL)) throw new Error("resource_name is not a SQL lookup");
	return new PgDialect().sqlToQuery(value);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.values.mockReturnValue({ catch: () => undefined });
});

describe("authorizeDeferred", () => {
	it("ALLOWED: writes NO activity row and emits no event — opening a form is not a change", async () => {
		h.can.mockResolvedValue({ allowed: true });
		await expect(authorizeDeferred("manage_billing", { type: "billing" })).resolves.toEqual(ACTOR);
		expect(h.values).not.toHaveBeenCalled();
		expect(h.emitActionEvent).not.toHaveBeenCalled();
	});

	it("DENIED: records the denial and throws, as enforce() would", async () => {
		h.can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		await expect(authorizeDeferred("manage_billing", { type: "billing" })).rejects.toBeInstanceOf(
			ForbiddenError,
		);
		expect(written()).toMatchObject({ action: "manage_billing", decision: false, reason: "no_grant" });
	});
});

describe("recordAllowed", () => {
	it("records the allow under the caller's name for it, and emits the PDP action", () => {
		recordAllowed(ACTOR, "manage_billing", { type: "billing" }, { recordAs: "add_payment_method" });
		expect(written()).toMatchObject({
			org_id: "org-1",
			action: "add_payment_method",
			resource_type: "billing",
			resource_id: null,
			resource_name: null,
			decision: true,
		});
		expect(h.emitActionEvent).toHaveBeenCalledWith(ACTOR, "manage_billing", { type: "billing" }, true);
	});

	it("keeps the name of a resource that no longer exists", () => {
		recordAllowed(ACTOR, "destroy", { type: "project", id: "p-1" }, { resourceName: "qa-proj" });
		expect(written()).toMatchObject({
			action: "destroy",
			resource_id: "p-1",
			resource_name: "qa-proj",
		});
	});
});

describe("recordActivity — the name fallback", () => {
	it("reads a project's current name, scoped to the actor's org", () => {
		recordActivity(ACTOR, "edit", { type: "project", id: "p-1" });
		const q = rendered(written().resource_name);
		expect(q.sql).toMatch(/select "projects"."project_name" from "projects"/);
		expect(q.sql).toMatch(/"projects"."org_id" = \$2/);
		expect(q.params).toEqual(["p-1", "org-1"]);
	});

	it("never copies a person's name: a member row records none", () => {
		recordActivity(ACTOR, "remove", { type: "member", id: "u-2" });
		expect(written().resource_name).toBeNull();
	});

	it("records none for an org-wide resource with no id", () => {
		recordActivity(ACTOR, "manage_billing", { type: "billing" });
		expect(written().resource_name).toBeNull();
	});

	it("a name the caller passes wins over the lookup", () => {
		recordActivity(ACTOR, "destroy", { type: "role", id: "r-1" }, { resourceName: "Auditors" });
		expect(written().resource_name).toBe("Auditors");
	});
});
