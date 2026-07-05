// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Single source of truth for the operating legal entity + jurisdiction. Everything user-facing that
// names the company (marketing legal pages, footers, email metadata) reads from here, so a future
// re-domiciliation or rename is a ONE-FILE edit. The stable `tradingName` ("Alethia Labs") is what
// SPDX copyright headers use — those are intentionally form-agnostic so they never churn again.
// The authoritative full-name legal text also lives in NOTICE / LICENSE (kept in sync by hand).

export const LEGAL_ENTITY = {
	/** Stable brand name — used in SPDX headers + UI. Never carries the legal form. */
	tradingName: "Alethia Labs",
	/** Full current legal entity — the ONE place to edit when the entity changes. */
	legalName: "Alethia Labs DPK",
	jurisdiction: "Bulgaria",
	governingLaw: "Bulgaria",
	/** TODO: Bulgarian EIK (unified identification code) — not yet registered. */
	registrationNumber: "",
	/** TODO: BG VAT number (ДДС №) — pending registration. */
	vat: "",
	/** Registered office (provisional). */
	registeredAddress: "ul. Sirak Skitnik 9, Geo Milev, 1111 Sofia, Bulgaria",
	contactEmail: "legal@alethialabs.io",
	copyrightYears: "2026-present",
	/** Supervisory authority for data protection in the entity's jurisdiction. */
	dpa: {
		name: "Commission for Personal Data Protection",
		localName: "Комисия за защита на личните данни (КЗЛД)",
		url: "https://www.cpdp.bg/en/",
	},
} as const;

/** Returns a filled value, or a visibly-flagged TODO marker until the value is provided. */
export function legalField(value: string, label: string): string {
	return value || `[TODO: ${label}]`;
}
