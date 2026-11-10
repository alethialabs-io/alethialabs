// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's refusal reading (#6306, follow-up to #6124). The read route answers a
// request with no session (401) and its own refusals (403) with PLAIN JSON, before oRPC runs — so
// the browser sees a NON-defined oRPC error carrying only the status. Those are refusals as surely
// as a typed FORBIDDEN, and must not be read (or retried) as a load failure.
//
// The plain-JSON errors here are produced by the REAL oRPC client decoding a real `Response`, not
// hand-built — the shape under test is whatever the shipped client makes of the route's answer.

import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { isRefused, retryUnlessRefused } from "@/components/connectors/connectors-board";
import type { AppRouter } from "@/lib/rpc/router";

/** The error the browser client throws when the read route answers `status` with a plain JSON body. */
async function wireError(status: number, error: string): Promise<unknown> {
	const client: RouterClient<AppRouter> = createORPCClient(
		new RPCLink({
			url: "http://console.test/acme/~/rpc",
			method: () => "GET",
			fetch: async () => Response.json({ error }, { status }),
		}),
	);
	return client.connectors.board({}).then(
		() => {
			throw new Error("the read was expected to fail");
		},
		(thrown: unknown) => thrown,
	);
}

describe("isRefused — the read route's own plain-JSON answers", () => {
	it("a plain 401 (no session) is refused, though the client marks it non-defined", async () => {
		const error = await wireError(401, "Unauthorized");
		expect(error).toBeInstanceOf(ORPCError);
		expect(error instanceof ORPCError && error.defined).toBe(false);
		expect(isRefused(error)).toBe(true);
	});

	it("a plain 403 is refused", async () => {
		expect(isRefused(await wireError(403, "Forbidden"))).toBe(true);
	});

	it("a plain 500 is a failure, not a refusal", async () => {
		expect(isRefused(await wireError(500, "Internal"))).toBe(false);
	});

	it("a plain 404 is not read as a refusal", async () => {
		expect(isRefused(await wireError(404, "Not found"))).toBe(false);
	});

	it("a typed FORBIDDEN from a procedure is still refused", () => {
		expect(isRefused(new ORPCError("FORBIDDEN", { defined: true }))).toBe(true);
	});

	it("a thrown non-oRPC error is not a refusal", () => {
		expect(isRefused(new Error("network down"))).toBe(false);
	});
});

describe("retryUnlessRefused — no retry that cannot work", () => {
	it("never retries a plain 401 or 403", async () => {
		expect(retryUnlessRefused(0, await wireError(401, "Unauthorized"))).toBe(false);
		expect(retryUnlessRefused(0, await wireError(403, "Forbidden"))).toBe(false);
	});

	it("retries a plain 500 once, then stops", async () => {
		const error = await wireError(500, "Internal");
		expect(retryUnlessRefused(0, error)).toBe(true);
		expect(retryUnlessRefused(1, error)).toBe(false);
	});
});
