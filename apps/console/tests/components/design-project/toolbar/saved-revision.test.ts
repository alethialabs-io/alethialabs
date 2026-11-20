// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The revision a save records (#6832). The workbench seeds the board under
// `<hash of the design>:<hash of the identity list>`; after a save the board must hold the revision
// the server's next render of that design will carry, or it takes its own save for a foreign
// change.
//
// What is pinned here is the FORM: the design half is `designRevision` of what was saved, and the
// identity half is carried over. That the server reads back a design that hashes the same is not
// established by this file.

import { describe, expect, it } from "vitest";
import { savedRevision } from "@/components/design-project/canvas/toolbar/saved-revision";
import { buildDefaultFormValues, sourceRevision } from "@/components/design-project/source-project";
import { designRevision } from "@/lib/canvas/design-revision";

const design = buildDefaultFormValues();
const renamed = { ...design, project: { ...design.project, project_name: "shop" } };

describe("savedRevision", () => {
	it("is the saved design's hash with the seed's identity half", () => {
		expect(savedRevision("0000aaaa:1111bbbb", renamed)).toBe(`${designRevision(renamed)}:1111bbbb`);
	});

	it("is the revision the workbench computes for a server design with the same content", () => {
		// The workbench's own formula, for the design a save would send.
		const identities = "1111bbbb";
		const workbench = `${sourceRevision({ formData: renamed, provider: "aws" })}:${identities}`;
		expect(savedRevision(`${designRevision(design)}:${identities}`, renamed)).toBe(workbench);
	});

	it("moves when the design moves, and not otherwise", () => {
		const seed = `${designRevision(design)}:1111bbbb`;
		expect(savedRevision(seed, design)).toBe(seed);
		expect(savedRevision(seed, renamed)).not.toBe(seed);
	});

	it("records nothing for a board that was never seeded or whose revision has another form", () => {
		expect(savedRevision(null, design)).toBeUndefined();
		expect(savedRevision(undefined, design)).toBeUndefined();
		expect(savedRevision("", design)).toBeUndefined();
		expect(savedRevision("no-separator", design)).toBeUndefined();
		expect(savedRevision(":only-identities", design)).toBeUndefined();
	});
});
