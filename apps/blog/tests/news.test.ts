// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	coverSrc,
	gridPosts,
	KIND_FILTERS,
	KIND_LABELS,
	type NewsItem,
	type NewsKind,
	paginate,
	parseKindFilter,
	parsePage,
	pickFeatured,
	pickFeaturedSet,
	relatedPosts,
} from "../lib/news";

/** A post fixture: newest first is the caller's job, as getPublishedPosts guarantees. */
function post(slug: string, kind: NewsKind, date: string, featured = false): NewsItem {
	return { slug, kind, date, featured };
}

const POSTS: NewsItem[] = [
	post("changelog-2026-11", "changelog", "2026-11-18"),
	post("eng-c", "engineering", "2026-11-01"),
	post("launch", "announcement", "2026-10-20"),
	post("product-a", "product", "2026-10-10"),
	post("eng-b", "engineering", "2026-09-01", true),
	post("eng-a", "engineering", "2026-08-01"),
	post("company-a", "company", "2026-07-01"),
];

describe("filters", () => {
	it("has a chip for All and for every kind", () => {
		expect(KIND_FILTERS[0]?.kind).toBeNull();
		expect(KIND_FILTERS.slice(1).map((f) => f.kind).sort()).toEqual(Object.keys(KIND_LABELS).sort());
	});

	it("reads exactly one known kind, and anything else as All", () => {
		expect(parseKindFilter("product")).toBe("product");
		expect(parseKindFilter("changelog")).toBe("changelog");
		expect(parseKindFilter("Product")).toBeNull();
		expect(parseKindFilter(["product", "company"])).toBeNull();
		expect(parseKindFilter(undefined)).toBeNull();
		expect(parseKindFilter("toString")).toBeNull();
	});
});

describe("pagination", () => {
	it("reads a positive page and falls back to 1", () => {
		expect(parsePage("3")).toBe(3);
		expect(parsePage("0")).toBe(1);
		expect(parsePage("-2")).toBe(1);
		expect(parsePage("2.5")).toBe(1);
		expect(parsePage(["2", "3"])).toBe(1);
		expect(parsePage("99999")).toBe(1);
	});

	it("shows pages cumulatively and says when more remain", () => {
		const items = Array.from({ length: 20 }, (_, i) => i);
		expect(paginate(items, 1, 9)).toEqual({ shown: items.slice(0, 9), hasMore: true });
		expect(paginate(items, 2, 9).shown).toHaveLength(18);
		expect(paginate(items, 3, 9)).toEqual({ shown: items, hasMore: false });
	});
});

describe("featured", () => {
	it("prefers a featured post, then the newest announcement, and never a changelog entry", () => {
		expect(pickFeatured(POSTS)?.slug).toBe("eng-b");
		expect(pickFeatured(POSTS.map((p) => ({ ...p, featured: false })))?.slug).toBe("launch");
		expect(pickFeatured([post("c", "changelog", "2026-11-01"), post("e", "engineering", "2026-10-01")])?.slug).toBe("e");
		expect(pickFeatured([post("c", "changelog", "2026-11-01")])).toBeUndefined();
	});

	it("fills the secondary row with the newest non-changelog posts, without the hero", () => {
		const { hero, secondary } = pickFeaturedSet(POSTS);
		expect(hero?.slug).toBe("eng-b");
		expect(secondary.map((p) => p.slug)).toEqual(["eng-c", "launch", "product-a"]);
	});

	it("leads the secondary row with other featured posts", () => {
		const posts = POSTS.map((p) => (p.slug === "eng-a" ? { ...p, featured: true } : p));
		expect(pickFeaturedSet(posts).secondary[0]?.slug).toBe("eng-a");
	});
});

describe("gridPosts", () => {
	it("unfiltered, leaves out what the featured block shows — changelog entries stay in", () => {
		const { hero, secondary } = pickFeaturedSet(POSTS);
		const featured = hero ? [hero, ...secondary] : secondary;
		expect(gridPosts(POSTS, null, featured).map((p) => p.slug)).toEqual(["changelog-2026-11", "eng-a", "company-a"]);
	});

	it("filtered, shows every post of the kind, featured or not", () => {
		expect(gridPosts(POSTS, "engineering", []).map((p) => p.slug)).toEqual(["eng-c", "eng-b", "eng-a"]);
	});
});

describe("relatedPosts", () => {
	it("puts the same kind first, then the newest others, never the post itself", () => {
		const self = POSTS[1];
		if (!self) throw new Error("fixture");
		expect(relatedPosts(self, POSTS).map((p) => p.slug)).toEqual(["eng-b", "eng-a", "changelog-2026-11"]);
	});
});

describe("coverSrc", () => {
	it("keeps an in-repo path and resolves an assets-host path", () => {
		expect(coverSrc("/news/static/launch.jpg")).toBe("/news/static/launch.jpg");
		expect(coverSrc("2026/launch.jpg")).toBe("https://assets.alethialabs.io/news/2026/launch.jpg");
		expect(coverSrc(undefined)).toBeUndefined();
	});
});
