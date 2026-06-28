// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	envHref,
	globalHref,
	orgHref,
	PERSONAL_ORG_SLUG,
	pickFreeSlug,
	projectHref,
	projectSettingsHref,
	RESERVED_PROJECT_CHILD_SLUGS,
	RESERVED_SLUGS,
	slugify,
} from "@/lib/routing";

describe("slugify", () => {
	it("lowercases, trims, and hyphenates non-alphanumerics", () => {
		expect(slugify("  Acme Cloud  ")).toBe("acme-cloud");
		expect(slugify("Foo___Bar!!Baz")).toBe("foo-bar-baz");
	});

	it("strips leading/trailing dashes and collapses runs", () => {
		expect(slugify("--Hello  World--")).toBe("hello-world");
	});

	it("returns empty string for input with no alphanumerics", () => {
		expect(slugify("@#$%")).toBe("");
	});
});

describe("pickFreeSlug", () => {
	it("returns the base when it's free", () => {
		expect(pickFreeSlug("acme", ["other"])).toBe("acme");
	});

	it("appends -2, -3 … to avoid collisions", () => {
		expect(pickFreeSlug("acme", ["acme"])).toBe("acme-2");
		expect(pickFreeSlug("acme", ["acme", "acme-2"])).toBe("acme-3");
	});

	it("ignores null entries in the taken list", () => {
		expect(pickFreeSlug("acme", [null, null])).toBe("acme");
	});
});

describe("href builders", () => {
	it("build the C2 drilldown paths", () => {
		expect(orgHref("acme")).toBe("/acme");
		expect(globalHref("acme", "settings/billing")).toBe("/acme/~/settings/billing");
		expect(projectHref("acme", "api")).toBe("/acme/api");
		expect(envHref("acme", "api", "staging")).toBe("/acme/api/staging");
		expect(projectSettingsHref("acme", "api", "activity")).toBe(
			"/acme/api/settings/activity",
		);
	});
});

describe("RESERVED_PROJECT_CHILD_SLUGS", () => {
	it("reserves 'settings' so it can't shadow the project settings route", () => {
		expect(RESERVED_PROJECT_CHILD_SLUGS).toContain("settings");
	});

	it("keeps a generated project slug off the reserved segments", () => {
		// createProject passes existing slugs + the reserved set to pickFreeSlug.
		expect(pickFreeSlug("settings", [...RESERVED_PROJECT_CHILD_SLUGS])).toBe("settings-2");
	});
});

describe("RESERVED_SLUGS", () => {
	it("reserves the personal scope and console route shadows", () => {
		expect(PERSONAL_ORG_SLUG).toBe("~");
		for (const s of ["~", "dashboard", "api", "auth", "docs", "blog"]) {
			expect(RESERVED_SLUGS.has(s)).toBe(true);
		}
	});

	it("does not reserve an ordinary org slug", () => {
		expect(RESERVED_SLUGS.has("acme")).toBe(false);
	});
});
