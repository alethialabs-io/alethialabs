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
}

/** Public document versions; content hashes are sealed when #2371 finalizes the copy. */
export const LEGAL_DOCUMENTS: readonly LegalDocumentVersion[] = [
	{
		id: "terms",
		title: "Terms of Service",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/terms",
		locales: ["en"],
		acceptanceRequired: true,
	},
	{
		id: "privacy",
		title: "Privacy Policy",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/privacy",
		locales: ["en"],
		acceptanceRequired: false,
	},
	{
		id: "cookies",
		title: "Cookie Notice",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/cookies",
		locales: ["en"],
		acceptanceRequired: false,
	},
	{
		id: "imprint",
		title: "Company information",
		version: "2026-08-12",
		effectiveDate: "2026-08-12",
		path: "/imprint",
		locales: ["en", "bg-BG"],
		acceptanceRequired: false,
	},
];
