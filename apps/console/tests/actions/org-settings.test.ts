// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the org-settings actions: stub the actor, the PDP, better-auth's
// dispatcher and a thenable drizzle chain (so `await db.select()…limit(1)` resolves to seeded rows).
//
// #6128: `saveOrgGeneral` / `deleteOrganization` are the org General page's writes. What they must
// hold, each case below:
//   · the shared schema refuses BEFORE anything is dispatched (F013/F014): empty, too long, reserved;
//   · the org written is the ADDRESS's (`currentActor()`), never one the client names;
//   · the PDP's `edit` on the org runs first — it stands in for the `/api/auth` route's
//     not-an-active-member refusal, which an in-process dispatch does not pass through;
//   · the metadata keeps every stored key the form does not edit (the primary address, the paid
//     create-a-team marker);
//   · better-auth's refusals come back as the contract's kinds — a taken or reserved slug under the
//     slug FIELD, a role refusal as `forbidden` — and nothing it said unexpectedly is shown.
// The read (`getOrgSettings`) moved to the `settings.org` procedure: tests/lib/rpc/settings.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
	headers: vi.fn(async () => new Headers({ cookie: "better-auth.session_token=s1" })),
}));
vi.mock("@/lib/auth", () => ({ auth: { handler: vi.fn() } }));
vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorizeInOrg: vi.fn(),
}));
const { pdpCan } = vi.hoisted(() => ({ pdpCan: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: pdpCan }) }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: vi.fn() }));
// `enforceDecision` keeps its real contract (a refusal throws); both recorders are spies.
vi.mock("@/lib/authz/activity", async () => {
	const { ForbiddenError } = await import("@/lib/authz/types");
	return {
		recordActivity: vi.fn(),
		enforceDecision: vi.fn((_actor: unknown, action: "edit", resource: { type: "org" }, decision: { allowed: boolean }) => {
			if (!decision.allowed) throw new ForbiddenError(action, resource);
		}),
	};
});
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import {
	deleteOrganization,
	saveOrgGeneral,
	updateOrgPrimaryAddress,
} from "@/app/server/actions/org-settings";
import { emitActionEvent } from "@/lib/alerts/emit";
import { auth } from "@/lib/auth";
import { enforceDecision, recordActivity } from "@/lib/authz/activity";
import { currentActor } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";

/** A drizzle-ish chain whose every builder returns itself and which awaits to `rows`. */
function mockDb(rows: unknown[]) {
	const setSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		update: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) => resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy };
}

/** A form submission that passes the schema. */
const VALID = {
	name: "Acme Corp",
	slug: "acme-corp",
	description: "Platform team",
	region: "eu-west-1",
	defaultEnv: "staging",
	terraformVersion: "1.9.5",
};

/** better-auth's answer to the dispatched request. */
function authAnswers(status: number, body: unknown) {
	vi.mocked(auth.handler).mockResolvedValue(Response.json(body, { status }));
}

/** The one request handed to better-auth: its path and its JSON body. */
async function dispatched(): Promise<{ path: string; body: unknown; cookie: string | null }> {
	expect(auth.handler).toHaveBeenCalledTimes(1);
	const request = vi.mocked(auth.handler).mock.calls[0][0];
	return {
		path: new URL(request.url).pathname,
		body: await request.json(),
		cookie: request.headers.get("cookie"),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(currentActor).mockResolvedValue({ orgId: "org-1", userId: "user-1", credential: "session" } as never);
	pdpCan.mockResolvedValue({ allowed: true });
	authAnswers(200, { id: "org-1" });
	mockDb([{ metadata: JSON.stringify({ region: "us-east-1" }) }]);
});

describe("saveOrgGeneral — the schema refuses before anything is dispatched (F013, F014)", () => {
	it.each([
		["an empty name", { ...VALID, name: "  " }, "name", "An organization name is required."],
		["a name over 64 characters", { ...VALID, name: "a".repeat(65) }, "name", "Use at most 64 characters."],
		["a description over 280 characters", { ...VALID, description: "d".repeat(281) }, "description", "Use at most 280 characters."],
		["a reserved slug", { ...VALID, slug: "docs" }, "slug", "That slug is reserved — try another."],
		["a slug with capitals", { ...VALID, slug: "Acme" }, "slug", "Lowercase letters, numbers and hyphens."],
		["a malformed Terraform version", { ...VALID, terraformVersion: "latest" }, "terraformVersion", "Use a release number such as 1.9.5."],
	])("%s → a field error, no write", async (_label, input, field, message) => {
		const result = await saveOrgGeneral(input);
		expect(result).toMatchObject({ ok: false, error: { kind: "validation", fields: { [field]: [message] } } });
		expect(auth.handler).not.toHaveBeenCalled();
		expect(pdpCan).not.toHaveBeenCalled();
	});
});

describe("saveOrgGeneral — a save", () => {
	it("asks the PDP for edit on the org, then updates the ADDRESSED org as the caller", async () => {
		const result = await saveOrgGeneral(VALID);
		expect(result).toEqual({ ok: true, data: { name: "Acme Corp", slug: "acme-corp" } });
		expect(pdpCan).toHaveBeenCalledWith({ orgId: "org-1", userId: "user-1", credential: "session" }, "edit", { type: "org" });
		const sent = await dispatched();
		expect(sent.path).toBe("/api/auth/organization/update");
		expect(sent.cookie).toBe("better-auth.session_token=s1");
		expect(sent.body).toMatchObject({
			organizationId: "org-1",
			data: { name: "Acme Corp", slug: "acme-corp" },
		});
	});

	it("saves the FINISHED slug, not the draft that was typed", async () => {
		await saveOrgGeneral({ ...VALID, slug: "acme-corp-" });
		expect((await dispatched()).body).toMatchObject({ data: { slug: "acme-corp" } });
	});

	it("keeps every metadata key the form does not edit — the marker and the address included", async () => {
		const stored = {
			region: "us-east-1",
			primaryAddress: { name: "Acme", line1: "1 St", country: "EE" },
			newOrgSubscriptionId: "sub_1",
			newOrgCreatedBy: "user-1",
		};
		mockDb([{ metadata: JSON.stringify(stored) }]);
		await saveOrgGeneral(VALID);
		const sent = await dispatched();
		expect(sent.body).toMatchObject({
			data: {
				metadata: {
					...stored,
					region: "eu-west-1",
					description: "Platform team",
					defaultEnv: "staging",
					terraformVersion: "1.9.5",
				},
			},
		});
	});

	it("refuses the personal workspace without a write", async () => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "user-1", userId: "user-1", credential: "session" } as never);
		const result = await saveOrgGeneral(VALID);
		expect(result).toMatchObject({ ok: false, error: { kind: "not-found" } });
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("stops at a PDP refusal (a viewer, or a member who is not active) — nothing is dispatched", async () => {
		pdpCan.mockResolvedValue({ allowed: false, reason: "no grant" });
		const result = await saveOrgGeneral(VALID);
		expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
		expect(auth.handler).not.toHaveBeenCalled();
		// The refusal is recorded (by `enforceDecision`, as `authorize()` would); no allow is.
		expect(enforceDecision).toHaveBeenCalled();
		expect(recordActivity).not.toHaveBeenCalled();
	});
});

describe("saveOrgGeneral — what the client cannot add (review on #6216)", () => {
	it("drops raw-input keys the schema does not own — a forged primary address or setup marker never reaches the write", async () => {
		const stored = {
			primaryAddress: { name: "Acme", line1: "1 St", country: "EE" },
			newOrgSubscriptionId: "sub_real",
		};
		mockDb([{ metadata: JSON.stringify(stored) }]);
		const forged = {
			...VALID,
			primaryAddress: { name: "Mallory", line1: "2 Rd", country: "US" },
			newOrgSubscriptionId: "sub_forged",
			newOrgCreatedBy: "user-2",
			metadata: { anything: true },
			logo: "https://evil.example/x.png",
		};
		expect(await saveOrgGeneral(forged)).toMatchObject({ ok: true });
		const sent = await dispatched();
		expect(sent.body).toEqual({
			organizationId: "org-1",
			data: {
				name: "Acme Corp",
				slug: "acme-corp",
				metadata: {
					...stored,
					description: "Platform team",
					region: "eu-west-1",
					defaultEnv: "staging",
					terraformVersion: "1.9.5",
				},
			},
		});
	});
});

describe("saveOrgGeneral — the Activity log records what happened, once it happened", () => {
	it("records the edit AFTER a successful save", async () => {
		await saveOrgGeneral(VALID);
		expect(recordActivity).toHaveBeenCalledWith(
			{ orgId: "org-1", userId: "user-1", credential: "session" },
			"edit",
			{ type: "org", id: "org-1" },
		);
	});

	it("records no allow when the save failed", async () => {
		authAnswers(400, { code: "ORGANIZATION_SLUG_ALREADY_TAKEN" });
		await saveOrgGeneral(VALID);
		expect(recordActivity).not.toHaveBeenCalled();
	});
});

describe("saveOrgGeneral — better-auth's refusals in the contract's kinds", () => {
	it("a concurrent rename that loses on the unique index → the same 'taken' under the slug field", async () => {
		// The winner committed first; better-auth's own pre-check passed for both, so the loser's write
		// fails on the index with no code. Another org now holds the slug.
		mockDb([{ metadata: null, id: "org-2" }]);
		authAnswers(500, { message: "duplicate key value violates unique constraint" });
		expect(await saveOrgGeneral(VALID)).toEqual({
			ok: false,
			error: {
				kind: "validation",
				message: "That slug is taken — try another.",
				fields: { slug: ["That slug is taken — try another."] },
			},
		});
	});

	it("a slug another org holds → under the slug field", async () => {
		authAnswers(400, { code: "ORGANIZATION_SLUG_ALREADY_TAKEN", message: "Organization slug already taken" });
		expect(await saveOrgGeneral(VALID)).toEqual({
			ok: false,
			error: {
				kind: "validation",
				message: "That slug is taken — try another.",
				fields: { slug: ["That slug is taken — try another."] },
			},
		});
	});

	it("the ee/ hook's reserved refusal → under the slug field", async () => {
		authAnswers(400, { code: "ORGANIZATION_SLUG_RESERVED", message: "That slug is reserved — try another." });
		expect(await saveOrgGeneral(VALID)).toMatchObject({
			ok: false,
			error: { kind: "validation", fields: { slug: ["That slug is reserved — try another."] } },
		});
	});

	it("a 500 while NO other org holds the slug stays unexpected — the race mapping does not swallow real failures", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		mockDb([{ metadata: null }]); // the slug check finds no other org
		authAnswers(500, { message: "connection reset" });
		const result = await saveOrgGeneral(VALID);
		expect(result).toMatchObject({ ok: false, error: { kind: "unexpected" } });
		spy.mockRestore();
	});

	it("the plugin's role refusal → forbidden", async () => {
		authAnswers(403, { code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION", message: "nope" });
		expect(await saveOrgGeneral(VALID)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
	});

	it("no session → unauthenticated", async () => {
		authAnswers(401, { message: "Unauthorized" });
		expect(await saveOrgGeneral(VALID)).toEqual({ ok: false, error: { kind: "unauthenticated" } });
	});

	it("anything else → unexpected, with none of the server's text", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		authAnswers(500, { code: "INTERNAL", message: "relation organization_secret_column does not exist" });
		const result = await saveOrgGeneral(VALID);
		expect(result).toMatchObject({ ok: false, error: { kind: "unexpected" } });
		expect(JSON.stringify(result)).not.toContain("organization_secret_column");
		spy.mockRestore();
	});
});

describe("deleteOrganization", () => {
	it("records the delete as a DESTROY of the org, after it succeeded — and keeps it alertable", async () => {
		await deleteOrganization({});
		expect(emitActionEvent).toHaveBeenCalledWith(
			{ orgId: "org-1", userId: "user-1", credential: "session" },
			"destroy",
			{ type: "org" },
			true,
		);
		expect(recordActivity).toHaveBeenCalledTimes(1);
		expect(recordActivity).toHaveBeenCalledWith(
			{ orgId: "org-1", userId: "user-1", credential: "session" },
			"destroy",
			{ type: "org", id: "org-1" },
		);
	});

	it("records nothing as done when better-auth refused the delete", async () => {
		authAnswers(403, { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION" });
		await deleteOrganization({});
		expect(recordActivity).not.toHaveBeenCalled();
		expect(emitActionEvent).not.toHaveBeenCalled();
	});

	it("asks the PDP first, then deletes the ADDRESSED org", async () => {
		const result = await deleteOrganization({});
		expect(result).toEqual({ ok: true, data: { deleted: true } });
		expect(pdpCan).toHaveBeenCalledWith({ orgId: "org-1", userId: "user-1", credential: "session" }, "edit", { type: "org" });
		const sent = await dispatched();
		expect(sent.path).toBe("/api/auth/organization/delete");
		expect(sent.body).toEqual({ organizationId: "org-1" });
	});

	it("dispatches nothing when the PDP refuses", async () => {
		pdpCan.mockResolvedValue({ allowed: false, reason: "no grant" });
		expect(await deleteOrganization({})).toMatchObject({ ok: false, error: { kind: "forbidden" } });
		expect(auth.handler).not.toHaveBeenCalled();
	});

	it("passes better-auth's owner-only refusal on as forbidden", async () => {
		authAnswers(403, { code: "YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION" });
		expect(await deleteOrganization({})).toMatchObject({ ok: false, error: { kind: "forbidden" } });
	});

	it("refuses the personal workspace", async () => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "user-1", userId: "user-1", credential: "session" } as never);
		expect(await deleteOrganization({})).toMatchObject({ ok: false, error: { kind: "not-found" } });
		expect(auth.handler).not.toHaveBeenCalled();
	});
});

describe("updateOrgPrimaryAddress", () => {
	it("refuses the personal scope", async () => {
		vi.mocked(currentActor).mockResolvedValue({ orgId: "user-1", userId: "user-1", credential: "session" } as never);
		await expect(
			updateOrgPrimaryAddress({ name: "X", line1: "1 St", country: "EE" }),
		).rejects.toThrow(/No organization/);
	});

	it("merges the address into existing metadata", async () => {
		const { setSpy } = mockDb([{ metadata: JSON.stringify({ region: "eu-west-1" }) }]);
		const r = await updateOrgPrimaryAddress({ name: "Acme", line1: "1 St", country: "EE" });
		expect(r).toEqual({ ok: true });
		const written = JSON.parse(setSpy.mock.calls[0][0].metadata);
		expect(written.region).toBe("eu-west-1"); // preserved
		expect(written.primaryAddress).toMatchObject({ name: "Acme", country: "EE" }); // merged
	});

	// #5445 review: this is a direct write, so the organization plugin's update hook that guards the
	// create-a-team marker never sees it. Rebuilt through parseMeta (which reads only the settings
	// fields) it dropped both marker keys — and any other key the blob carried.
	it("keeps every key it does not own — the paid-setup marker included — exactly as stored", async () => {
		const stored = {
			region: "eu-west-1",
			newOrgSubscriptionId: "sub_1",
			newOrgCreatedBy: "user-1",
			demo: true,
		};
		const { setSpy } = mockDb([{ metadata: JSON.stringify(stored) }]);
		await updateOrgPrimaryAddress({ name: "Acme", line1: "1 St", country: "EE" });
		const written = JSON.parse(setSpy.mock.calls[0][0].metadata);
		expect(written).toEqual({
			...stored,
			primaryAddress: { name: "Acme", line1: "1 St", country: "EE" },
		});
	});

	it("replaces a blob that is not a JSON object", async () => {
		const { setSpy } = mockDb([{ metadata: "not json" }]);
		await updateOrgPrimaryAddress({ name: "Acme", line1: "1 St", country: "EE" });
		expect(JSON.parse(setSpy.mock.calls[0][0].metadata)).toEqual({
			primaryAddress: { name: "Acme", line1: "1 St", country: "EE" },
		});
	});
});
