// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The order record and the payer facts that reach Stripe BEFORE a charge (#7324, EA-2), and the ONE
// rule for writing a tax id onto a Stripe customer.
//
// THE TEST THE ISSUE ASKS FOR: no action can attach an EU VAT number to a paying non-BG EU
// organization while the seller is not VAT-registered. It is asked from both ends:
//   · BEHAVIOURALLY — the rule (`taxIdRefusal`) and the pre-mint writer (`preparePaidOrder`) refuse or
//     skip it for every non-BG member state;
//   · STRUCTURALLY — every call that writes a tax id (`createTaxId(`) in the console's source sits in
//     a function that asks the rule first, so the next action cannot quietly be the exception.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	rows: [] as unknown[],
	inserted: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/db", () => {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(db.rows),
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				db.inserted.push(values);
				return { returning: () => Promise.resolve([{ id: "order-1" }]) };
			},
		}),
	};
	return { getServiceDb: () => chain };
});

import { EU_MEMBER_STATES } from "@repo/legal/commerce";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import {
	euVatNumberMayBeRecorded,
	PaidOrderRefusedError,
	preparePaidOrder,
	recordPaidOrder,
	taxIdRefusal,
} from "@/lib/billing/paid-order";

/** A Stripe stand-in recording the customer writes `preparePaidOrder` makes. */
function fakeStripe(customer: Record<string, unknown> = {}) {
	return {
		customers: {
			update: vi.fn(async () => ({})),
			retrieve: vi.fn(async () => ({ deleted: false, ...customer })),
			listTaxIds: vi.fn(async () => ({ data: [] })),
			deleteTaxId: vi.fn(async () => ({})),
			createTaxId: vi.fn(async () => ({})),
		},
	};
}

/** The declared payer facts `preparePaidOrder` reads from `organization_billing`. */
function declared(over: Record<string, unknown> = {}) {
	db.rows = [
		{
			capacity: "organization",
			billingCountry: "DE",
			authorityAttestation: "Director",
			vatIdStatus: "not_given",
			vatId: null,
			billingState: null,
			...over,
		},
	];
}

const ADDRESS = { name: "Acme GmbH", line1: "Hauptstr. 1", city: "Berlin", postalCode: "10115", country: "DE" };

beforeEach(() => {
	db.rows = [];
	db.inserted = [];
});

describe("the premise", () => {
	it("the seller is not VAT-registered", () => {
		expect(LEGAL_ENTITY.vatRegistered).toBe(false);
	});
});

describe("no EU VAT number for a paying non-BG EU organization", () => {
	const nonBg = EU_MEMBER_STATES.filter((c) => c !== "BG");

	it("covers all 26 other member states", () => {
		expect(nonBg).toHaveLength(26);
	});

	it.each(nonBg)("the tax-ID rule refuses one for %s", (country) => {
		const verdict = taxIdRefusal({
			type: "eu_vat",
			value: `${country === "GR" ? "EL" : country}123456789`,
			country,
			vatIdStatus: "given",
			vatRegistered: LEGAL_ENTITY.vatRegistered,
		});
		expect(verdict.ok).toBe(false);
		expect(euVatNumberMayBeRecorded(country, LEGAL_ENTITY.vatRegistered)).toBe(false);
	});

	it.each(nonBg)("preparing an order for %s puts no VAT number on the customer", async (country) => {
		declared({ billingCountry: country, vatIdStatus: "given", vatId: `${country}123456789` });
		const stripe = fakeStripe();
		await preparePaidOrder({
			orgId: "org-1",
			userId: "u-1",
			customerId: "cus_1",
			billingAddress: { ...ADDRESS, country },
			stripe: stripe as never,
		});
		expect(stripe.customers.createTaxId).not.toHaveBeenCalled();
	});

	it("records a Bulgarian VAT number, normalised — the invoice must carry it", () => {
		expect(
			taxIdRefusal({
				type: "eu_vat",
				value: " bg 123 456 789 ",
				country: "BG",
				vatIdStatus: "given",
				vatRegistered: false,
			}),
		).toEqual({ ok: true, value: "BG123456789" });
	});

	it("allows the others once the seller IS registered (reverse charge)", () => {
		expect(
			taxIdRefusal({ type: "eu_vat", value: "DE123456789", country: "DE", vatIdStatus: "given", vatRegistered: true }),
		).toEqual({ ok: true, value: "DE123456789" });
	});

	// Every writer of a customer tax id asks the rule. A source scan, for the reason the
	// eligibility-coverage test is one: a behavioural test pins the actions we know about and says
	// nothing about the next one.
	it("every createTaxId( in the console's source is behind the tax-ID rule", () => {
		const root = process.cwd();
		const writers: string[] = [];
		for (const dir of ["app", "lib", "components"]) {
			walk(join(root, dir), (file) => {
				const src = readFileSync(file, "utf8");
				if (src.includes(".createTaxId(")) writers.push(relative(root, file));
			});
		}
		expect(writers.sort()).toEqual(["app/server/actions/billing.ts", "lib/billing/paid-order.ts"]);
		for (const file of writers) {
			for (const body of functionsCalling(readFileSync(join(root, file), "utf8"), ".createTaxId(")) {
				const guarded = body.includes("taxIdRefusal(") || body.includes("ensureEuVatTaxId(");
				if (!guarded) throw new Error(`${file}: a function writes a tax id without asking taxIdRefusal`);
			}
		}
		// And the one helper that writes without `taxIdRefusal` is only ever called behind the rule.
		const order = readFileSync(join(root, "lib/billing/paid-order.ts"), "utf8");
		expect(order).toMatch(/euVatNumberMayBeRecorded\(billingCountry, LEGAL_ENTITY\.vatRegistered\)\)\s*\{\s*await ensureEuVatTaxId/);
	});
});

/** Calls `fn` for every .ts/.tsx file under `dir`. */
function walk(dir: string, fn: (file: string) => void): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) walk(path, fn);
		else if (/\.(ts|tsx)$/.test(name)) fn(path);
	}
}

/** The text of each top-level function in `src` whose body contains `needle`. */
function functionsCalling(src: string, needle: string): string[] {
	const starts = [...src.matchAll(/^(?:export )?(?:async )?function \w+/gm)].map((m) => m.index ?? 0);
	const bodies: string[] = [];
	starts.forEach((start, i) => {
		const body = src.slice(start, starts[i + 1] ?? src.length);
		if (body.includes(needle)) bodies.push(body);
	});
	return bodies;
}

describe("taxIdRefusal — the rest of the rule", () => {
	it("records no VAT-kind number for an organization that declared it has none", () => {
		for (const type of ["eu_vat", "gb_vat", "ch_vat"] as const) {
			const v = taxIdRefusal({ type, value: "X123", country: "BG", vatIdStatus: "not_given", vatRegistered: false });
			expect(v.ok).toBe(false);
		}
		expect(
			taxIdRefusal({ type: "us_ein", value: "12-3456789", country: "US", vatIdStatus: "not_given", vatRegistered: false }),
		).toEqual({ ok: true, value: "12-3456789" });
	});

	it("refuses an eu_vat with no country, or a non-EU one (fail-closed)", () => {
		expect(taxIdRefusal({ type: "eu_vat", value: "BG123456789", country: null, vatIdStatus: null, vatRegistered: false }).ok).toBe(false);
		expect(taxIdRefusal({ type: "eu_vat", value: "BG123456789", country: "US", vatIdStatus: null, vatRegistered: false }).ok).toBe(false);
	});

	it("refuses an eu_vat in another country's format", () => {
		expect(taxIdRefusal({ type: "eu_vat", value: "DE123456789", country: "BG", vatIdStatus: null, vatRegistered: false }).ok).toBe(false);
		expect(taxIdRefusal({ type: "eu_vat", value: "BG12", country: "BG", vatIdStatus: null, vatRegistered: false }).ok).toBe(false);
	});

	it("always allows clearing", () => {
		expect(taxIdRefusal({ type: "eu_vat", value: "  ", country: "DE", vatIdStatus: "not_given", vatRegistered: false })).toEqual({ ok: true, value: "" });
	});
});

describe("preparePaidOrder — the address on the customer BEFORE the mint", () => {
	it("writes the declared address to the customer and snapshots it", async () => {
		declared();
		const stripe = fakeStripe();
		const order = await preparePaidOrder({
			orgId: "org-1",
			userId: "u-1",
			customerId: "cus_1",
			billingAddress: ADDRESS,
			stripe: stripe as never,
		});
		expect(stripe.customers.update).toHaveBeenCalledWith("cus_1", {
			name: "Acme GmbH",
			address: { line1: "Hauptstr. 1", line2: "", city: "Berlin", state: "", postal_code: "10115", country: "DE" },
		});
		expect(order.billingAddress).toEqual({
			line1: "Hauptstr. 1",
			line2: null,
			city: "Berlin",
			postalCode: "10115",
			region: null,
			country: "DE",
		});
	});

	it("uses the declared US state as the address's region", async () => {
		declared({ billingCountry: "US", vatIdStatus: null, billingState: "NY" });
		const stripe = fakeStripe();
		const order = await preparePaidOrder({
			orgId: "org-1",
			userId: "u-1",
			customerId: "cus_1",
			billingAddress: { ...ADDRESS, country: "US", state: "CA" },
			stripe: stripe as never,
		});
		expect(order.billingAddress.region).toBe("NY");
	});

	it("refuses an address in a different country from the declared one, before writing", async () => {
		declared();
		const stripe = fakeStripe();
		await expect(
			preparePaidOrder({
				orgId: "org-1",
				userId: "u-1",
				customerId: "cus_1",
				billingAddress: { ...ADDRESS, country: "FR" },
				stripe: stripe as never,
			}),
		).rejects.toBeInstanceOf(PaidOrderRefusedError);
		expect(stripe.customers.update).not.toHaveBeenCalled();
	});

	it("reads the customer's address when none is passed, and refuses an incomplete one", async () => {
		declared();
		const complete = fakeStripe({
			name: "Acme GmbH",
			address: { line1: "Hauptstr. 1", city: "Berlin", postal_code: "10115", country: "DE" },
		});
		await expect(
			preparePaidOrder({ orgId: "org-1", userId: "u-1", customerId: "cus_1", stripe: complete as never }),
		).resolves.toMatchObject({ billingName: "Acme GmbH", billingCountry: "DE" });

		const bare = fakeStripe({ name: "Acme GmbH", address: null });
		await expect(
			preparePaidOrder({ orgId: "org-1", userId: "u-1", customerId: "cus_1", stripe: bare as never }),
		).rejects.toThrow(/billing address/);
	});

	it("refuses an organization with no declared payer facts", async () => {
		db.rows = [];
		await expect(
			preparePaidOrder({
				orgId: "org-1",
				userId: "u-1",
				customerId: "cus_1",
				billingAddress: ADDRESS,
				stripe: fakeStripe() as never,
			}),
		).rejects.toThrow(/who this purchase is for/);
	});

	it("puts a Bulgarian organization's declared VAT number on the customer", async () => {
		declared({ billingCountry: "BG", vatIdStatus: "given", vatId: "BG123456789" });
		const stripe = fakeStripe();
		await preparePaidOrder({
			orgId: "org-1",
			userId: "u-1",
			customerId: "cus_1",
			billingAddress: { ...ADDRESS, country: "BG" },
			stripe: stripe as never,
		});
		expect(stripe.customers.createTaxId).toHaveBeenCalledWith("cus_1", { type: "eu_vat", value: "BG123456789" });
	});
});

describe("recordPaidOrder", () => {
	const PREPARED = {
		organizationId: "org-1",
		placedByUserId: "u-1",
		capacity: "organization",
		authorityAttestation: "Director",
		billingCountry: "DE",
		billingState: null,
		vatIdStatus: "not_given",
		vatId: null,
		billingName: "Acme GmbH",
		billingAddress: { line1: "Hauptstr. 1", line2: null, city: "Berlin", postalCode: "10115", region: null, country: "DE" },
	} as const;
	const CHARGE = { productId: "team", totalMinorUnits: 2900, currency: "EUR", periodDays: 30, renewsAutomatically: true };

	it("records that no VAT number was communicated for a `not_given` organization", async () => {
		await expect(recordPaidOrder(PREPARED, CHARGE)).resolves.toBe("order-1");
		expect(db.inserted[0]).toMatchObject({
			organizationId: "org-1",
			capacity: "organization",
			billingCountry: "DE",
			vatIdCommunicated: false,
			taxId: null,
			totalMinorUnits: 2900,
			currency: "eur",
			productId: "team",
		});
		const versions = db.inserted[0]?.documentVersions;
		expect(versions).toMatchObject({ documents: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]) });
	});

	it("records the VAT number and `vatIdCommunicated` for a `given` organization", async () => {
		await recordPaidOrder({ ...PREPARED, billingCountry: "BG", vatIdStatus: "given", vatId: "BG123456789" }, CHARGE);
		expect(db.inserted[0]).toMatchObject({ vatIdCommunicated: true, taxId: "BG123456789" });
	});
});
