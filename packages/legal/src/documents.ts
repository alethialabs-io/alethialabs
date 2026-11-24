// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

export type LegalDocumentLocale = "bg-BG" | "en";

export interface LegalDocumentVersion {
	readonly id: string;
	readonly title: string;
	readonly version: string;
	readonly effectiveDate: string;
	readonly path: `/${string}`;
	readonly locales: readonly LegalDocumentLocale[];
	readonly acceptanceRequired: boolean;
	/**
	 * SHA-256 of the SOURCE FILE that renders this document, lower-case hex.
	 *
	 * This is the half of a clickwrap record that makes it evidence rather than a timestamp. "The
	 * user accepted Terms v2026-08-12" is worth nothing if nobody can say what v2026-08-12 said; the
	 * hash pins the exact bytes, and `scripts/check-legal-document-hashes.mjs` reds CI the moment the
	 * source changes without this being updated.
	 *
	 * Deliberately a CHECK and not a generator: regenerating on every edit would silently re-seal a
	 * changed document under the same version, which is precisely the thing a person has to decide.
	 * A material change needs a new `version` too, or existing acceptances start pointing at text the
	 * user never saw.
	 */
	readonly contentHash: string;
	/** The source file the hash is over, repo-relative. */
	readonly source: string;
}

/**
 * Public document versions. Each carries the SHA-256 of the source that renders it, so a clickwrap
 * record names text that can still be produced years later — see LegalDocumentVersion.contentHash
 * and `scripts/check-legal-document-hashes.mjs`.
 */
export const LEGAL_DOCUMENTS: readonly LegalDocumentVersion[] = [
	{
		id: "terms",
		title: "Terms of Service",
		// Bumped by #2372 (2026-08-24): sections 5 and 13 stated the paid-market gating, the ordinary
		// cancellation bargain, and the consumer's statutory withdrawal right. Bumped again for the
		// move to Paddle (2026-11-24, lane L6a): section 5 names Paddle as reseller and merchant of
		// record for card purchases, keeps Enterprise contracts direct, and replaces "no refund" with
		// the Refund Policy at /refunds. That changes what a reader agrees to, so it is a NEW version —
		// every acceptance recorded against an earlier one stays pinned to the text that existed then,
		// which is the whole point of the hash.
		version: "2026-11-24",
		effectiveDate: "2026-11-24",
		path: "/terms",
		locales: ["en"],
		acceptanceRequired: true,
		contentHash:
			"a49ffc8ddddf0f71883bb506b34266818b9cc996383c1ffded529a277eb020d6",
		source: "apps/marketing/app/terms/page.tsx",
	},
	{
		id: "privacy",
		title: "Privacy Policy",
		// Bumped when transactional email moved from Resend to Amazon SES (eu-central-1) on 2026-11-21,
		// and again on 2026-11-24 when card purchases moved to Paddle, an independent controller: the
		// billing section and section 4 name who receives payment data.
		version: "2026-11-24",
		effectiveDate: "2026-11-24",
		path: "/privacy",
		locales: ["en"],
		acceptanceRequired: false,
		contentHash:
			"e2f514c86f06738f5d9c7fe8cb6d0c4e245ab1b62de0c9a3d97e5eeee9e6df06",
		source: "apps/marketing/app/privacy/page.tsx",
	},
	{
		id: "cookies",
		title: "Cookie Notice",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/cookies",
		locales: ["en"],
		acceptanceRequired: false,
		contentHash:
			"4281a0b6539953390d67beebf34ed615e5272ed9c0b211adba6e01cbb449dae1",
		source: "apps/marketing/app/cookies/page.tsx",
	},
	{
		id: "imprint",
		title: "Company information",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/imprint",
		locales: ["en", "bg-BG"],
		acceptanceRequired: false,
		contentHash:
			"bad66ea9d9064452e50f981e12a2107a449137bdd3e118f215ea24b935d08402",
		source: "apps/marketing/app/imprint/page.tsx",
	},
	{
		id: "consumer-rights",
		title: "Consumer rights",
		// Sealed by the maintainer's legal review of 2026-11-23 (#7351): the console withdrawal control
		// is named, the owed-refund sentence added, and the Bulgarian section (#bg) written, so the
		// one hash pins both languages. A `consumer` paid-market cell needs this seal
		// (paid-markets.ts, condition 3). Bumped on 2026-11-24 (lane L6a) in both languages: Paddle is
		// named as the seller of card purchases, withdrawal can go through Paddle or us, and the
		// voluntary money-back of the Refund Policy replaces "no discretionary refunds". This version
		// awaits the lawyer's review before MOR_MARKETS opens (mor-markets.ts, condition 2).
		version: "2026-11-24",
		effectiveDate: "2026-11-24",
		path: "/consumer-rights",
		locales: ["en", "bg-BG"],
		acceptanceRequired: false,
		contentHash:
			"eba08cf79c27a3609d2f4144f1f5234d11516b077c2538397692bcdfc4e9d3fb",
		source: "apps/marketing/app/consumer-rights/page.tsx",
	},
];

/**
 * The exact strings the console's acceptance gate renders.
 *
 * Exported so the e2e fixture that walks the gate locates the control by CONSTANT rather than by a
 * literal it keeps in step by hand. That is not a style preference — #2371 relabelled the consent
 * buttons and the hero path's hard-coded locator broke silently, with a timeout deep in an unrelated
 * step as the first anyone knew. `CONSENT_LABELS` exists for the same reason; this is its sibling
 * for the clickwrap, and it must stay a plain string map so a Playwright spec can import it.
 */
export const ACCEPTANCE_LABELS = {
	/** The submit button, inert until the box is ticked. */
	submit: "Accept and continue",
	/** The start of the checkbox label — the locator matches on this prefix. */
	checkboxPrefix: "I have read and accept",
} as const;
