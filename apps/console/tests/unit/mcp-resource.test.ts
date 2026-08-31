// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The MCP resource identifier and its RFC 9728 metadata path (#3318).
//
// The expected paths below are written as LITERALS on purpose. Deriving them with the same
// helper under test would pass no matter what the helper did — and the production bug was
// exactly a wrong path that every internal consumer agreed on.

import { describe, expect, it } from "vitest";
import {
	mcpResourceFromBaseUrl,
	protectedResourceMetadataPath,
} from "@/lib/auth/mcp-resource";

describe("mcpResourceFromBaseUrl", () => {
	it("resolves the MCP endpoint against the deployment base URL", () => {
		expect(mcpResourceFromBaseUrl("https://alethialabs.io")).toBe(
			"https://alethialabs.io/api/mcp",
		);
	});

	it("ignores a path, query or fragment on the base URL", () => {
		// mcp() rejects a resource carrying a query or fragment; resolving an absolute path
		// against the base is what drops them.
		expect(mcpResourceFromBaseUrl("https://alethialabs.io/console?x=1#y")).toBe(
			"https://alethialabs.io/api/mcp",
		);
	});

	it("allows plain http only on loopback", () => {
		expect(mcpResourceFromBaseUrl("http://localhost:3000")).toBe(
			"http://localhost:3000/api/mcp",
		);
		expect(mcpResourceFromBaseUrl("http://127.0.0.1:3000")).toBe(
			"http://127.0.0.1:3000/api/mcp",
		);
		// A LAN dev URL is the case that matters: mcp() throws on it while betterAuth() is being
		// constructed, which takes sign-in down with it, so this must return null rather than a
		// value the plugin will reject.
		expect(mcpResourceFromBaseUrl("http://192.168.1.10:3000")).toBeNull();
		expect(mcpResourceFromBaseUrl("http://console.internal:3000")).toBeNull();
	});

	it("returns null for a base URL that cannot form a resource", () => {
		expect(mcpResourceFromBaseUrl(undefined)).toBeNull();
		expect(mcpResourceFromBaseUrl("")).toBeNull();
		expect(mcpResourceFromBaseUrl("/relative")).toBeNull();
		expect(mcpResourceFromBaseUrl("ftp://alethialabs.io")).toBeNull();
		expect(mcpResourceFromBaseUrl("https://user:pass@alethialabs.io")).toBeNull();
	});
});

describe("protectedResourceMetadataPath", () => {
	it("inserts the resource path after the well-known segment", () => {
		expect(protectedResourceMetadataPath("https://alethialabs.io/api/mcp")).toBe(
			"/.well-known/oauth-protected-resource/api/mcp",
		);
	});

	it("is the bare well-known path for a root resource", () => {
		expect(protectedResourceMetadataPath("https://alethialabs.io/")).toBe(
			"/.well-known/oauth-protected-resource",
		);
	});

	it("does not name the auth base path", () => {
		// The shipped 401 advertised `/.well-known/oauth-protected-resource/api/auth`, metadata
		// for the authorization server rather than the protected resource. Stated as its own
		// assertion because it is the defect, not a variant of the case above.
		expect(protectedResourceMetadataPath("https://alethialabs.io/api/mcp")).not.toContain(
			"/api/auth",
		);
	});
});
