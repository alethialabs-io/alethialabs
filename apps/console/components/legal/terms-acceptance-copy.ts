// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The words of the terms acceptance, the documents it links, and the record it writes — in one
// place (#6923, decision M31).
//
// Onboarding shows the acceptance inline, as one unticked box inside the onboarding form; the
// `/accept-terms` gate shows it again whenever a document reaches a new version. Both render from
// this module, so the sentence a person ticks and the record the server writes cannot drift apart.
// What each string means, and why it is worded so, is written down in
// `docs/legal/TERMS_ACCEPTANCE.md`; `docs/legal/legal-set.json` ties that page's statements to the
// lines below, and `node scripts/check-legal-set.mjs` fails when one of them stops matching.
//
// Pure on purpose: no React and no environment read unless the caller asks for the default link
// resolver, so every string is unit tested (`tests/components/legal/terms-acceptance-copy.test.ts`).

import {
	ACCEPTANCE_LABELS,
	LEGAL_DOCUMENTS,
	type LegalDocumentVersion,
} from "@repo/legal/documents";
import { legalUrl } from "@/lib/legal";

/**
 * One document the box covers, in the shape the gate's server read (`getPendingAcceptance`)
 * returns it. `firstAcceptance` is the server's answer to "has this person ever accepted any
 * version of it?" and is never decided in the browser.
 */
export interface AcceptanceDocument {
	/** The document id from `LEGAL_DOCUMENTS`. */
	readonly id: string;
	/** The title shown as the link text. */
	readonly title: string;
	/** The sealed version being accepted, printed beside the title. */
	readonly version: string;
	/** The page's path on the legal site, e.g. `/terms`. */
	readonly path: string;
	/** True when the person has never accepted any version of this document (server-decided). */
	readonly firstAcceptance: boolean;
}

/** One run of the checkbox label or the notice line: plain text, or a link to a legal page. */
export type CopySegment =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "link";
			readonly documentId: string;
			readonly text: string;
			readonly href: string;
	  };

/** Resolves a legal page path (`/terms`) to the address a link opens. */
export type LegalHrefResolver = (path: `/${string}`) => string;

/**
 * The locale an acceptance is recorded in. Every document the box covers is published in it; the
 * unit test fails if one is not, because a record must not claim a locale the text was never shown in.
 */
export const ACCEPTANCE_LOCALE = "en";

/**
 * The documents a person accepts by ticking the box: every sealed document with
 * `acceptanceRequired`. Today that is the Terms of Service alone.
 */
export const ACCEPTED_DOCUMENTS: readonly LegalDocumentVersion[] =
	LEGAL_DOCUMENTS.filter((d) => d.acceptanceRequired);

/**
 * The document the acceptance links as a NOTICE: the Privacy Policy. It is linked so the person can
 * read it before going on, and it is never part of what they accept — processing personal data
 * does not rest on their agreement, and a recorded "acceptance" of it would misstate that.
 */
export const NOTICE_DOCUMENT_ID = "privacy";

/** The fixed strings. `checkboxPrefix` and `submit` are the e2e locators' constants, reused. */
export const TERMS_ACCEPTANCE_TEXT = {
	/** How the checkbox label opens; the e2e fixture locates the box by this prefix. */
	checkboxPrefix: ACCEPTANCE_LABELS.checkboxPrefix,
	/** The gate's submit button. Onboarding keeps its own button; the box is one field of that form. */
	submit: ACCEPTANCE_LABELS.submit,
	/** The submit button while the acceptance is being recorded. */
	submitting: "Recording…",
	/** Shown when recording the acceptance failed and the server gave no message. */
	recordFailed: "Could not record your acceptance.",
	/** The notice line, around the Privacy Policy link. */
	noticeBefore: "How we use your personal data is explained in our ",
	noticeAfter: ".",
} as const;

/** The default resolver: the instance's configured legal base (`NEXT_PUBLIC_LEGAL_URL`). */
const defaultHref: LegalHrefResolver = (path) => legalUrl(path);

/** Narrows a stored path to the `/…` form `legalUrl` takes, or null for one that is not. */
function asLegalPath(path: string): `/${string}` | null {
	return path.startsWith("/") ? `/${path.slice(1)}` : null;
}

/** Joins titles as English prose: `A`, `A and B`, `A, B and C`. */
function joinTitles(titles: readonly string[]): string {
	if (titles.length <= 1) return titles.join("");
	return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** The link to one legal page, or plain text when its path cannot be resolved. */
function linkTo(
	documentId: string,
	text: string,
	path: string,
	resolve: LegalHrefResolver,
): CopySegment {
	const legalPath = asLegalPath(path);
	if (!legalPath) return { kind: "text", text };
	return { kind: "link", documentId, text, href: resolve(legalPath) };
}

/**
 * The checkbox label: `I have read and accept the Terms of Service (version 2026-08-24).`
 *
 * Each document title is a link to the page, and its version is printed beside it, because the
 * record names that version and an acceptance of "the Terms" without one is evidence of nothing.
 */
export function checkboxLabel(
	documents: readonly AcceptanceDocument[],
	resolve: LegalHrefResolver = defaultHref,
): CopySegment[] {
	const segments: CopySegment[] = [
		{ kind: "text", text: `${TERMS_ACCEPTANCE_TEXT.checkboxPrefix} the ` },
	];
	documents.forEach((doc, i) => {
		if (i > 0) {
			segments.push({
				kind: "text",
				text: i === documents.length - 1 ? " and the " : ", the ",
			});
		}
		segments.push(linkTo(doc.id, doc.title, doc.path, resolve));
		segments.push({ kind: "text", text: ` (version ${doc.version})` });
	});
	segments.push({ kind: "text", text: "." });
	return segments;
}

/** The checkbox label as one plain string, for an accessible name or a test. */
export function checkboxLabelText(documents: readonly AcceptanceDocument[]): string {
	return checkboxLabel(documents, (path) => path)
		.map((s) => s.text)
		.join("");
}

/**
 * The line under the box that links the Privacy Policy as a notice. Empty when no Privacy Policy
 * is published, so a link never points at a page that does not exist.
 */
export function noticeLine(resolve: LegalHrefResolver = defaultHref): CopySegment[] {
	const notice = LEGAL_DOCUMENTS.find((d) => d.id === NOTICE_DOCUMENT_ID);
	if (!notice) return [];
	return [
		{ kind: "text", text: TERMS_ACCEPTANCE_TEXT.noticeBefore },
		linkTo(notice.id, notice.title, notice.path, resolve),
		{ kind: "text", text: TERMS_ACCEPTANCE_TEXT.noticeAfter },
	];
}

/** The validation message when the form is submitted with the box unticked. */
export function requiredMessage(documents: readonly AcceptanceDocument[]): string {
	return `Tick the box to accept the ${joinTitles(documents.map((d) => d.title))}.`;
}

/**
 * The `/accept-terms` gate's heading and lede, chosen from what the server says about each document.
 *
 * A person who has never agreed to anything must not be told the Terms "have changed", or that
 * "nothing has been removed" — both describe a history they do not have (#5009). Only when EVERY
 * document is a first acceptance is this a first agreement; one the person has accepted before
 * makes it an update. Inline on onboarding there is no heading: the box is one field of that form.
 */
export function gateHeading(documents: readonly AcceptanceDocument[]): {
	heading: string;
	body: string;
} {
	if (documents.every((d) => d.firstAcceptance)) {
		return {
			heading: "Accept our Terms",
			body: "Review and accept to continue.",
		};
	}
	return {
		heading: documents.length > 1 ? "Updated agreements" : "Our Terms have changed",
		body: "Read and accept to continue. Your work is untouched — nothing has been removed and nothing expires while you decide.",
	};
}

/** One row of the acceptance record, as `acceptLegalDocuments` writes it for one document. */
export interface AcceptanceRecordRow {
	/** The document id from `LEGAL_DOCUMENTS`. */
	readonly documentId: string;
	/** The sealed version accepted, copied in at write time. */
	readonly documentVersion: string;
	/** The sealed SHA-256 of that version's source file, copied in at write time. */
	readonly documentHash: string;
	/** The locale the document was shown in. */
	readonly locale: typeof ACCEPTANCE_LOCALE;
}

/**
 * The sealed versions an acceptance of these documents records: one row per document, each naming
 * the version and content hash from `LEGAL_DOCUMENTS`. Ids that are not acceptance-required sealed
 * documents are dropped, exactly as the server action drops them.
 *
 * The server action (`acceptLegalDocuments` in `app/server/actions/legal.ts`) writes these same
 * three values from the same registry, plus what only the server can know: the person, the
 * organization if one exists, WHY the acceptance happened (`signup` for a first acceptance,
 * `reacceptance` otherwise, decided from the stored history), the time, and the request evidence.
 */
export function acceptanceRecord(documentIds: readonly string[]): AcceptanceRecordRow[] {
	return documentIds.flatMap((id): AcceptanceRecordRow[] => {
		const doc = ACCEPTED_DOCUMENTS.find((d) => d.id === id);
		if (!doc) return [];
		return [
			{
				documentId: doc.id,
				documentVersion: doc.version,
				documentHash: doc.contentHash,
				locale: ACCEPTANCE_LOCALE,
			},
		];
	});
}
