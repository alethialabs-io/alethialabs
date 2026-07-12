// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { checksFor, denyChecksFor } from "@/lib/authz/fga-mapping";

describe("checksFor (the OR-check)", () => {
	it("per-instance action with id ⇒ instance can_ OR org capability", () => {
		const checks = checksFor("project", "view", { id: "S", orgId: "O" });
		expect(checks).toEqual([
			{ object: "project:S", relation: "can_view" },
			{ object: "org:O", relation: "project_view" },
		]);
	});

	it("per-instance action WITHOUT id ⇒ just the org capability", () => {
		expect(checksFor("project", "view", { orgId: "O" })).toEqual([
			{ object: "org:O", relation: "project_view" },
		]);
	});

	it("create ⇒ org capability only (create is org-level)", () => {
		expect(checksFor("project", "create", { id: "S", orgId: "O" })).toEqual([
			{ object: "org:O", relation: "project_create" },
		]);
	});

	it("org-level resources ⇒ org capability only", () => {
		expect(checksFor("member", "manage_members", { orgId: "O" })).toEqual([
			{ object: "org:O", relation: "member_manage_members" },
		]);
		expect(checksFor("job", "view", { id: "J", orgId: "O" })).toEqual([
			{ object: "org:O", relation: "job_view" },
		]);
	});
});

describe("denyChecksFor (the deny-wins VETO)", () => {
	it("per-instance action with id ⇒ instance deny_ OR org deny capability", () => {
		// Mirrors checksFor's two-tier shape: the instance's effective deny (per-instance
		// OR inherited) AND the org-wide deny fallback (for instances without a parent edge).
		expect(denyChecksFor("project", "view", { id: "S", orgId: "O" })).toEqual([
			{ object: "project:S", relation: "deny_view" },
			{ object: "org:O", relation: "project_deny_view" },
		]);
	});

	it("per-instance action WITHOUT id ⇒ just the org deny capability", () => {
		expect(denyChecksFor("project", "view", { orgId: "O" })).toEqual([
			{ object: "org:O", relation: "project_deny_view" },
		]);
	});

	it("create ⇒ org deny capability only (create is org-level)", () => {
		expect(denyChecksFor("project", "create", { id: "S", orgId: "O" })).toEqual([
			{ object: "org:O", relation: "project_deny_create" },
		]);
	});

	it("org-level resources ⇒ org deny capability only", () => {
		expect(denyChecksFor("member", "manage_members", { orgId: "O" })).toEqual([
			{ object: "org:O", relation: "member_deny_manage_members" },
		]);
		expect(denyChecksFor("job", "view", { id: "J", orgId: "O" })).toEqual([
			{ object: "org:O", relation: "job_deny_view" },
		]);
	});
});
