// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { slugify } from "@/lib/slug";

describe("slugify", () => {
	it("lowercases, trims, and hyphenates non-alphanumeric runs", () => {
		expect(slugify("  Acme Cloud  ")).toBe("acme-cloud");
		expect(slugify("Foo___Bar!!Baz")).toBe("foo-bar-baz");
		expect(slugify("--Hello  World--")).toBe("hello-world");
	});

	it("drops apostrophes instead of turning them into dashes (Vercel-style)", () => {
		expect(slugify("bobikenobi12's Org")).toBe("bobikenobi12s-org");
		expect(slugify("Bob's Team")).toBe("bobs-team");
		// curly apostrophe + modifier-letter apostrophe both vanish too
		expect(slugify("Bob’s Team")).toBe("bobs-team");
		expect(slugify("Bobʼs Team")).toBe("bobs-team");
	});

	it("folds accents to their base letters", () => {
		expect(slugify("José's Café")).toBe("joses-cafe");
		expect(slugify("Zürich")).toBe("zurich");
		expect(slugify("naïve coördination")).toBe("naive-coordination");
	});

	it("returns an empty string when nothing slugifiable remains", () => {
		expect(slugify("@#$%")).toBe("");
		expect(slugify("''")).toBe("");
	});

	it("caps to maxLength and re-trims a trailing dash the cut exposes", () => {
		expect(slugify("my-very-long-project-name-here", 10)).toBe("my-very-lo");
		// the 10-char cut would land on a dash → trimmed
		expect(slugify("ab cd ef gh ij", 6)).toBe("ab-cd");
		expect(slugify("repo", 25)).toBe("repo");
	});
});
