// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";

/** Lists verified cloud identities for the CLI user. */
export async function GET(req: Request) {
	const { payload, error: authError } = await verifyCliToken(req);
	if (authError) return authError;

	const userId = payload?.sub;
	if (!userId) {
		return NextResponse.json(
			{ error: "Invalid token payload" },
			{ status: 401 },
		);
	}

	try {
		const supabase = await createServiceRoleClient();

		const { data: identities, error } = await supabase
			.from("cloud_identities")
			.select("id, provider, credentials, is_verified, created_at")
			.eq("user_id", userId)
			.eq("is_verified", true)
			.order("provider", { ascending: true });

		if (error) {
			return NextResponse.json(
				{ error: error.message },
				{ status: 500 },
			);
		}

		const result = (identities ?? []).map((i: any) => ({
			id: i.id,
			provider: i.provider,
			label: buildLabel(i.provider, i.credentials),
			created_at: i.created_at,
		}));

		return NextResponse.json({ cloud_identities: result });
	} catch (err: unknown) {
		const message =
			err instanceof Error ? err.message : "Internal Server Error";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

function buildLabel(
	provider: string,
	credentials: Record<string, unknown> | null,
): string {
	if (!credentials) return provider.toUpperCase();

	switch (provider) {
		case "aws": {
			const accountId = credentials.account_id || credentials.aws_account_id;
			return accountId ? `AWS (${accountId})` : "AWS";
		}
		case "gcp": {
			const project = credentials.project_id || credentials.gcp_project_id;
			return project ? `GCP (${project})` : "GCP";
		}
		case "azure": {
			const sub = credentials.subscription_id;
			return sub ? `Azure (${sub})` : "Azure";
		}
		default:
			return provider.toUpperCase();
	}
}
