// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/lib/openapi/document";

// Node runtime: the document imports the wire contract, which imports the Drizzle schema.
export const runtime = "nodejs";

/**
 * Public: the OpenAPI 3.1 document for the public API (lib/openapi/document.ts). Unauthenticated,
 * like any API description — it names routes and shapes, never an account's data — and it names no
 * host, so the same document is right for the hosted and a self-hosted control plane.
 *
 * Built once per server process: it depends only on the code, never on the request or the data.
 */
let cached: ReturnType<typeof buildOpenApiDocument> | null = null;

/** Serves the document. */
export async function GET() {
	cached ??= buildOpenApiDocument();
	return NextResponse.json(cached, {
		headers: { "Cache-Control": "public, max-age=300" },
	});
}
