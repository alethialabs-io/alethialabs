// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	inserted: [] as unknown[],
	insertError: null as unknown,
	serviceUpdates: [] as unknown[],
	selectRows: [] as unknown[],
	scopes: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
	const tx = {
		insert: () => ({
			values: (v: unknown) => ({
				returning: async () => {
					if (state.insertError) throw state.insertError;
					state.inserted.push(v);
					return [{ id: "req-1" }];
				},
			}),
		}),
		select: () => ({
			from: () => ({
				where: () => ({ orderBy: () => ({ limit: async () => state.selectRows }) }),
			}),
		}),
	};
	return {
		withActorScope: async (actor: unknown, fn: (t: typeof tx) => Promise<unknown>) => {
			state.scopes.push(actor);
			return fn(tx);
		},
		getServiceDb: () => ({
			update: () => ({
				set: (v: unknown) => ({
					where: async () => {
						state.serviceUpdates.push(v);
					},
				}),
			}),
		}),
	};
});

const vies = vi.hoisted(() => ({ checkVatWithVies: vi.fn() }));
vi.mock("@/lib/early-access/vies", () => vies);

const notify = vi.hoisted(() => ({ notifyEarlyAccessRequest: vi.fn(async () => ({ alerted: true, emailed: true })) }));
vi.mock("@/lib/early-access/notify", () => notify);

import { fileEarlyAccessRequest, readEarlyAccessOverview, viesVerdictOf } from "@/lib/early-access/request";

const actor = { userId: "user-1", orgId: "org-1" };

beforeEach(() => {
	state.inserted = [];
	state.insertError = null;
	state.serviceUpdates = [];
	state.selectRows = [];
	state.scopes = [];
	vies.checkVatWithVies.mockReset();
	notify.notifyEarlyAccessRequest.mockClear();
});

describe("fileEarlyAccessRequest", () => {
	it("files a bare open row under the actor's scope, then stores the VIES verdict through the service role", async () => {
		const checkedAt = new Date("2026-11-23T10:00:00Z");
		vies.checkVatWithVies.mockResolvedValue({
			status: "checked",
			valid: true,
			name: "ACME GMBH",
			address: "Berlin",
			requestId: null,
			checkedAt,
		});
		const r = await fileEarlyAccessRequest(actor, { plan: "team", vatId: "de 123 456 789", note: " later " }, false);
		expect(r).toEqual({ ok: true, requestId: "req-1", vies: "valid" });
		expect(state.scopes).toEqual([actor]);
		// The RLS insert carries no VIES field and no status: the policy admits only a bare open row.
		expect(state.inserted).toEqual([
			{
				organizationId: "org-1",
				requestedByUserId: "user-1",
				country: "DE",
				vatId: "DE123456789",
				planWanted: "team",
				requesterNote: "later",
			},
		]);
		expect(vies.checkVatWithVies).toHaveBeenCalledWith("DE", "123456789");
		expect(state.serviceUpdates).toEqual([
			expect.objectContaining({
				viesValid: true,
				viesName: "ACME GMBH",
				viesAddress: "Berlin",
				viesRequestId: null,
				viesCheckedAt: checkedAt,
			}),
		]);
		expect(notify.notifyEarlyAccessRequest).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-1", country: "DE", vatId: "DE123456789", vies: "valid" }),
		);
	});

	it("stores the request unchecked — not refused — when VIES is unavailable", async () => {
		vies.checkVatWithVies.mockResolvedValue({ status: "unchecked", detail: "VIES answered HTTP 503" });
		const r = await fileEarlyAccessRequest(actor, { plan: "ai_plus", vatId: "FR12345678901" }, false);
		expect(r).toEqual({ ok: true, requestId: "req-1", vies: "unchecked" });
		expect(state.serviceUpdates).toEqual([]);
		expect(notify.notifyEarlyAccessRequest).toHaveBeenCalledWith(
			expect.objectContaining({ vies: "unchecked", plan: "ai_plus" }),
		);
	});

	it("does not refuse a number VIES says is invalid; staff see the verdict", async () => {
		vies.checkVatWithVies.mockResolvedValue({
			status: "checked",
			valid: false,
			name: null,
			address: null,
			requestId: null,
			checkedAt: new Date(),
		});
		const r = await fileEarlyAccessRequest(actor, { plan: "team", vatId: "DE000000000" }, false);
		expect(r).toMatchObject({ ok: true, vies: "invalid" });
	});

	it("refuses a Bulgarian number, a non-EU number and a malformed form before writing anything", async () => {
		for (const input of [
			{ plan: "team", vatId: "BG123456789" },
			{ plan: "team", vatId: "GB123456789" },
			{ plan: "enterprise", vatId: "DE123456789" },
			{ plan: "team" },
		]) {
			const r = await fileEarlyAccessRequest(actor, input, false);
			expect(r.ok).toBe(false);
		}
		expect(state.inserted).toEqual([]);
		expect(vies.checkVatWithVies).not.toHaveBeenCalled();
	});

	it("refuses once the seller is VAT-registered: the grant is closed", async () => {
		const r = await fileEarlyAccessRequest(actor, { plan: "team", vatId: "DE123456789" }, true);
		expect(r.ok).toBe(false);
		expect(state.inserted).toEqual([]);
	});

	it("answers a second open request with a sentence, from the one-open-per-org index", async () => {
		state.insertError = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
		const r = await fileEarlyAccessRequest(actor, { plan: "team", vatId: "DE123456789" }, false);
		expect(r).toEqual({ ok: false, error: expect.stringContaining("already has an open request") });
		expect(vies.checkVatWithVies).not.toHaveBeenCalled();
		expect(notify.notifyEarlyAccessRequest).not.toHaveBeenCalled();
	});

	it("answers any other insert failure without notifying", async () => {
		state.insertError = new Error("boom");
		const r = await fileEarlyAccessRequest(actor, { plan: "team", vatId: "DE123456789" }, false);
		expect(r).toEqual({ ok: false, error: "The request could not be saved. Try again." });
		expect(notify.notifyEarlyAccessRequest).not.toHaveBeenCalled();
	});
});

describe("readEarlyAccessOverview", () => {
	it("reads the org's requests under RLS and hides staff-only fields", async () => {
		state.selectRows = [
			{
				id: "req-1",
				plan: "team",
				vatId: "DE123456789",
				country: "DE",
				status: "granted",
				viesValid: true,
				viesCheckedAt: new Date("2026-11-23T10:00:00Z"),
				createdAt: new Date("2026-11-23T09:00:00Z"),
				decidedAt: new Date("2026-11-24T09:00:00Z"),
			},
		];
		const o = await readEarlyAccessOverview(actor, false);
		expect(state.scopes).toEqual([actor]);
		expect(o).toEqual({
			grantsOpen: true,
			requests: [
				{
					id: "req-1",
					plan: "team",
					vatId: "DE123456789",
					country: "DE",
					status: "granted",
					vies: "valid",
					createdAt: "2026-11-23T09:00:00.000Z",
					decidedAt: "2026-11-24T09:00:00.000Z",
				},
			],
		});
	});

	it("says grants are closed once the seller is registered", async () => {
		expect((await readEarlyAccessOverview(actor, true)).grantsOpen).toBe(false);
	});
});

describe("viesVerdictOf", () => {
	it("is unchecked without a check time, whatever the valid column says", () => {
		expect(viesVerdictOf({ viesValid: null, viesCheckedAt: null })).toBe("unchecked");
		expect(viesVerdictOf({ viesValid: true, viesCheckedAt: null })).toBe("unchecked");
		expect(viesVerdictOf({ viesValid: false, viesCheckedAt: new Date() })).toBe("invalid");
	});
});
