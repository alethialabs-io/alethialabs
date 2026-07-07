// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Serves an organization's logo image from object storage (the single
// `org-logos/{id}/logo` object written by the upload route). Content-type is sniffed
// from the magic bytes so we don't need to persist it. Logos are low-sensitivity
// branding shown in <img> tags, so this is unauthenticated + cacheable; the `?v=`
// hash on the stored URL busts the cache on re-upload.

import { storage } from "@/lib/storage";

const BUCKET = "org-logos";

/** Best-effort image content-type from the leading bytes. */
function sniff(bytes: Uint8Array): string {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45
	) {
		return "image/webp";
	}
	// SVG / XML start with '<' (possibly after BOM/whitespace).
	const head = String.fromCharCode(...bytes.slice(0, 5)).trimStart();
	if (head.startsWith("<")) return "image/svg+xml";
	return "application/octet-stream";
}

/** GET /api/org/{id}/logo — streams the org's current logo, or 404. */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
): Promise<Response> {
	const { id } = await params;
	const bytes = await storage.get(BUCKET, `${id}/logo`);
	if (!bytes) {
		return new Response("Not found", { status: 404 });
	}
	return new Response(new Uint8Array(bytes), {
		headers: {
			"content-type": sniff(bytes),
			// Stored URL carries a content-hash ?v=, so a given URL is immutable.
			"cache-control": "public, max-age=31536000, immutable",
		},
	});
}
