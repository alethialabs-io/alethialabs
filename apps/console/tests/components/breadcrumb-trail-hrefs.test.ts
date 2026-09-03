// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every URL the header breadcrumb links to must be a route.
//
// THE DEFECT THIS EXISTS FOR (#3805, R6). The trail mints an `<a href>` for each ancestor segment
// of the current path — it assumes a path PREFIX of a route is itself a route. For
// `/[org]/~/support/cases/[id]` that is false: `app/(private)/[org]/~/support/cases/` holds `[id]/`
// and no `page.tsx`, so the "Cases" crumb pointed at a 404. Next's `<Link>` prefetches the RSC
// payload for every link it can see, a FAILED prefetch is not cached, and so every re-entry into
// the viewport asked again — `404 GET /<org>/~/support/cases?_rsc=…` seventy times in one visit of
// the audit. The count was the retry, not seventy links.
//
// WHY A SWEEP AND NOT AN ASSERTION ABOUT THAT ONE CRUMB. Nothing in the breadcrumb's source says
// which of the URLs it mints exist; only the ROUTE SET does. A test naming `support/cases` would
// pass forever and say nothing about the next directory-only segment somebody adds. So the
// denominator comes from `scripts/lib/console-routes.mjs` — the ONE definition of the console's
// private route set (#3636), shelled out to rather than re-walked, exactly as
// `e2e/audit/manifest.ts` does and for the same reason: the seam RAISES on a broken scan, and
// `execFileSync` turns that raise into a throw instead of an empty sweep reporting green over
// nothing.
//
// The second test is the reason to believe the first. A sweep that has never been seen to fail is
// indistinguishable from one that cannot: it removes the redirect that fixes the defect and
// requires the sweep to find it again, naming the exact URL.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ANCESTOR_REDIRECTS,
	buildCrumbs,
} from "@/components/shell/breadcrumb-trail";

/** A route parameter as the seam reports it. */
interface SeamParam {
	segment: string;
	name: string;
	catchAll: boolean;
	optional: boolean;
}

/** Only the fields this sweep reads. */
interface SeamRoute {
	route: string;
	params: SeamParam[];
}

/** Structural check on one param record — narrowed, never cast. */
function isSeamParam(value: unknown): value is SeamParam {
	return (
		typeof value === "object" &&
		value !== null &&
		"segment" in value &&
		typeof value.segment === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"catchAll" in value &&
		typeof value.catchAll === "boolean" &&
		"optional" in value &&
		typeof value.optional === "boolean"
	);
}

/** Structural check on one route record — the fields this sweep reads, and nothing more. */
function isSeamRoute(value: unknown): value is SeamRoute {
	return (
		typeof value === "object" &&
		value !== null &&
		"route" in value &&
		typeof value.route === "string" &&
		"params" in value &&
		Array.isArray(value.params) &&
		value.params.every(isSeamParam)
	);
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

/**
 * Every private console route, straight from the seam.
 *
 * Raises rather than returning an empty list: a sweep with no denominator must not be allowed to
 * look like a sweep that found nothing wrong.
 */
function consoleRoutes(): SeamRoute[] {
	const seam = path.join(REPO_ROOT, "scripts", "lib", "console-routes.mjs");
	const raw = execFileSync(process.execPath, [seam, "--json"], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("routes" in parsed) ||
		!Array.isArray(parsed.routes)
	) {
		throw new Error(`${seam} did not produce a route manifest`);
	}
	const routes: SeamRoute[] = [];
	for (const r of parsed.routes) {
		if (!isSeamRoute(r)) {
			throw new Error(
				`${seam} produced a record this sweep cannot read: ${JSON.stringify(r)}`,
			);
		}
		routes.push({ route: r.route, params: r.params });
	}
	if (routes.length === 0) throw new Error(`${seam} reported zero routes`);
	return routes;
}

/** A v4-shaped id, the console's id shape in a URL. */
const ID = "3f2b1a90-7c4d-4e8f-9a1b-2c3d4e5f6a7b";

/** How each dynamic segment is filled in when a route pattern is made concrete. */
const PARAM_VALUES: Record<string, string> = { org: "acme", project: "web" };

/** A concrete pathname for a route pattern, with dynamic segments filled in. */
function concretePath(r: SeamRoute): string {
	const bySegment = new Map(r.params.map((p) => [p.segment, p]));
	const out: string[] = [];
	for (const seg of r.route.split("/").filter(Boolean)) {
		const param = bySegment.get(seg);
		if (!param) {
			out.push(seg);
			continue;
		}
		// An OPTIONAL catch-all matches the bare parent too, and that is the shape the console
		// actually links to (`/dashboard`), so it is the one worth sweeping.
		if (param.catchAll && param.optional) continue;
		if (param.catchAll) out.push("a", "b");
		else out.push(PARAM_VALUES[param.name] ?? ID);
	}
	return `/${out.join("/")}`;
}

/** A route pattern as a matcher over concrete pathnames. */
function routeMatcher(r: SeamRoute): RegExp {
	const bySegment = new Map(r.params.map((p) => [p.segment, p]));
	let src = "^";
	for (const seg of r.route.split("/").filter(Boolean)) {
		const param = bySegment.get(seg);
		if (!param) {
			src += `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
		} else if (param.catchAll && param.optional) {
			src += "(?:/[^?#]+)?";
		} else if (param.catchAll) {
			src += "/[^?#]+";
		} else {
			src += "/[^/?#]+";
		}
	}
	return new RegExp(`${src}/?$`);
}

interface MintedHref {
	route: string;
	pathname: string;
	label: string;
	href: string;
}

/** Every href the trail mints across every route, and whether each resolves. */
function sweep(routes: SeamRoute[]): {
	minted: MintedHref[];
	dead: MintedHref[];
} {
	const matchers = routes.map(routeMatcher);
	const minted: MintedHref[] = [];
	const dead: MintedHref[] = [];
	for (const r of routes) {
		const pathname = concretePath(r);
		for (const crumb of buildCrumbs(pathname)) {
			const { href } = crumb;
			if (!href) continue;
			const record = { route: r.route, pathname, label: crumb.label, href };
			minted.push(record);
			if (!matchers.some((m) => m.test(href))) dead.push(record);
		}
	}
	return { minted, dead };
}

describe("header breadcrumb hrefs", () => {
	const routes = consoleRoutes();

	it("mints an ancestor link on the routes that have ancestors", () => {
		// The denominator, asserted BEFORE the verdict that rests on it. A sweep that collected no
		// hrefs would otherwise report the same clean result as a sweep that collected them all —
		// and `/[org]/~/support/cases/[id]` is named specifically because it is the route the
		// finding was measured on: if the trail ever stops linking its parent, this sweep stops
		// being able to see the defect it was written for, and should say so here rather than
		// by going quietly green.
		const { minted } = sweep(routes);
		expect(minted.length).toBeGreaterThan(0);
		expect(minted.map((m) => m.route)).toContain("/[org]/~/support/cases/[id]");
	});

	it("links only to URLs that are routes", () => {
		const { dead } = sweep(routes);
		expect(
			dead.map((d) => `${d.route}: "${d.label}" -> ${d.href}`),
		).toStrictEqual([]);
	});

	it("would catch the defect it was written for", () => {
		// Not a restatement of the fix: it removes the fix and requires the sweep to fail, with the
		// URL the CI artifact reported. Without this, "no dead hrefs" and "cannot detect a dead
		// href" are the same green.
		const saved = { ...ANCESTOR_REDIRECTS };
		for (const key of Object.keys(ANCESTOR_REDIRECTS))
			delete ANCESTOR_REDIRECTS[key];
		try {
			const { dead } = sweep(routes);
			expect(dead.map((d) => d.href)).toStrictEqual(["/acme/~/support/cases"]);
		} finally {
			Object.assign(ANCESTOR_REDIRECTS, saved);
		}
	});
});
