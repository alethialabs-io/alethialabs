// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The VAT treatment of a фактура issued to a BUSINESS (L6b): which rate it carries and which legal
// ground it prints. The manual source (manual.ts) uses it for the monthly фактура to Paddle and for
// Enterprise contracts; the Stripe path keeps its own single ground (checks.ts `noVatGround`), and
// this module defers to that same function while the supplier is not VAT-registered, so the two
// paths cannot disagree about an unregistered supplier.
//
// The decision, for a supplier registered under the VAT Act (ЗДДС), follows the buyer's country the
// way `thresholdCountersForSale` (@repo/legal/thresholds) does, from the same two lists
// (`SELLER_COUNTRY`, `EU_MEMBER_STATES` in @repo/legal/commerce):
//  - the buyer is in Bulgaria: a domestic supply, VAT at the standard 20% (Art. 66(1), point 1);
//  - the buyer is a business in another member state with a VAT number of that state: the place of
//    supply of the service is where the buyer is established (Art. 21(2)), no Bulgarian VAT, and the
//    buyer accounts for it (reverse charge, Art. 196 of Directive 2006/112/EC);
//  - the buyer is a business outside the EU (Paddle.com Market Ltd, UK): the place of supply is
//    outside Bulgaria (Art. 21(2)), no Bulgarian VAT and no reverse-charge statement.
// A buyer in another member state WITHOUT a VAT number of that state is refused: for a B2B service
// it is the number that evidences the business status Art. 21(2) depends on, and a consumer there is
// not a sale the manual source makes. The wording of each ground is printed on the document as is;
// the accountant's confirmation of it is an open question recorded on the PR.

import { EU_MEMBER_STATES, SELLER_COUNTRY } from "@repo/legal/commerce";
import type { FacturaVatTreatment } from "@/types/jsonb.types";
import { noVatGround } from "./checks";

/** The standard Bulgarian VAT rate, in percent (Art. 66(1), point 1 ЗДДС). */
const BG_STANDARD_VAT_PERCENT = 20;

/** The ground printed on a service to a business outside the EU (place of supply abroad). */
export const GROUND_OUTSIDE_SCOPE =
	"чл. 21, ал. 2 ЗДДС — мястото на изпълнение не е на територията на страната / " +
	"Art. 21(2) Bulgarian VAT Act — place of supply outside Bulgaria";

/** The ground printed on a service to a business in another member state (reverse charge). */
export const GROUND_EU_REVERSE_CHARGE =
	"чл. 21, ал. 2 ЗДДС — обратно начисляване / " +
	"Art. 21(2) Bulgarian VAT Act — reverse charge, Art. 196 of Directive 2006/112/EC";

/** The supplier facts the treatment depends on (`LEGAL_ENTITY` satisfies it). */
export interface SupplierVatFacts {
	vatRegistered: boolean;
	/** The supplier's own VAT number (`BG…`) once registered. */
	vatNumber: string | null;
}

/** The business the document is issued to, as far as the treatment needs it. */
export interface BuyerVatFacts {
	/** ISO 3166-1 alpha-2. */
	country: string;
	/** The buyer's VAT number with its prefix, when it has one. */
	vatNumber: string | null;
}

/** A decided treatment: the rate (0 when none is charged) and the ground (null when VAT is charged). */
export interface VatTreatment {
	treatment: FacturaVatTreatment;
	ratePercent: number;
	ground: string | null;
}

/** Why no treatment can be decided. */
export type VatTreatmentRefusal =
	| "supplier_vat_number_missing"
	| "eu_buyer_without_vat_number"
	| "no_ground_ruling";

/** The result of deciding the treatment. */
export type VatTreatmentDecision =
	| { ok: true; vat: VatTreatment }
	| { ok: false; reason: VatTreatmentRefusal; detail: string };

/** The member state a VAT number belongs to: its prefix, Greece's `EL` read as `GR`. */
function vatNumberCountry(vatNumber: string): string {
	const prefix = vatNumber.trim().slice(0, 2).toUpperCase();
	return prefix === "EL" ? "GR" : prefix;
}

/**
 * The VAT treatment of a service supplied by `supplier` to the business `buyer`. While the supplier
 * is not VAT-registered every buyer gets the Stripe path's ground (Art. 113(9)) and no VAT.
 */
export function decideVatTreatment(supplier: SupplierVatFacts, buyer: BuyerVatFacts): VatTreatmentDecision {
	if (!supplier.vatRegistered) {
		const ground = noVatGround(supplier);
		if (!ground) return { ok: false, reason: "no_ground_ruling", detail: "no ground is ruled for this supplier" };
		return { ok: true, vat: { treatment: "unregistered", ratePercent: 0, ground } };
	}
	if (!supplier.vatNumber?.trim()) {
		return {
			ok: false,
			reason: "supplier_vat_number_missing",
			detail: "the supplier is VAT-registered but has no VAT number to print (Art. 114(1), point 4)",
		};
	}
	const country = buyer.country.trim().toUpperCase();
	if (country === SELLER_COUNTRY) {
		return { ok: true, vat: { treatment: "domestic", ratePercent: BG_STANDARD_VAT_PERCENT, ground: null } };
	}
	if (EU_MEMBER_STATES.includes(country)) {
		const vat = buyer.vatNumber?.trim() ?? "";
		if (!vat || vatNumberCountry(vat) !== country) {
			return {
				ok: false,
				reason: "eu_buyer_without_vat_number",
				detail: `a business in ${country} needs a ${country === "GR" ? "EL" : country}-prefixed VAT number for the reverse charge (Art. 21(2))`,
			};
		}
		return { ok: true, vat: { treatment: "eu_reverse_charge", ratePercent: 0, ground: GROUND_EU_REVERSE_CHARGE } };
	}
	return { ok: true, vat: { treatment: "outside_scope", ratePercent: 0, ground: GROUND_OUTSIDE_SCOPE } };
}

/** VAT of `taxBaseMinor` at `ratePercent`, rounded half away from zero to the minor unit. */
export function vatAmountMinor(taxBaseMinor: number, ratePercent: number): number {
	const rounded = Math.round((Math.abs(taxBaseMinor) * ratePercent) / 100);
	return taxBaseMinor < 0 && rounded !== 0 ? -rounded : rounded;
}
