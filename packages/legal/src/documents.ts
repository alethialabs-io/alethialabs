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
		// Bumped by #2372: sections 5 and 13 now state the paid-market gating, the ordinary
		// cancellation bargain, and the consumer's statutory withdrawal right. That changes what a
		// reader agrees to, so it is a NEW version — every acceptance recorded against 2026-08-12
		// stays pinned to the text that existed then, which is the whole point of the hash.
		version: "2026-08-24",
		effectiveDate: "2026-08-24",
		path: "/terms",
		locales: ["en"],
		acceptanceRequired: true,
		contentHash:
			"3683a200589f3764906256446a625f94230c46c6c42844efd2ad23fbd7a79261",
		source: "apps/marketing/app/terms/page.tsx",
	},
	{
		id: "privacy",
		title: "Privacy Policy",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/privacy",
		locales: ["en"],
		acceptanceRequired: false,
		contentHash:
			"ce8bc10300de7ed09712681012120d6db120b9ea62faf61bf4f25ce52cb0d93e",
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
			"d50c62eeca64f1dc066c9d1c35c4f2f72a060cf70379e0484669fdf0e4dbac00",
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
			"e7b9229a65873c1e2eb3f4bc88213b8582afb1220e473fb1b211b6c0ddb1b291",
		source: "apps/marketing/app/imprint/page.tsx",
	},
];
