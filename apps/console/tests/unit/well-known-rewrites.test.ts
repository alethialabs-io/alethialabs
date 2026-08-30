// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The rewrites that make the RFC 9728 metadata path reachable at all (#3318).
//
// The route handler is useless without them: Better Auth is mounted at /api/auth, so nothing
// routed a root `.well-known` request anywhere, and the console's `/{org}` wildcard answered it
// with the HTML shell. `beforeFiles` is the half that matters — an `afterFiles` rewrite still
// loses to a page route, which is how the shell came to answer a discovery URL in the first place.

import { describe, expect, it } from "vitest";

import config, { type NextConfigInput } from "../../next.config";

interface RewriteRule {
	source: string;
	destination: string;
}

/** The `{ beforeFiles, afterFiles, fallback }` form of a `rewrites()` result. */
interface RewriteGroups {
	beforeFiles: RewriteRule[];
}

function hasRewrites(value: unknown): value is { rewrites: () => Promise<unknown> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"rewrites" in value &&
		typeof value.rewrites === "function"
	);
}

function hasBeforeFiles(value: unknown): value is RewriteGroups {
	return (
		typeof value === "object" &&
		value !== null &&
		"beforeFiles" in value &&
		Array.isArray(value.beforeFiles)
	);
}

/** Resolves a config the way Next does: invoke it if it is a function, else use it as-is. */
async function resolveLikeNext(input: NextConfigInput): Promise<unknown> {
	return typeof input === "function"
		? await input("phase-production-build", { defaultConfig: {} })
		: input;
}

/** Resolve the config the way Next does, then read the rewrites it declares first. */
async function beforeFileRewrites(): Promise<RewriteRule[]> {
	const resolved = await resolveLikeNext(config);
	if (!hasRewrites(resolved)) throw new Error("the console config declares no rewrites()");

	const rewrites = await resolved.rewrites();
	// An array result would mean `afterFiles` semantics — which a page route beats.
	if (!hasBeforeFiles(rewrites)) {
		throw new Error("rewrites() no longer returns the beforeFiles/afterFiles form");
	}
	return rewrites.beforeFiles;
}

describe("the well-known protected-resource rewrites", () => {
	it("routes the bare metadata path to the handler, before any page route", async () => {
		expect(await beforeFileRewrites()).toContainEqual({
			source: "/.well-known/oauth-protected-resource",
			destination: "/api/oauth-protected-resource",
		});
	});

	it("routes every suffix under it to the handler", async () => {
		// Broad on purpose: an unrecognised suffix must reach the handler's JSON 404 rather than
		// fall through to the HTML shell, which is the failure the issue measured.
		expect(await beforeFileRewrites()).toContainEqual({
			source: "/.well-known/oauth-protected-resource/:path*",
			destination: "/api/oauth-protected-resource/:path*",
		});
	});
});
