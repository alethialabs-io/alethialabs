// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type AnyRouter, isLazy, isProcedure, unlazyRouter } from "@orpc/server";

/**
 * Every procedure in an oRPC router, as dotted paths (`jobs.page`), depth-first.
 *
 * LAZY NODES ARE RESOLVED, NOT SKIPPED (#6113 review). oRPC's `lazy(loader)` is an object whose
 * only key is a SYMBOL, so a walk over `Object.entries` sees `{}` and a lazily-loaded procedure or
 * sub-router silently drops out — while the route handler still serves it. The tenancy proof
 * enumerates through this function precisely so that cannot happen: the router is first resolved
 * with oRPC's own `unlazyRouter`, and any node that is still neither a procedure nor a plain
 * string-keyed object (a lazy root, a symbol-keyed value) THROWS, naming its path.
 */
export async function procedurePaths(router: unknown): Promise<string[]> {
	if (isLazy(router)) {
		throw new Error("(root): a lazy router root is not enumerable; import the root router eagerly");
	}
	return walk(await unlazyRouter(routerShaped(router)), []);
}

/**
 * Checks that an unknown value is the plain, string-keyed object shape `unlazyRouter` walks; the
 * nodes below the root are checked again by `walk` after resolution.
 */
function isRouterShaped(router: unknown): router is AnyRouter {
	return typeof router === "object" && router !== null && Object.getOwnPropertySymbols(router).length === 0;
}

/** The root, refused with a reason unless it is router-shaped. */
function routerShaped(router: unknown): AnyRouter {
	if (typeof router !== "object" || router === null) {
		throw new Error("(root): a router must be an object");
	}
	if (Object.getOwnPropertySymbols(router).length > 0) {
		throw new Error("(root): a symbol-keyed router node is invisible to a string-keyed walk");
	}
	if (!isRouterShaped(router)) throw new Error("(root): not a router");
	return router;
}

/** The walk over an already-unlazied router; throws on anything it cannot enumerate. */
function walk(node: unknown, path: string[]): string[] {
	const here = path.join(".") || "(root)";
	if (isProcedure(node)) return [here];
	if (isLazy(node)) throw new Error(`${here}: a lazy node survived unlazyRouter and cannot be enumerated`);
	if (typeof node !== "object" || node === null) {
		throw new Error(`${here}: neither a procedure nor a router (${typeof node})`);
	}
	if (Object.getOwnPropertySymbols(node).length > 0) {
		throw new Error(`${here}: a symbol-keyed router node is invisible to a string-keyed walk`);
	}
	return Object.entries(node).flatMap(([key, value]) => walk(value, [...path, key]));
}
