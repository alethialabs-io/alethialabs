// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Client helper for support-case attachments. Attachments hang off an EXISTING case, so
// the submit/abuse forms collect files locally, then POST each one to the freshly created
// case after `submitCase` returns. The allowlist + size cap mirror the API route so the
// UI can reject obviously-invalid files before a round-trip.

/** Maximum accepted attachment size (10 MB), matching the API route cap. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** `accept` attribute for the file input — the human-facing side of the allowlist. */
export const ATTACHMENT_ACCEPT = "image/*,application/pdf,text/*,application/json,application/zip,application/gzip";

/** The uploaded-attachment record returned by the attachments API. */
export interface UploadedAttachment {
	id: string;
	file_name: string;
	size_bytes: number;
	content_type: string;
}

/** True when a file's MIME type is on the support attachment allowlist. */
export function isAllowedAttachment(file: File): boolean {
	const t = file.type;
	return (
		t.startsWith("image/") ||
		t.startsWith("text/") ||
		t === "application/pdf" ||
		t === "application/json" ||
		t === "application/zip" ||
		t === "application/gzip"
	);
}

/** Human-readable size, e.g. "2.3 MB" / "812 KB". */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Uploads one file to an existing case's attachments endpoint. Resolves with the created
 * attachment record, or throws when the API rejects it (caller surfaces a toast but never
 * blocks the post-submit redirect on a failed attachment).
 */
export async function uploadAttachment(
	caseId: string,
	file: File,
	messageId?: string,
): Promise<UploadedAttachment> {
	const body = new FormData();
	body.append("file", file);
	if (messageId) body.append("messageId", messageId);

	const res = await fetch(`/api/support/cases/${caseId}/attachments`, {
		method: "POST",
		body,
	});
	if (!res.ok) {
		throw new Error(`Attachment upload failed (${res.status})`);
	}
	return await res.json();
}
