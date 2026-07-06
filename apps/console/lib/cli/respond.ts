// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { NextResponse } from "next/server";
import type { z } from "zod";

/**
 * Serializes a CLI response and validates it against its wire contract before
 * sending. This is the backend half of the CLI type-safety guarantee: a route
 * physically cannot emit a shape that diverges from the contract the Go client
 * decodes, because the payload is parsed (and stripped to the contract) here.
 *
 * The payload is normalized through JSON first so Drizzle Date objects become
 * the ISO strings the contract models, then validated; the validated, key-
 * stripped data is what ships. A contract violation is a server bug, so it logs
 * and returns 500 rather than leaking a malformed body to the CLI.
 */
export function cliJson<S extends z.ZodType>(
	schema: S,
	payload: unknown,
	init?: ResponseInit,
): NextResponse {
	const wire: unknown = JSON.parse(JSON.stringify(payload));
	const parsed = schema.safeParse(wire);
	if (!parsed.success) {
		console.error(
			"[cli] wire contract violation:",
			JSON.stringify(parsed.error.issues, null, 2),
		);
		return NextResponse.json(
			{ error: "Internal contract error" },
			{ status: 500 },
		);
	}
	return NextResponse.json(parsed.data, init);
}
