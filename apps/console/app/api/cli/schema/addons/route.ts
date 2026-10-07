// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";
import { authorizeCli } from "@/lib/authz/guard";
import { addonCatalogDocument } from "@/lib/cli/addon-catalog";
import { cliJson } from "@/lib/cli/respond";
import { cliAddonCatalogResponse } from "@/lib/validations/cli-contract";

/** `private` because the response is token-gated; short, for the reason the component schema
 *  route states: a stale copy could only make the CLI stricter than the server for that window. */
const CACHE_CONTROL = "private, max-age=300";

/**
 * Publishes the add-on catalog the CLI checks an `alethia.yaml` against (#5528): each add-on's id,
 * its default chart version, the NAMES of its secret settings, and its non-secret setting defaults,
 * plus the chart-version rule.
 *
 * It is project-independent on purpose. `alethia plan` must be able to refuse an unknown add-on or a
 * secret setting in a file that creates its project, when there is no project to ask about yet.
 *
 * Gated like its sibling `GET /api/cli/schema/components`: a verified CLI token plus `project:view`.
 * The document is a projection of committed code — no tenant data, no secret values — so there is
 * no query and no tenancy scoping to add on top.
 */
export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "project" });
	if ("error" in auth) return auth.error;
	try {
		return cliJson(cliAddonCatalogResponse, addonCatalogDocument(), {
			headers: { "Cache-Control": CACHE_CONTROL },
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
