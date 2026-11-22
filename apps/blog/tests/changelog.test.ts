// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ChangelogItem, changelogEntries, versionChips } from "../lib/changelog";

describe("versionChips", () => {
	it("chips the CLI first, then the runner, each linking its release", () => {
		expect(versionChips({ runner: "0.10.1", cli: "0.10.0" })).toEqual([
			{ label: "CLI v0.10.0", href: "https://github.com/alethialabs-io/alethia-cli/releases/tag/v0.10.0" },
			{ label: "Runner v0.10.1", href: "https://github.com/alethialabs-io/alethialabs/releases/tag/runner-v0.10.1" },
		]);
	});

	it("chips only the versions an entry names, and accepts a leading v", () => {
		expect(versionChips({ runner: "v0.9.0" })).toEqual([
			{ label: "Runner v0.9.0", href: "https://github.com/alethialabs-io/alethialabs/releases/tag/runner-v0.9.0" },
		]);
		expect(versionChips(undefined)).toEqual([]);
		expect(versionChips({})).toEqual([]);
	});
});

describe("changelogEntries", () => {
	it("keeps only changelog entries, newest first, stable within a day", () => {
		const items: (ChangelogItem & { id: string })[] = [
			{ id: "a", kind: "changelog", date: "2026-09-30", versions: undefined },
			{ id: "post", kind: "engineering", date: "2026-12-01", versions: undefined },
			{ id: "b", kind: "changelog", date: "2026-11-18", versions: undefined },
			{ id: "c", kind: "changelog", date: "2026-11-18", versions: undefined },
		];
		expect(changelogEntries(items).map((i) => i.id)).toEqual(["b", "c", "a"]);
	});
});

/**
 * The curated entries in content/posts, read as text. velite validates the frontmatter types at
 * build time; this checks the SHAPE the changelog promises a reader — a bold headline, then New,
 * Improved and Fixed in that order — which no schema can.
 */
describe("the curated changelog entries", () => {
	const dir = join(import.meta.dirname, "../content/posts");
	const entries = readdirSync(dir)
		.filter((f) => f.endsWith(".mdx"))
		.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") }))
		.filter(({ text }) => /^kind:\s*changelog\s*$/m.test(text));

	it("exist", () => {
		expect(entries.length).toBeGreaterThan(0);
	});

	it.each(entries.map((e) => [e.file, e.text]))("%s leads with a headline, then New, Improved, Fixed", (_file, text) => {
		const body = text.replace(/^---[\s\S]*?\n---\n/, "").trim();
		expect(body.startsWith("**") || body.startsWith("{/*")).toBe(true);
		const sections = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
		expect(sections).toEqual(["New", "Improved", "Fixed"]);
	});

	it.each(entries.map((e) => [e.file, e.text]))("%s names a slug the changelog page does not shadow", (file) => {
		expect(file).not.toBe("changelog.mdx");
	});
});
