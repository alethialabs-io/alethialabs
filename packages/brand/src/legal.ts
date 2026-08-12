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
	legalName: "ALETHIA LABS EDPK",
	/** Registered in the Bulgarian Commercial Register on 11 August 2026. */
	formationPending: false,
	/** Retained only as the historical formation-period operator. */
	currentOperator: "Borislav Borisov, trading as Alethia Labs",
	jurisdiction: "Bulgaria",
	governingLaw: "Bulgaria",
	/** Bulgarian EIK (unified identification code). */
	registrationNumber: "208913663",
	/** TODO: BG VAT number (ДДС №) — pending registration. */
	vat: "",
	/** Registered office. */
	registeredAddress:
		"ul. Sirak Skitnik 9, entrance A, floor 4, apartment 7, 1111 Sofia, Bulgaria",
	contactEmail: "legal@alethialabs.io",
	copyrightYears: "2026-present",
	/** Supervisory authority for data protection in the entity's jurisdiction. */
	dpa: {
		name: "Commission for Personal Data Protection",
		localName: "Комисия за защита на личните данни (КЗЛД)",
		url: "https://www.cpdp.bg/en/",
	},
} as const;

/** Entity that can presently enter contracts and act as data controller. */
export const CURRENT_LEGAL_OPERATOR = LEGAL_ENTITY.formationPending
	? LEGAL_ENTITY.currentOperator
	: LEGAL_ENTITY.legalName;
