// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { authorizeCli } from "@/lib/authz/guard";
import {
	componentSchemaDocument,
	componentSchemaWire,
} from "@/lib/cli/project-components";
import { NextResponse } from "next/server";
import { cliJson } from "@/lib/cli/respond";

/** `private` because the response is token-gated (never store it in a shared cache); `no-cache`
 *  because the client SHOULD keep it and revalidate with `If-None-Match` rather than refetch. */
const CACHE_CONTROL = "private, no-cache";

/**
 * True when `If-None-Match` names the current entity tag. Handles the list form ("a", "b"), the
 * weak-validator prefix, and `*` — which per RFC 9110 means "any current representation", and
 * there is always one here.
 */
function ifNoneMatchHits(header: string, etag: string): boolean {
	return header.split(",").some((candidate) => {
		const tag = candidate.trim().replace(/^W\//, "");
		return tag === "*" || tag === etag;
	});
}

/**
 * Publishes the component-kind registry — which kinds exist, which are singletons, and the JSON
 * Schema of the fields an add / `--set` request may assign.
 *
 * This exists so the CLI's `componentKinds` / `singletonKinds` literals become a CACHE of a
 * published schema instead of a second opinion. They have already drifted: the Go list omits
 * `helm_registries`, which this registry authors. And `--set` coercion runs in Go against a raw
 * string with no idea of the field's type, while the type lives here — the split-brain this
 * document closes by shipping the type with the field name.
 *
 * GATING — the same as its siblings, and deliberately not weaker. The document is derived from
 * committed code, so it holds no tenant data and is byte-identical for every caller; that makes
 * it cheap to serve, not public. It describes the authorable surface of a project, so it is
 * gated exactly like the component list it describes (`GET /api/cli/projects/[id]/components`):
 * a verified CLI token plus `project:view` enforced by the PDP. Read-only is not unauthenticated.
 * There is no query, so there is no tenancy scoping to add on top — `authorizeCli` is the whole
 * boundary here rather than half of it.
 *
 * Cacheable by content hash: the body's `version` is served as the ETag, so a client that already
 * holds this version revalidates into a 304 with no body.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;

	try {
		const document = componentSchemaDocument();
		const etag = `"${document.version}"`;
		const headers = { ETag: etag, "Cache-Control": CACHE_CONTROL };

		const ifNoneMatch = req.headers.get("If-None-Match");
		if (ifNoneMatch && ifNoneMatchHits(ifNoneMatch, etag)) {
			return new NextResponse(null, { status: 304, headers });
		}

		return cliJson(componentSchemaWire, document, { headers });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
