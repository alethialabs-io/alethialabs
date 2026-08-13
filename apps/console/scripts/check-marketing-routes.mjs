// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketing path-list drift guard. apps/console/microfrontends.json is the single source
// of truth for the paths the marketing zone owns. RESERVED_SLUGS (lib/routing.ts) is
// DERIVED from it (lib/marketing-zone.ts), so the org-slug reservation can never drift —
// no check needed there. This guard keeps the other two encodings honest:
//   1. every marketing app/ route is registered in microfrontends.json (so a new page
//      can't ship unrouted / unreserved), and
//   2. the Caddy mirror's @marketing path list matches marketing-zones.json.
// Plus a cheap asset-prefix consistency check across the three. Run from apps/console
// (the `check:marketing-routes` script): cwd is apps/console.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

const MF_PATH = "marketing-zones.json";
const MARKETING_APP = "../marketing/app";
const CADDY_FILES = [
	"../../deploy/caddy/marketing.caddy.example",
	"../../deploy/caddy/Caddyfile.dev",
	"../../deploy/prod/Caddyfile.tunnel",
];
const MARKETING_NEXT_CONFIG = "../marketing/next.config.ts";
const REPO_ROOT = "../..";

const failures = [];

// ── Source of truth: microfrontends.json ────────────────────────────────────────────
const mf = JSON.parse(readFileSync(MF_PATH, "utf8"));
const marketing = mf.applications?.marketing;
if (!marketing?.routing) {
	console.error(`✗ ${MF_PATH}: applications.marketing.routing is missing.`);
	process.exit(1);
}
const assetPrefix = marketing.assetPrefix; // e.g. "mkt-assets"
const mfPaths = marketing.routing.flatMap((r) => r.paths);

/** Canonicalize a path so the microfrontends `:path*` syntax and Caddy `*` compare equal. */
const canon = (p) => p.replace(/\/:[A-Za-z]+[*+]?/g, "/*");
const mfCanon = new Set(mfPaths.map(canon));
/** First URL segment of a path ("/contact/:path*" → "contact", "/" → ""). */
const firstSeg = (p) => p.replace(/^\//, "").split("/")[0];
const mfSegments = new Set(mfPaths.map(firstSeg));

// ── Check 1: every marketing app/ route is registered in microfrontends.json ─────────
/** Does this route subtree produce a page/route handler? */
function hasRoute(dir) {
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) {
			if (hasRoute(full)) return true;
		} else if (/^(page|route)\.(tsx?|jsx?)$/.test(e)) {
			return true;
		}
	}
	return false;
}
/** Top-level URL segments served by the marketing app (route groups `(x)` / slots `@x`
 * are transparent; `_private` and dotfiles are skipped; bare app/page.tsx → ""). */
function collectSegments(dir) {
	const segs = new Set();
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) {
			if (/^[_.]/.test(e)) continue;
			if (/^\(.*\)$/.test(e) || e.startsWith("@")) {
				for (const s of collectSegments(full)) segs.add(s);
			} else if (hasRoute(full)) {
				segs.add(e);
			}
		} else if (/^page\.(tsx?|jsx?)$/.test(e)) {
			segs.add("");
		}
	}
	return segs;
}
if (existsSync(MARKETING_APP)) {
	for (const seg of collectSegments(MARKETING_APP)) {
		if (!mfSegments.has(seg)) {
			failures.push(
				`Marketing route "/${seg}" (apps/marketing/app/${seg}) is not registered in ${MF_PATH}.\n` +
					`    → add "/${seg}" to applications.marketing.routing[].paths (and the Caddy mirror).`,
			);
		}
	}
} else {
	failures.push(`Marketing app dir not found at ${MARKETING_APP}.`);
}

// ── Check 2: the Caddy mirror's @marketing path list matches microfrontends.json ──────
for (const caddyPath of CADDY_FILES) {
	if (!existsSync(caddyPath)) {
		failures.push(`Caddy mirror not found at ${caddyPath}.`);
		continue;
	}
	const caddy = readFileSync(caddyPath, "utf8");
	const line = caddy.split("\n").find((l) => l.trim().startsWith("@marketing path"));
	if (!line) {
		failures.push(`${caddyPath}: no "@marketing path …" matcher line found.`);
		continue;
	}
	const caddyPaths = line.trim().replace(/^@marketing path\s+/, "").split(/\s+/);
	const caddyCanon = new Set(caddyPaths.map(canon));
	for (const p of mfCanon) {
		if (!caddyCanon.has(p)) {
			failures.push(
				`Path "${p}" is in ${MF_PATH} but missing from the Caddy @marketing matcher (${caddyPath}).`,
			);
		}
	}
	for (const p of caddyCanon) {
		if (!mfCanon.has(p)) {
			failures.push(
				`Path "${p}" is in the Caddy @marketing matcher (${caddyPath}) but not in ${MF_PATH}.`,
			);
		}
	}
}

// ── Check 3: asset prefix is consistent across json / Caddy / marketing next.config ───
if (assetPrefix) {
	if (!mfCanon.has(`/${assetPrefix}/*`)) {
		failures.push(
			`assetPrefix "${assetPrefix}" has no "/${assetPrefix}/:path*" route in ${MF_PATH}.`,
		);
	}
	if (existsSync(MARKETING_NEXT_CONFIG)) {
		const cfg = readFileSync(MARKETING_NEXT_CONFIG, "utf8");
		const re = new RegExp(`assetPrefix:\\s*["']/${assetPrefix}["']`);
		if (!re.test(cfg)) {
			failures.push(
				`apps/marketing/next.config.ts assetPrefix does not match microfrontends.json ("/${assetPrefix}").`,
			);
		}
	}
} else {
	failures.push(`${MF_PATH}: applications.marketing.assetPrefix is missing.`);
}

// ── Check 4: every static first-party navigation target resolves ──────────────────────
/** Recursively collect files accepted by `include`. */
function collectFiles(dir, include) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", ".next", "coverage", "test-results", "playwright-report"].includes(entry.name)) {
			continue;
		}
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectFiles(full, include));
		else if (include(full)) files.push(full);
	}
	return files;
}

/** Turn a Next app-router page/route file into its URL pattern. */
function nextRoute(root, file, prefix = "") {
	const segments = relative(root, dirname(file))
		.split(sep)
		.filter(Boolean)
		.filter((segment) => !/^\(.*\)$/.test(segment) && !segment.startsWith("@"));
	return `${prefix}/${segments.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

/** Convert a Next dynamic route into a matcher while preserving catch-all semantics. */
function routeRegex(route) {
	if (route === "/") return /^\/$/;
	let pattern = "^";
	for (const segment of route.split("/").filter(Boolean)) {
		if (/^\[\[\.\.\..+\]\]$/.test(segment)) {
			pattern += "(?:/.*)?";
		} else if (/^\[\.\.\..+\]$/.test(segment)) {
			pattern += "/.+";
		} else if (/^\[.+\]$/.test(segment)) {
			pattern += "/[^/]+";
		} else {
			pattern += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
		}
	}
	return new RegExp(`${pattern}/?$`);
}

const routePatterns = [];
for (const [root, prefix] of [
	[join(REPO_ROOT, "apps/marketing/app"), ""],
	[join(REPO_ROOT, "apps/blog/app"), "/blog"],
]) {
	for (const file of collectFiles(root, (candidate) => /\/(?:page|route)\.(?:tsx?|jsx?)$/.test(candidate))) {
		routePatterns.push(routeRegex(nextRoute(root, file, prefix)));
	}
}

// Console-owned static/compatibility routes are valid public targets. Deliberately
// exclude the /[org] tree: a missing marketing page must not pass merely because the
// console would interpret its first segment as an organization slug.
const consoleApp = join(REPO_ROOT, "apps/console/app");
for (const file of collectFiles(consoleApp, (candidate) => /\/(?:page|route)\.(?:tsx?|jsx?)$/.test(candidate))) {
	const route = nextRoute(consoleApp, file);
	if (!route.includes("[org]")) routePatterns.push(routeRegex(route));
}

const docsContent = join(REPO_ROOT, "apps/docs/content/docs");
for (const file of collectFiles(docsContent, (candidate) => extname(candidate) === ".mdx")) {
	const rel = relative(docsContent, file).split(sep).join("/").replace(/\.mdx$/, "");
	const suffix = rel === "index" ? "" : rel.replace(/\/index$/, "");
	routePatterns.push(routeRegex(`/docs${suffix ? `/${suffix}` : ""}`));
}
routePatterns.push(/^\/robots\.txt$/, /^\/sitemap\.xml$/);
for (const publicRoot of [
	join(REPO_ROOT, "apps/console/public"),
	join(REPO_ROOT, "apps/marketing/public"),
]) {
	if (!existsSync(publicRoot)) continue;
	for (const file of collectFiles(publicRoot, () => true)) {
		const publicPath = `/${relative(publicRoot, file).split(sep).join("/")}`;
		routePatterns.push(routeRegex(publicPath));
	}
}

/** Normalize a local or canonical first-party URL to its path, without query/hash. */
function firstPartyPath(value) {
	if (value === "#") return "#";
	if (value.startsWith("https://alethialabs.io/")) return new URL(value).pathname;
	if (!value.startsWith("/")) return null;
	return value.split(/[?#]/, 1)[0] || "/";
}

/** Extract static navigation literals without treating arbitrary prose/code strings as links. */
function navigationTargets(file) {
	const source = readFileSync(file, "utf8");
	const found = [];
	const patterns = [
		/\bhref\s*=\s*["']([^"']+)["']/g,
		/\bhref\s*:\s*["']([^"']+)["']/g,
		/\b(?:redirect|permanentRedirect|push|replace|legalUrl)\(\s*["']([^"']+)["']/g,
		/\bnew URL\(\s*["']([^"']+)["']/g,
	];
	if (file.endsWith("footer.tsx")) patterns.push(/\breturn\s+["']([^"']+)["']/g);
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) found.push(match[1]);
	}
	for (const match of source.matchAll(/https:\/\/alethialabs\.io\/[A-Za-z0-9_~./?%=&-]*/g)) {
		found.push(match[0]);
	}
	if (/(?:href|redirect|push|replace)[^\n]{0,100}["']#["']/.test(source)) found.push("#");
	return found;
}

const navigationRoots = [
	join(REPO_ROOT, "apps/marketing"),
	join(REPO_ROOT, "apps/console"),
	join(REPO_ROOT, "packages/support/src/emails"),
];
const seenBroken = new Set();
for (const root of navigationRoots) {
	for (const file of collectFiles(root, (candidate) => /\.(?:tsx?|jsx?)$/.test(candidate) && !candidate.includes("/tests/") && !candidate.includes("/e2e/"))) {
		for (const target of navigationTargets(file)) {
			const pathname = firstPartyPath(target);
			if (!pathname) continue;
			const key = `${relative(REPO_ROOT, file)}\0${target}`;
			if (seenBroken.has(key)) continue;
			if (pathname === "#") {
				failures.push(`${relative(REPO_ROOT, file)}: bare "#" navigation target.`);
				seenBroken.add(key);
				continue;
			}
			if (!routePatterns.some((pattern) => pattern.test(pathname))) {
				failures.push(
					`${relative(REPO_ROOT, file)}: first-party navigation target "${target}" has no route.`,
				);
				seenBroken.add(key);
			}
		}
	}
}

// ── Report ───────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(
		"Marketing path list out of sync (source of truth: apps/console/microfrontends.json):",
	);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(
		"\nKeep apps/console/marketing-zones.json, every Caddy marketing matcher, the marketing app,\n" +
			"and first-party navigation targets in sync. RESERVED_SLUGS derives from the route map automatically.",
	);
	process.exit(1);
}

console.log(
	`OK — ${mfPaths.length} marketing paths and static first-party navigation targets resolve across every route mirror.`,
);
