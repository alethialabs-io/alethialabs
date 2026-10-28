// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { projectOrgRefusal } from "@/lib/projects/project-org";

const teamActor = { userId: "user-1", orgId: "org-1" };

describe("projectOrgRefusal", () => {
	it("allows a project that lives in the actor's org", () => {
		expect(projectOrgRefusal("org-1", teamActor)).toBeNull();
	});

	it("allows a personal-workspace project from the personal workspace", () => {
		expect(projectOrgRefusal("user-1", { userId: "user-1", orgId: "user-1" })).toBeNull();
	});

	it("names the personal workspace for its project acted on from a team org", () => {
		expect(projectOrgRefusal("user-1", teamActor)).toBe(
			"This project belongs to your personal workspace — switch to it to run this.",
		);
	});

	it("names another organization for any other org, and for a project with no org", () => {
		const other = "This project belongs to another organization — switch to it to run this.";
		expect(projectOrgRefusal("org-2", teamActor)).toBe(other);
		expect(projectOrgRefusal(null, teamActor)).toBe(other);
	});
});
