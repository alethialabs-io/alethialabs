// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { checksFor } from "@/lib/authz/fga-mapping";

describe("checksFor (the OR-check)", () => {
	it("per-instance action with id ⇒ instance can_ OR org capability", () => {
		const checks = checksFor("zone", "view", { id: "Z", orgId: "O" });
		expect(checks).toEqual([
			{ object: "zone:Z", relation: "can_view" },
			{ object: "org:O", relation: "zone_view" },
		]);
	});

	it("per-instance action WITHOUT id ⇒ just the org capability", () => {
		expect(checksFor("zone", "view", { orgId: "O" })).toEqual([
			{ object: "org:O", relation: "zone_view" },
		]);
	});

	it("create ⇒ org capability only (create is org-level)", () => {
		expect(checksFor("zone", "create", { id: "Z", orgId: "O" })).toEqual([
			{ object: "org:O", relation: "zone_create" },
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
