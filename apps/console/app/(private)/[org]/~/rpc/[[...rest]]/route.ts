// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { RPCHandler } from "@orpc/server/fetch";
import { UnauthorizedError } from "@/lib/auth/errors";
import { namesNoOrg } from "@/lib/authz/org-path";
import { runWithActor } from "@/lib/authz/actor-context";
import { currentActor } from "@/lib/authz/guard";
import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { hasAcceptedCurrentDocuments } from "@/lib/billing/eligibility";
import { errorDigest } from "@/lib/errors";
import { router } from "@/lib/rpc/router";

// Reads are per-user and per-tenant; nothing here is cacheable by a shared cache.
export const dynamic = "force-dynamic";

const handler = new RPCHandler(router);

/** Narrows a path to the `/…` shape oRPC's `prefix` option requires. */
function isRootedPath(path: string): path is `/${string}` {
	return path.startsWith("/");
}

/** The mount point, read from the RAW pathname (oRPC matches with `pathname.replace(prefix, "")`). */
function rpcPrefix(pathname: string): `/${string}` | null {
	const at = pathname.indexOf("/~/rpc");
	if (at < 0) return null;
	const prefix = pathname.slice(0, at + "/~/rpc".length);
	return isRootedPath(prefix) ? prefix : null;
}

/** A JSON refusal with no internals in it. */
function refusal(status: number, error: string): Response {
	return Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Serves the console's read router at `/{org}/~/rpc/*` and `/~/~/rpc/*` (ADR 0005 D1, #6113).
 *
 * THE ADDRESS DECIDES THE TENANT, and it is decided HERE, before oRPC sees the request (stress test
 * R4): `currentActor()` resolves the org from the path the proxy published, with its membership
 * check; a non-member gets a 404 like an unknown org, not the 500 oRPC would turn `notFound()` into.
 * The actor is then bound with `runWithActor`, so readers that call `authorize()` reuse it instead
 * of re-reading the session per call. A route handler never runs the `[org]` layout, so no read
 * here writes the session's active org.
 */
async function handle(request: Request): Promise<Response> {
	const pathname = new URL(request.url).pathname;
	const prefix = rpcPrefix(pathname);
	if (!prefix) return refusal(404, "Not found");
	// An address whose first segment names no org (`/docs/~/rpc`, `/blog/~/rpc`, …) would make
	// `currentActor()` fall back to the SESSION's org — the shape "the address decides the tenant"
	// exists to rule out. The read router has no org-less mount, so it is simply not found.
	if (namesNoOrg(pathname)) return refusal(404, "Not found");

	let actor: Actor;
	try {
		actor = await currentActor();
	} catch (error) {
		if ((errorDigest(error) ?? "").startsWith("NEXT_HTTP_ERROR_FALLBACK;404")) {
			return refusal(404, "Not found");
		}
		if (error instanceof UnauthorizedError) return refusal(401, "Unauthorized");
		if (error instanceof ForbiddenError) return refusal(403, "Forbidden");
		throw error;
	}

	// The clickwrap gate (#2372) applies to EVERY use of the product, and the private layout that
	// enforces it for pages never runs for a route handler (ADR 0005 stress test R14a). So the read
	// router asks the same question the layout asks, against the database, before serving anything.
	if (!(await hasAcceptedCurrentDocuments(actor.userId))) {
		return refusal(403, "Accept the current Terms to continue.");
	}

	const { matched, response } = await runWithActor(actor, () =>
		handler.handle(request, { prefix, context: { actor } }),
	);
	if (!matched) return refusal(404, "Not found");
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

export const GET = handle;
export const POST = handle;
