// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// lib/validations/org-slug.ts (#5509) — THE org-slug rule, and the claim that it is the only copy.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_SLUG_MAX_LENGTH, ORG_SLUG_PATTERN, isOrgSlug } from "@/lib/validations/org-slug";

describe("isOrgSlug", () => {
	it.each(["acme", "acme-cloud", "a1-b2-c3", "7", "a".repeat(ORG_SLUG_MAX_LENGTH)])("accepts %j", (slug) => {
		expect(isOrgSlug(slug)).toBe(true);
	});

	it.each(["-acme", "acme-", "acme--cloud", "-", "", "Acme", "acme cloud", "acme_cloud", "a".repeat(ORG_SLUG_MAX_LENGTH + 1)])(
		"refuses %j",
		(slug) => {
			expect(isOrgSlug(slug)).toBe(false);
		},
	);

	it("is the DNS-1123 label length", () => {
		expect(ORG_SLUG_MAX_LENGTH).toBe(63);
	});
});

// The defect #5509 closed was a FIFTH hand copy of this regex that had drifted (`*` for `+`). This
// reads the console's source for the pattern's text, so a new copy fails here instead of drifting.
// Its bound: it matches the rule's exact source text in .ts/.tsx under app/, components/ and lib/,
// so a copy re-spelled differently (another group, `[0-9a-z]`) is not seen.
describe("the org-slug pattern has one copy", () => {
	const consoleRoot = join(__dirname, "..", "..", "..");
	const home = join("lib", "validations", "org-slug.ts");

	/** Every .ts/.tsx file under `dir`, recursively. */
	function sources(dir: string): string[] {
		return readdirSync(dir).flatMap((name) => {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sources(path);
			return /\.tsx?$/.test(name) ? [path] : [];
		});
	}

	it("appears only in lib/validations/org-slug.ts", () => {
		const text = ORG_SLUG_PATTERN.source;
		const copies = ["app", "components", "lib"]
			.flatMap((d) => sources(join(consoleRoot, d)))
			.filter((path) => readFileSync(path, "utf8").includes(text))
			.map((path) => relative(consoleRoot, path));
		expect(copies).toEqual([home]);
	});
});
