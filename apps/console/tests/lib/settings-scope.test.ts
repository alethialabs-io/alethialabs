// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the settings scope model: deriving org-vs-project scope from a pathname and
// filtering the settings sections to the current scope.

import { describe, expect, it } from "vitest";
import { settingsScope } from "@/components/shell/nav-config";
import { settingsNavItemsForScope } from "@/components/settings/settings-nav-items";

describe("settingsScope", () => {
	it("detects the org scope under the reserved ~ segment", () => {
		expect(settingsScope("/acme/~/settings")).toEqual({ kind: "org" });
		expect(settingsScope("/acme/~/settings/billing")).toEqual({ kind: "org" });
	});

	it("detects a project scope and carries the project slug", () => {
		expect(settingsScope("/acme/prod/settings/activity")).toEqual({
			kind: "project",
			projectSlug: "prod",
		});
	});

	it("returns null for non-settings paths", () => {
		expect(settingsScope("/acme")).toBeNull();
		expect(settingsScope("/acme/~/jobs")).toBeNull();
		expect(settingsScope("/acme/prod")).toBeNull();
		expect(settingsScope("/acme/prod/staging")).toBeNull(); // an environment, not settings
	});
});

describe("settingsNavItemsForScope", () => {
	it("shows the full section list at the org scope", () => {
		const subs = settingsNavItemsForScope("org").map((i) => i.sub);
		expect(subs).toEqual([
			"general",
			"billing",
			"members",
			"teams",
			"roles",
			"access",
			"sso",
			"activity",
		]);
	});

	it("shows the project-scopable sections inside a project (General · Access · Activity)", () => {
		const subs = settingsNavItemsForScope("project").map((i) => i.sub);
		expect(subs).toEqual(["general", "access", "activity"]);
		// Org-only surfaces never leak into project scope.
		expect(subs).not.toContain("billing");
		expect(subs).not.toContain("sso");
	});
});
