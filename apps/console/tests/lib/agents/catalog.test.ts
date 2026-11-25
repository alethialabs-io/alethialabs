// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { AGENT_APPS, agentAppFor, agentAppIdentity } from "@/lib/agents/catalog";

describe("agentAppFor", () => {
	it("matches a CIMD client id by host", () => {
		expect(agentAppFor("https://cursor.com/oauth/client.json")?.slug).toBe("cursor");
	});

	it("matches a subdomain of a listed host", () => {
		expect(agentAppFor("https://mcp.cursor.sh/client-metadata.json")?.slug).toBe("cursor");
	});

	it("prefers the most specific pattern on a shared host", () => {
		expect(agentAppFor("https://claude.ai/code/oauth/metadata.json")?.slug).toBe("claude-code");
		expect(agentAppFor("https://claude.ai/oauth/mcp-oauth-client-metadata")?.slug).toBe("claude");
	});

	it("does not treat a path that merely starts with the same letters as the listed path", () => {
		expect(agentAppFor("https://claude.ai/codex/metadata.json")?.slug).toBe("claude");
	});

	it("does not match a host that only ends with the same letters", () => {
		expect(agentAppFor("https://notcursor.com/client.json")).toBeNull();
		expect(agentAppFor("https://cursor.com.attacker.test/client.json")).toBeNull();
	});

	it("never matches a client id that is not an https URL", () => {
		expect(agentAppFor("http://cursor.com/client.json")).toBeNull();
		expect(agentAppFor("abc123")).toBeNull();
	});

	it("gives every app a docs page under /docs/agents/ and a mark", () => {
		for (const app of AGENT_APPS) {
			expect(app.docsPath).toMatch(/^\/docs\/agents\/[a-z-]+$/);
			expect(app.mark.length).toBeGreaterThan(0);
			expect(app.hosts.length).toBeGreaterThan(0);
		}
		expect(new Set(AGENT_APPS.map((a) => a.slug)).size).toBe(AGENT_APPS.length);
	});
});

describe("agentAppIdentity", () => {
	it("names a known app by the catalogue and drops the client's own icon", () => {
		const id = agentAppIdentity({ clientId: "https://cursor.com/c.json", name: "cursor-mcp", icon: "https://x.test/i.png" });
		expect(id).toMatchObject({ name: "Cursor", icon: null, host: "cursor.com" });
		expect(id.app?.slug).toBe("cursor");
	});

	it("names an unknown app by the name it registered, with its own icon", () => {
		expect(agentAppIdentity({ clientId: "https://tools.acme.io/c.json", name: "Release bot", icon: "https://tools.acme.io/i.png" })).toEqual({
			app: null,
			name: "Release bot",
			icon: "https://tools.acme.io/i.png",
			host: "tools.acme.io",
		});
	});

	it("falls back to the host, then to a neutral name", () => {
		expect(agentAppIdentity({ clientId: "https://tools.acme.io/c.json", name: null, icon: null }).name).toBe("tools.acme.io");
		expect(agentAppIdentity({ clientId: "opaque-id", name: null, icon: null }).name).toBe("Unnamed app");
	});
});
