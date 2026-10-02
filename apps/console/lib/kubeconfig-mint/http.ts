// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Response helpers shared by the kubeconfig mint routes.

import { NextResponse } from "next/server";

/**
 * Returns `res` with `Cache-Control: no-store`. Every response on a mint route carries it — the
 * 404s and 403s too — so no proxy, browser or CDN keeps a copy of anything this channel says, and
 * a route cannot forget it on one branch (#5250 §2 "Where the credential exists").
 */
export function noStore(res: Response): Response {
	const headers = new Headers(res.headers);
	headers.set("Cache-Control", "no-store");
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers,
	});
}

/**
 * Reads at most `maxBytes` of `req`'s body and parses it as JSON. Returns `undefined` for a body that
 * is larger, empty, or not JSON — the caller's schema then refuses it. The bound exists because the
 * request route must read the body BEFORE it authenticates (the body names the tier, and the tier
 * names the action to check), so an unauthenticated caller must not be able to make it buffer an
 * unbounded upload.
 */
export async function readBoundedJson(req: Request, maxBytes: number): Promise<unknown> {
	if (!req.body) return undefined;
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return undefined;
	}
}

/** A `{ error }` JSON response with `status`, marked no-store. */
export function mintError(status: number, error: string): Response {
	return noStore(NextResponse.json({ error }, { status }));
}
