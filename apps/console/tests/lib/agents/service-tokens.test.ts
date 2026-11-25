// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The auto-approve rule (AGT-L2, G10; decision D2) and a token's status.

import { describe, expect, it } from "vitest";
import { autoApproveRefusal, serviceTokenStatus } from "@/lib/agents/service-tokens";

const P1 = "p1";
const P2 = "p2";
const facts = [
	{ id: "staging-1", projectId: P1, stage: "staging" as const },
	{ id: "dev-2", projectId: P2, stage: "development" as const },
	{ id: "prod-1", projectId: P1, stage: "production" as const },
];
const deployer = { scopes: ["read", "plan", "apply"] as const, projectIds: null };

describe("autoApproveRefusal", () => {
	it("allows non-production environments of the token's projects", () => {
		expect(autoApproveRefusal(["staging-1", "dev-2"], deployer, facts)).toBeNull();
	});

	it("allows an empty list, whatever the token can do", () => {
		expect(autoApproveRefusal([], { scopes: ["read"], projectIds: [P1] }, [])).toBeNull();
	});

	it("refuses a production environment", () => {
		expect(autoApproveRefusal(["staging-1", "prod-1"], deployer, facts)).toBe("production");
	});

	it("refuses without the Deploy scope", () => {
		expect(autoApproveRefusal(["staging-1"], { scopes: ["read", "plan", "destroy"], projectIds: null }, facts)).toBe("needs_apply_scope");
	});

	it("refuses an environment outside the token's projects", () => {
		expect(autoApproveRefusal(["dev-2"], { scopes: ["apply"], projectIds: [P1] }, facts)).toBe("outside_token_projects");
	});

	it("refuses an environment that is not in the org", () => {
		expect(autoApproveRefusal(["elsewhere"], deployer, facts)).toBe("unknown_environment");
	});
});

describe("serviceTokenStatus", () => {
	const now = new Date("2026-11-24T12:00:00Z");
	it("reads revoked, expired and active", () => {
		expect(serviceTokenStatus({ revoked_at: now, expires_at: null }, now)).toBe("revoked");
		expect(serviceTokenStatus({ revoked_at: null, expires_at: new Date(now.getTime() - 1) }, now)).toBe("expired");
		expect(serviceTokenStatus({ revoked_at: null, expires_at: new Date(now.getTime() + 1) }, now)).toBe("active");
		expect(serviceTokenStatus({ revoked_at: null, expires_at: null }, now)).toBe("active");
	});

	it("reads a revoked and expired token as revoked", () => {
		expect(serviceTokenStatus({ revoked_at: now, expires_at: new Date(0) }, now)).toBe("revoked");
	});
});
