// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a support-case attachment may be: ONE allowlist, read by the file picker in the browser and
// by the upload route on the server (`app/api/support/cases/[id]/attachments/route.ts`). Before
// this file the two disagreed — the picker accepted any `text/*` and the route only `text/plain`,
// so a `.csv` passed the picker and was refused after the case was already open (G-05).
//
// A file's type comes from what the browser reports, and when it reports nothing useful (an empty
// string or `application/octet-stream`, which is what a `.log` or `.gz` usually gets) from the
// file's extension (G-06). The resolved type is the one stored with the attachment and served on
// download, so a type that is not on the list never reaches storage under any name.
//
// No React and no server-only imports: both sides import this module.

/** Maximum accepted attachment size (10 MiB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The exact content types accepted besides `image/*`. */
const ALLOWED_EXACT: ReadonlySet<string> = new Set([
	"application/pdf",
	"text/plain",
	"text/csv",
	"text/markdown",
	"application/json",
	"application/zip",
	"application/gzip",
]);

/** The type a file gets from its extension when the browser reports none. */
const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
	txt: "text/plain",
	log: "text/plain",
	out: "text/plain",
	csv: "text/csv",
	md: "text/markdown",
	json: "application/json",
	pdf: "application/pdf",
	zip: "application/zip",
	gz: "application/gzip",
	tgz: "application/gzip",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

/** Browser-reported types that say nothing about the file, so the extension decides instead. */
const UNINFORMATIVE_TYPES: ReadonlySet<string> = new Set(["", "application/octet-stream"]);

/** `accept` attribute for the file input: the same list, as types and as extensions. */
export const ATTACHMENT_ACCEPT = [
	"image/*",
	...ALLOWED_EXACT,
	...Object.keys(TYPE_BY_EXTENSION).map((ext) => `.${ext}`),
].join(",");

/** The sentence under the picker that says what it takes. */
export const ATTACHMENT_HINT = "Images, PDF, text, logs, CSV, JSON or archives, up to 10 MB each.";

/** True when `contentType` (without parameters) is on the allowlist. */
export function isAllowedContentType(contentType: string): boolean {
	const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return bare.startsWith("image/") || ALLOWED_EXACT.has(bare);
}

/** The lower-cased extension of `fileName`, or `""` when it has none. */
function extensionOf(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot <= 0 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/**
 * The content type an attachment is accepted and stored as, or `null` when it is not accepted.
 * The browser's type wins when it says something; otherwise the extension decides.
 */
export function resolveAttachmentType(fileName: string, reportedType: string): string | null {
	const reported = reportedType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (!UNINFORMATIVE_TYPES.has(reported)) {
		return isAllowedContentType(reported) ? reported : null;
	}
	return TYPE_BY_EXTENSION[extensionOf(fileName)] ?? null;
}

/** Why a file cannot be attached, or `null` when it can. Said to the person as is. */
export function attachmentRejection(file: { name: string; type: string; size: number }): string | null {
	if (resolveAttachmentType(file.name, file.type) === null) {
		return `${file.name}: this file type can't be attached. ${ATTACHMENT_HINT}`;
	}
	if (file.size <= 0) return `${file.name}: the file is empty.`;
	if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name}: exceeds the 10 MB limit.`;
	return null;
}
