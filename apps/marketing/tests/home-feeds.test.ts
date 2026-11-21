// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { parseReleases, parseRss, releaseSummary, releaseTitle } from "../lib/home/feeds";

describe("releaseTitle", () => {
	it("capitalises a release-please component and keeps the version", () => {
		expect(releaseTitle("runner: v0.10.1")).toBe("Runner v0.10.1");
		expect(releaseTitle("cli: v0.5.0")).toBe("CLI v0.5.0");
	});

	it("returns a name without a component prefix as it is", () => {
		expect(releaseTitle("  Spring update  ")).toBe("Spring update");
	});
});

describe("releaseSummary", () => {
	const body = [
		"## [0.10.1](https://github.com/x/y/compare/a...b) (2026-11-17)",
		"",
		"### Bug Fixes",
		"",
		"* **runner:** retry the [state upload](https://example.com/doc) on a 503 ([#7012](https://github.com/x/y/issues/7012)) ([4f3c2b1](https://github.com/x/y/commit/4f3c2b1))",
		"* second change",
	].join("\n");

	it("takes the first bullet as plain text, without scope, links or references", () => {
		expect(releaseSummary(body)).toBe("Retry the state upload on a 503");
	});

	it("returns an empty string when the body has no bullet", () => {
		expect(releaseSummary("## Nothing listed")).toBe("");
	});
});

describe("parseReleases", () => {
	const release = (over: Record<string, unknown>) => ({
		name: "runner: v0.10.1",
		html_url: "https://github.com/alethialabs-io/alethialabs/releases/tag/runner-v0.10.1",
		published_at: "2026-11-17T09:42:47Z",
		body: "* fixed it",
		draft: false,
		prerelease: false,
		...over,
	});

	it("skips drafts, pre-releases and incomplete entries, and stops at the limit", () => {
		const items = parseReleases(
			[release({ draft: true }), release({ prerelease: true }), release({ html_url: "" }), release({}), release({ name: "cli: v0.5.0" }), release({ name: "cli: v0.4.0" })],
			2,
		);
		expect(items.map((i) => i.title)).toEqual(["Runner v0.10.1", "CLI v0.5.0"]);
		expect(items[0]?.summary).toBe("Fixed it");
	});

	it("returns an empty list for anything that is not an array", () => {
		expect(parseReleases({ message: "rate limited" }, 3)).toEqual([]);
	});
});

describe("parseRss", () => {
	const xml = `<?xml version="1.0"?><rss><channel>
		<item><title><![CDATA[Older &amp; wiser]]></title><link>https://alethialabs.io/blog/older</link><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><description>First</description></item>
		<item><title>Newer</title><link>https://alethialabs.io/blog/newer</link><pubDate>Tue, 18 Nov 2026 10:00:00 GMT</pubDate><description>Second</description></item>
		<item><title>No link</title><pubDate>Tue, 18 Nov 2026 10:00:00 GMT</pubDate></item>
	</channel></rss>`;

	it("reads title, link, date and description, newest first, skipping incomplete items", () => {
		const posts = parseRss(xml, 4);
		expect(posts.map((p) => p.title)).toEqual(["Newer", "Older & wiser"]);
		expect(posts[0]?.date).toBe("2026-11-18T10:00:00.000Z");
	});

	it("honours the limit", () => {
		expect(parseRss(xml, 1)).toHaveLength(1);
	});
});
