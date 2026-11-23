// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Early Access half of the payer declaration (#7324): the VAT-number status and number, and a US
// payer's state, as `declarePayer` records them and `payerConversionStatus` judges them. The
// attestation half is `payer-declaration.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(),
	authorize: vi.fn(),
	authorizeInOrg: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/billing/vies", () => ({ checkVatNumber: vi.fn() }));
vi.mock("@/lib/billing/turnover", () => ({ crossedThresholds: vi.fn(async () => []) }));

import { authorize, currentActor } from "@/lib/authz/guard";
import { checkVatNumber } from "@/lib/billing/vies";
import { getServiceDb } from "@/lib/db";
import { declarePayer, payerConversionStatus } from "@/app/server/actions/legal";

/** A drizzle-shaped stub: every lookup finds `rows`; writes are recorded. */
function stubDb(rows: unknown[] = []) {
	const writes: Array<{ kind: "insert" | "update"; values: Record<string, unknown> }> = [];
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(rows),
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				writes.push({ kind: "insert", values });
				return Promise.resolve(undefined);
			},
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				writes.push({ kind: "update", values });
				return { where: () => Promise.resolve(undefined) };
			},
		}),
	};
	vi.mocked(getServiceDb).mockReturnValue(chain as unknown as ReturnType<typeof getServiceDb>);
	return writes;
}

const ORG = { capacity: "organization", billingCountry: "DE", authorityAttestation: "Director" } as const;

beforeEach(() => {
	vi.mocked(currentActor).mockResolvedValue({ credential: "session", userId: "u-1", orgId: "org-1" });
	vi.mocked(authorize).mockResolvedValue({ credential: "session", userId: "u-1", orgId: "org-1" });
	vi.mocked(checkVatNumber).mockResolvedValue({ status: "valid", name: null, address: null, requestIdentifier: null, checkedAt: new Date() });
});
afterEach(() => vi.resetAllMocks());

describe("declarePayer — the VAT number", () => {
	it("records `not_given` with no number", async () => {
		const writes = stubDb();
		await declarePayer({ ...ORG, vatIdStatus: "not_given" });
		expect(writes[0]?.values).toMatchObject({ vatIdStatus: "not_given", vatId: null, billingState: null });
		expect(checkVatNumber).not.toHaveBeenCalled();
	});

	it("records `given` with the number normalised, after VIES lists it", async () => {
		const writes = stubDb();
		await declarePayer({ ...ORG, vatIdStatus: "given", vatId: "de 123 456 789" });
		expect(checkVatNumber).toHaveBeenCalledWith("DE", "DE123456789");
		expect(writes[0]?.values).toMatchObject({ vatIdStatus: "given", vatId: "DE123456789" });
	});

	it("refuses a number VIES does not list, and writes nothing", async () => {
		const writes = stubDb();
		vi.mocked(checkVatNumber).mockResolvedValue({ status: "invalid", checkedAt: new Date() });
		await expect(declarePayer({ ...ORG, vatIdStatus: "given", vatId: "DE123456789" })).rejects.toThrow(/VIES/);
		expect(writes).toEqual([]);
	});

	it("does NOT refuse when VIES is unavailable", async () => {
		const writes = stubDb();
		vi.mocked(checkVatNumber).mockResolvedValue({ status: "unavailable", reason: "HTTP 503" });
		await declarePayer({ ...ORG, vatIdStatus: "given", vatId: "DE123456789" });
		expect(writes[0]?.values).toMatchObject({ vatIdStatus: "given", vatId: "DE123456789" });
	});

	it("refuses `given` with no number, a number in another country's format, and a number with `not_given`", async () => {
		stubDb();
		await expect(declarePayer({ ...ORG, vatIdStatus: "given" })).rejects.toThrow(/VAT number/);
		await expect(declarePayer({ ...ORG, vatIdStatus: "given", vatId: "FR12345678901" })).rejects.toThrow(
			/not a VAT number for the billing country/,
		);
		await expect(declarePayer({ ...ORG, vatIdStatus: "not_given", vatId: "DE123456789" })).rejects.toThrow(
			/only be recorded for an organization that says it has one/,
		);
	});

	it("refuses a VAT-number status on a consumer declaration", async () => {
		stubDb();
		await expect(
			declarePayer({ capacity: "consumer", billingCountry: "DE", authorityAttestation: null, vatIdStatus: "not_given" }),
		).rejects.toThrow(/no VAT-number status/);
	});
});

describe("declarePayer — the US state", () => {
	it("records a US payer's state, upper-cased", async () => {
		const writes = stubDb();
		await declarePayer({ ...ORG, billingCountry: "US", billingState: "ny" });
		expect(writes[0]?.values).toMatchObject({ billingCountry: "US", billingState: "NY", vatIdStatus: null });
	});

	it("refuses a state outside the US, and a code that is not a state", async () => {
		stubDb();
		await expect(declarePayer({ ...ORG, billingState: "NY" })).rejects.toThrow(/United States/);
		await expect(declarePayer({ ...ORG, billingCountry: "US", billingState: "ZZ" })).rejects.toThrow(/US state/);
	});
});

describe("declarePayer — a caller written before #7324 (the fields omitted)", () => {
	const STORED = {
		id: "ob-1",
		payerCapacity: "organization",
		billingCountry: "DE",
		vatIdStatus: "not_given",
		vatId: null,
		billingState: null,
	};

	it("keeps the stored answer while the capacity and country are unchanged", async () => {
		const writes = stubDb([STORED]);
		await declarePayer(ORG);
		expect(writes[0]).toMatchObject({ kind: "update", values: { vatIdStatus: "not_given" } });
	});

	it("clears it when the country changes — an answer about another country is not one about this", async () => {
		const writes = stubDb([STORED]);
		await declarePayer({ ...ORG, billingCountry: "FR" });
		expect(writes[0]).toMatchObject({ kind: "update", values: { vatIdStatus: null, vatId: null } });
	});

	it("clears it when the capacity changes", async () => {
		const writes = stubDb([STORED]);
		await declarePayer({ capacity: "consumer", billingCountry: "DE", authorityAttestation: null });
		expect(writes[0]).toMatchObject({ kind: "update", values: { vatIdStatus: null } });
	});
});

describe("payerConversionStatus — the gate sees the new facts", () => {
	it("routes a German business with a VAT number to the complimentary grant, without asking VIES", async () => {
		stubDb([{ id: "accepted-1" }]);
		const verdict = await payerConversionStatus({ ...ORG, vatIdStatus: "given", vatId: "DE123456789" });
		expect(verdict).toMatchObject({ allowed: false, reason: "complimentary_grant" });
		expect(checkVatNumber).not.toHaveBeenCalled();
	});

	it("refuses a German business that has not answered", async () => {
		stubDb([{ id: "accepted-1" }]);
		expect(await payerConversionStatus(ORG)).toMatchObject({ allowed: false, reason: "vat_status_not_declared" });
	});

	it("refuses a US payer with no state", async () => {
		stubDb([{ id: "accepted-1" }]);
		expect(await payerConversionStatus({ ...ORG, billingCountry: "US" })).toMatchObject({
			allowed: false,
			reason: "state_missing",
		});
	});
});
