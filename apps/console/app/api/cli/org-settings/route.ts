// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/cli/org-settings — the active organization's general settings (name/slug/description +
// the default region / environment / terraform version). Gated on org `view`; scoped to the
// caller's resolved org. Reuses orgSettingsForOrg (the shared read behind the web getOrgSettings).
// `settings` is null when the caller is in community (personal) mode — orgId === userId.

import { NextResponse } from "next/server";
import { orgSettingsForOrg } from "@/app/server/actions/org-settings";
import { authorizeCli } from "@/lib/authz/guard";
import { cliJson } from "@/lib/cli/respond";
import { cliOrgSettingsResponse } from "@/lib/validations/cli-contract";

export async function GET(req: Request) {
	const auth = await authorizeCli(req, "view", { type: "org" });
	if ("error" in auth) return auth.error;
	const { actor } = auth;

	try {
		// Community (personal) mode has no real org — orgId falls back to the user id.
		if (actor.orgId === actor.userId) {
			return cliJson(cliOrgSettingsResponse, { settings: null });
		}
		const s = await orgSettingsForOrg(actor.orgId);
		if (!s) return cliJson(cliOrgSettingsResponse, { settings: null });

		return cliJson(cliOrgSettingsResponse, {
			settings: {
				name: s.name,
				slug: s.slug,
				description: s.description,
				logo: s.logo,
				region: s.region,
				default_env: s.defaultEnv,
				terraform_version: s.terraformVersion,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
