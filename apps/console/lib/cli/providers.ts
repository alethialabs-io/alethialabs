// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { verifyCliToken } from "@/lib/cli/auth";
import { getActiveScope } from "@/lib/auth/scope";
import type { CloudProvider, ConnScope } from "@/lib/cloud-providers/connections";
import { NextResponse } from "next/server";

const PROVIDERS: readonly CloudProvider[] = ["aws", "gcp", "azure"];

export function isCloudProvider(value: string): value is CloudProvider {
	return (PROVIDERS as readonly string[]).includes(value);
}

type Resolved =
	| {
			userId: string;
			scope: ConnScope;
			provider: CloudProvider;
			errorResponse: null;
	  }
	| { userId: null; scope: null; provider: null; errorResponse: Response };

/**
 * Verifies the CLI bearer token and validates the `[provider]` route segment.
 * Returns the user id, the actor's org-scope (cloud connections are org-scoped),
 * and the typed provider, or a ready-to-return error response.
 */
export async function resolveCliProvider(
	req: Request,
	params: Promise<{ provider: string }>,
): Promise<Resolved> {
	const { payload, error } = await verifyCliToken(req);
	if (error) {
		return { userId: null, scope: null, provider: null, errorResponse: error };
	}

	const userId = payload?.sub;
	if (!userId) {
		return {
			userId: null,
			scope: null,
			provider: null,
			errorResponse: NextResponse.json(
				{ error: "Invalid token payload" },
				{ status: 401 },
			),
		};
	}

	const { provider } = await params;
	if (!isCloudProvider(provider)) {
		return {
			userId: null,
			scope: null,
			provider: null,
			errorResponse: NextResponse.json(
				{ error: `Unsupported provider: ${provider}` },
				{ status: 400 },
			),
		};
	}

	const scope = await getActiveScope(userId);
	return { userId, scope, provider, errorResponse: null };
}

/** Maps a thrown error to a JSON error response with the given status. */
export function errorResponse(err: unknown, status = 400): NextResponse {
	const message = err instanceof Error ? err.message : "Internal Server Error";
	return NextResponse.json({ error: message }, { status });
}
