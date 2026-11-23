// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7368: the Art. 113-114 ЗДДС checks that run before a фактура number is taken (moved here from the
// Odoo client, EA-7): a ten-digit Arabic-digit number, the recipient's details, the no-VAT ground of
// the cell (Art. 113(9) for an unregistered supplier), and no VAT charged by Stripe.

import { describe, expect, it } from "vitest";
import {
	isLegalInvoiceNumber,
	missingRecipientDetails,
	NO_VAT_GROUND_UNREGISTERED,
	noVatGround,
	vatCharged,
} from "@/lib/billing/factura/checks";
import { paidInvoice } from "./fixtures";

const UNREGISTERED = { vatRegistered: false };
const REGISTERED = { vatRegistered: true };

/** The fixture invoice; `over` replaces fields. */
const source = paidInvoice;

describe("isLegalInvoiceNumber (Art. 114(1), point 2)", () => {
	it("accepts exactly ten Arabic digits", () => {
		expect(isLegalInvoiceNumber("0000000001")).toBe(true);
		expect(isLegalInvoiceNumber("1234567890")).toBe(true);
	});

	it.each([
		["an accounting tool's default sequence", "INV/2026/00001"],
		["Stripe's prefix-hyphen-sequence", "OQDLWV3B-0031"],
		["nine digits", "123456789"],
		["eleven digits", "12345678901"],
		["Arabic-Indic digits, which are not Arabic numerals", "١٢٣٤٥٦٧٨٩٠"],
		["a padded number", " 0000000001"],
		["empty", ""],
	])("refuses %s", (_label, value) => {
		expect(isLegalInvoiceNumber(value)).toBe(false);
	});

	it("refuses a missing number", () => {
		expect(isLegalInvoiceNumber(null)).toBe(false);
		expect(isLegalInvoiceNumber(undefined)).toBe(false);
	});
});

describe("noVatGround (the ground per cell)", () => {
	it("is Art. 113(9) for a supplier not registered under the VAT Act", () => {
		expect(noVatGround(UNREGISTERED)).toBe("чл. 113, ал. 9 ЗДДС");
	});

	it("is not ruled for a registered supplier, so nothing is guessed", () => {
		expect(noVatGround(REGISTERED)).toBeNull();
	});

	it("reads the company's real status by default (unregistered today)", () => {
		expect(noVatGround()).toBe(NO_VAT_GROUND_UNREGISTERED);
	});
});

describe("missingRecipientDetails (Art. 114(1) recipient)", () => {
	it("is empty when name, address and an identification number are present", () => {
		expect(missingRecipientDetails(source())).toEqual([]);
	});

	it("names a missing or blank name", () => {
		expect(missingRecipientDetails(source({ customer_name: null }))).toEqual(["name"]);
		expect(missingRecipientDetails(source({ customer_name: "  " }))).toEqual(["name"]);
	});

	it("names an address with no street, city or country", () => {
		expect(missingRecipientDetails(source({ customer_address: null }))).toEqual(["address"]);
		const base = source().customer_address;
		if (!base) throw new Error("fixture has an address");
		expect(missingRecipientDetails(source({ customer_address: { ...base, line1: null } }))).toEqual(["address"]);
		expect(missingRecipientDetails(source({ customer_address: { ...base, city: "" } }))).toEqual(["address"]);
		expect(missingRecipientDetails(source({ customer_address: { ...base, country: null } }))).toEqual(["address"]);
	});

	it("names a missing identification number, and accepts a register number as one", () => {
		expect(missingRecipientDetails(source({ customer_tax_ids: null }))).toEqual(["identification number"]);
		expect(missingRecipientDetails(source({ customer_tax_ids: [] }))).toEqual(["identification number"]);
		expect(
			missingRecipientDetails(source({ customer_tax_ids: [{ type: "bg_uic", value: "208913663" }] })),
		).toEqual([]);
	});

	it("names every gap at once, the state the first invoice was in before EA-2", () => {
		expect(
			missingRecipientDetails(source({ customer_name: null, customer_address: null, customer_tax_ids: null })),
		).toEqual(["name", "address", "identification number"]);
	});
});

describe("vatCharged (Art. 113(9): no VAT on an unregistered supplier's фактура)", () => {
	it("is false when the total equals the total before tax", () => {
		expect(vatCharged({ total: 5500, total_excluding_tax: 5500 })).toBe(false);
	});

	it("is true when Stripe added tax", () => {
		expect(vatCharged({ total: 6600, total_excluding_tax: 5500 })).toBe(true);
	});

	it("reads no tax when Stripe sent no pre-tax total", () => {
		expect(vatCharged({ total: 5500, total_excluding_tax: null })).toBe(false);
	});
});
