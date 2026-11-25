// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// Reading an MCP access token's `scope` claim into the actor's ceiling (lib/auth/mcp-scopes.ts).
// Fail closed: no agent scope, or an undeclared scope, is a refusal.

import { describe, expect, it } from "vitest";
import { AGENT_SCOPES } from "@/lib/approvals/types";
import {
	agentScopesFromClaims,
	ceilingFromAccessTokenClaims,
	MCP_PROVIDER_SCOPES,
} from "@/lib/auth/mcp-scopes";

describe("the provider's declared scopes", () => {
	it("are the OpenID Connect scopes followed by every agent scope", () => {
		expect(MCP_PROVIDER_SCOPES).toEqual(["openid", "profile", "email", "offline_access", ...AGENT_SCOPES]);
	});
});

describe("agentScopesFromClaims", () => {
	it("reads the agent scopes and skips the OpenID Connect ones", () => {
		expect(agentScopesFromClaims({ scope: "openid offline_access read plan" })).toEqual({
			ok: true,
			scopes: ["read", "plan"],
		});
	});

	it("de-duplicates and tolerates repeated spaces", () => {
		expect(agentScopesFromClaims({ scope: "read  read design" })).toEqual({
			ok: true,
			scopes: ["read", "design"],
		});
	});

	it("refuses a token with no scope claim, a non-string one, or no agent scope", () => {
		expect(agentScopesFromClaims({})).toEqual({ ok: false, reason: "no_scope" });
		expect(agentScopesFromClaims({ scope: ["read"] })).toEqual({ ok: false, reason: "no_scope" });
		expect(agentScopesFromClaims({ scope: "" })).toEqual({ ok: false, reason: "no_scope" });
		expect(agentScopesFromClaims({ scope: "openid profile" })).toEqual({ ok: false, reason: "no_scope" });
	});

	it("refuses a token carrying any undeclared scope, even beside valid ones", () => {
		expect(agentScopesFromClaims({ scope: "read admin" })).toEqual({ ok: false, reason: "unknown_scope" });
		expect(agentScopesFromClaims({ scope: "READ" })).toEqual({ ok: false, reason: "unknown_scope" });
	});
});

describe("ceilingFromAccessTokenClaims", () => {
	it("limits a token with no project list to its scopes over every project", () => {
		expect(ceilingFromAccessTokenClaims({ scope: "openid read" }, null)).toEqual({
			scopes: ["read"],
			projectIds: null,
		});
	});

	it("carries the consent grant's project list in place of every project", () => {
		expect(ceilingFromAccessTokenClaims({ scope: "read plan" }, ["p1", "p2"])).toEqual({
			scopes: ["read", "plan"],
			projectIds: ["p1", "p2"],
		});
	});

	it("is null — a refusal — when the scopes cannot be read", () => {
		expect(ceilingFromAccessTokenClaims({ scope: "openid" }, null)).toBeNull();
		expect(ceilingFromAccessTokenClaims({ scope: "read write" }, ["p1"])).toBeNull();
	});

	it("is null — a refusal, never \"no limit\" — for an empty project list", () => {
		expect(ceilingFromAccessTokenClaims({ scope: "read" }, [])).toBeNull();
	});
});
