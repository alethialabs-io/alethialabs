// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI `--set key=value` gate (lib/cli/project-components.validateComponentFields).
//
// `alethia project component set` builds an UNTYPED map on the Go side (cmd/project_component.go),
// so this registry schema is the only thing standing between the wire and the column. #1767 added
// `apps_path` to the repositories kind, and the raw drizzle-zod insert schema for a nullable
// text() column accepts ANY string — including "../../etc", which then rides all the way into
// buildConfigSnapshot and only dies when the deploy job hits argocd.ValidateAppsPath. These tests
// pin the mirrored guard onto the CLI path, which the canvas-side schema does not cover.

import { describe, expect, it } from "vitest";
import { validateComponentFields } from "@/lib/cli/project-components";

describe("validateComponentFields — repositories.apps_path (#1767)", () => {
	it("accepts the canonical per-tier overlay", () => {
		const res = validateComponentFields("repositories", { apps_path: "overlays/dev" });
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.values.apps_path).toBe("overlays/dev");
	});

	it("accepts the apps repo and the overlay together", () => {
		const res = validateComponentFields("repositories", {
			apps_destination_repo: "https://github.com/acme/apps",
			apps_path: "k8s/overlays/prod-eu",
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.values).toEqual({
				apps_destination_repo: "https://github.com/acme/apps",
				apps_path: "k8s/overlays/prod-eu",
			});
		}
	});

	it.each([
		["../../etc", "a traversal out of the apps repo"],
		["/abs/path", "an absolute path"],
		["overlays/dev/", "a trailing slash"],
		["overlays//dev", "an empty segment"],
		["overlays/'dev'", "a quote that breaks out of the rendered YAML scalar"],
		["overlays/$(id)", "shell-ish runes"],
		["overlays/my dev", "a space"],
	])("rejects %j (%s) at the CLI, not at deploy time", (value) => {
		const res = validateComponentFields("repositories", { apps_path: value });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("apps_path");
	});

	it("normalises surrounding whitespace so the stored value is what the guard judged", () => {
		const res = validateComponentFields("repositories", { apps_path: "  overlays/dev  " });
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.values.apps_path).toBe("overlays/dev");
	});

	// The invariant #1767 turns on: `""` must stay `""` (falsy), so buildConfigSnapshot leaves the
	// key ABSENT and the runner keeps syncing the repository root byte-identically.
	it("keeps an empty path empty — never a default, never a null", () => {
		const res = validateComponentFields("repositories", { apps_path: "" });
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.values.apps_path).toBe("");
	});

	it("still rejects an unknown field on the kind", () => {
		const res = validateComponentFields("repositories", { apps_pth: "overlays/dev" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("Unknown field(s) for repositories");
	});
});
