// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shortcuts dialog must not advertise a save gesture on a live project.
//
// Regression guard: ⌘S used to run the CREATE handler in both modes, so pressing it while editing
// an existing project forked it into a duplicate and navigated away. The gesture now exists only in
// the create flow, and the hint list has to say the same thing — an advertised shortcut that does
// nothing is the bug in its quieter form.

import { describe, expect, it } from "vitest";
import { buildShortcuts } from "@/components/design-project/canvas/shortcuts";

const labels = (isMac: boolean, canSave: boolean) =>
	buildShortcuts(isMac, canSave).map((s) => s.label);

describe("buildShortcuts", () => {
	it("advertises Save project only in the create flow", () => {
		for (const isMac of [true, false]) {
			expect(labels(isMac, true)).toContain("Save project");
			expect(labels(isMac, false)).not.toContain("Save project");
		}
	});

	it("drops only that row — every other shortcut survives", () => {
		const create = labels(true, true);
		const edit = labels(true, false);
		expect(create.filter((l) => l !== "Save project")).toEqual(edit);
	});

	it("uses the platform's modifier glyph for the save row", () => {
		const mac = buildShortcuts(true, true).find((s) => s.label === "Save project");
		const other = buildShortcuts(false, true).find((s) => s.label === "Save project");
		expect(mac?.keys).toBe("⌘S");
		expect(other?.keys).toBe("Ctrl+S");
	});
});
