// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The command palette's Actions group and job labels (R6 S-07). The palette searched pages,
// projects and jobs only — no way to start creating anything — and every job read as its type
// alone, told apart from the next deploy by an eight-character id.

import { describe, expect, it } from "vitest";
import { paletteActions, paletteJobLabel } from "@/components/shell/command-palette";

describe("the palette's Actions group", () => {
	it("starts each common action on the page that owns it", () => {
		expect(paletteActions("acme").map(({ group, label, href }) => ({ group, label, href }))).toEqual([
			{ group: "Actions", label: "Create a project", href: "/acme/~/new" },
			{ group: "Actions", label: "Connect a cloud account", href: "/acme/~/connectors?type=cloud" },
			{ group: "Actions", label: "Invite an organization member", href: "/acme/~/settings/members" },
		]);
	});
});

describe("a job's palette label", () => {
	it("names the project the job ran for", () => {
		expect(paletteJobLabel("Deploy", "Shop")).toBe("Deploy · Shop");
	});

	it("is the type alone for a job with no project", () => {
		expect(paletteJobLabel("Runner update", null)).toBe("Runner update");
		expect(paletteJobLabel("Runner update", undefined)).toBe("Runner update");
	});
});
