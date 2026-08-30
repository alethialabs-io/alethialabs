// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The MCP resource identifier, and the RFC 9728 path its metadata document lives at.
 *
 * These two facts have to agree in three places — the `mcp()` plugin that binds issued tokens to
 * the resource, the `requireMcpAuth()` wrapper that verifies that audience, and the route that
 * serves the metadata document a client is pointed to. #3318 is what happens when they do not:
 * `requireMcpAuth` was left to default the resource to the auth base URL (`/api/auth`), so the
 * 401 advertised metadata for a resource nobody serves, and the audience it verified was not the
 * audience `mcp()` mints. One constant, three consumers.
 */

/** The MCP endpoint's path. The resource identifier is this resolved against the base URL. */
const MCP_RESOURCE_PATH = "/api/mcp";

/**
 * RFC 9728 §3.1: metadata for a resource whose identifier carries a path is published under
 * `/.well-known/oauth-protected-resource` with that path INSERTED AFTER the well-known segment —
 * not appended to the resource. `@better-auth/oauth-provider` builds the `resource_metadata`
 * challenge parameter exactly this way.
 */
export const PROTECTED_RESOURCE_METADATA_PREFIX = "/.well-known/oauth-protected-resource";

/**
 * The hosts Better Auth accepts over plain `http`.
 *
 * Mirrors `isLoopbackHost` in `@better-auth/mcp` DELIBERATELY, including its quirks: it compares
 * against the bracketed `[::1]` (which is what WHATWG `URL.hostname` returns for an IPv6 literal)
 * and accepts any four-octet `127.x.y.z`. Being more permissive here would be worse than being
 * wrong — `mcp()` validates the resource while `betterAuth()` is being constructed, so a value we
 * accept and it rejects throws at MODULE LOAD and takes the whole auth surface down, sign-in
 * included. That is the failure this function exists to prevent.
 */
function isLoopbackHost(hostname: string): boolean {
	const octets = hostname.split(".");
	const isIpv4Loopback =
		octets.length === 4 &&
		octets[0] === "127" &&
		octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255);
	return hostname === "localhost" || hostname === "[::1]" || isIpv4Loopback;
}

/**
 * The canonical MCP resource identifier for a deployment, or null when it cannot form one.
 *
 * Null is a supported outcome, not an error: a self-host with a missing or relative base URL
 * loses the MCP connector and keeps its login page.
 */
export function mcpResourceFromBaseUrl(baseURL: string | null | undefined): string | null {
	if (!baseURL) return null;
	try {
		// Resolving an absolute path against the base drops any query or fragment the base
		// carried, which `mcp()` also rejects — so only the credentials check is left to make.
		const url = new URL(MCP_RESOURCE_PATH, baseURL);
		if (url.username || url.password) return null;
		if (url.protocol === "https:") return url.toString();
		if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
		return null;
	} catch {
		return null;
	}
}

/**
 * The path this deployment must serve the RFC 9728 metadata document at for `resource`.
 *
 * @param resource an absolute resource identifier URL.
 */
export function protectedResourceMetadataPath(resource: string): string {
	const { pathname } = new URL(resource);
	const resourcePath = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
	return `${PROTECTED_RESOURCE_METADATA_PREFIX}${resourcePath}`;
}
