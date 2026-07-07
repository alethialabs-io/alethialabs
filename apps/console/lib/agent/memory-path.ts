// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Agent memory namespacing (elench). Anthropic's memory tool exposes a `/memories`
 * path the model controls; we map it onto a per-tenant namespace so one tenant can
 * NEVER read another's memory. This module is the single chokepoint that derives a
 * namespace and validates a model-supplied path against traversal escapes — the
 * same per-org isolation discipline as the rest of the platform.
 */

/** Derive the storage namespace for an org (+ optional project). */
export function memoryNamespace(orgId: string, projectId?: string | null): string {
	const org = sanitizeSegment(orgId, "orgId");
	if (projectId) {
		return `org/${org}/project/${sanitizeSegment(projectId, "projectId")}`;
	}
	return `org/${org}`;
}

/** A path segment must be a non-empty id-like token (uuid/slug) — no separators. */
function sanitizeSegment(seg: string, label: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(seg)) {
		throw new Error(`invalid ${label} for memory namespace: ${JSON.stringify(seg)}`);
	}
	return seg;
}

/**
 * Validate a model-supplied memory path and return it normalized (relative, no
 * leading slash, forward-slash separated). Throws on any traversal escape so the
 * caller can store it safely under a namespace. Rejects: absolute paths, `..`
 * segments, backslashes, null bytes, `.`-only segments, and empty paths.
 */
export function safeMemoryPath(rawPath: string): string {
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		throw new Error("memory path must be a non-empty string");
	}
	if (rawPath.includes("\0")) {
		throw new Error("memory path must not contain null bytes");
	}
	if (rawPath.includes("\\")) {
		throw new Error("memory path must not contain backslashes");
	}
	// Allow an optional "/memories" or "memories" mount prefix (the memory tool's
	// mount point). Any OTHER absolute path is rejected outright rather than silently
	// neutralized, so the contract is unambiguous.
	let p: string;
	if (/^\/?memories(\/|$)/.test(rawPath)) {
		p = rawPath.replace(/^\/?memories\/?/, "");
	} else if (rawPath.startsWith("/")) {
		throw new Error("absolute memory path not allowed");
	} else {
		p = rawPath;
	}

	const segments = p.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) {
		throw new Error("memory path resolves to an empty path");
	}
	for (const seg of segments) {
		if (seg === "." || seg === "..") {
			throw new Error(`memory path traversal segment not allowed: ${seg}`);
		}
	}
	return segments.join("/");
}

/**
 * Resolve a fully-qualified, traversal-safe storage key for a tenant's memory path.
 * This is what callers should persist as agent_memory.path under the namespace.
 */
export function resolveMemoryKey(
	orgId: string,
	projectId: string | null | undefined,
	rawPath: string,
): { namespace: string; path: string } {
	return {
		namespace: memoryNamespace(orgId, projectId),
		path: safeMemoryPath(rawPath),
	};
}
