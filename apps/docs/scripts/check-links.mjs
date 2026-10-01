// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * check-links — every internal link in apps/docs/content resolves to a page, and every `#anchor`
 * to a heading on that page. Also the navigation: every `meta.json` entry names a file, and every
 * page is reachable from its section's `meta.json`.
 *
 * What it reads, and what it does NOT (so a green run is not read as more than it is):
 *   - Markdown links `[x](/path#anchor)` and JSX `href="/path"` / `href={"/path"}` in .mdx prose.
 *     Fenced code blocks and inline code are skipped: a URL inside an example is not a link.
 *   - A route is a file's path under content/docs, minus `.mdx`, with `index` meaning its folder —
 *     the same mapping `loader({ baseUrl: '/' })` in lib/source.ts applies.
 *   - Anchors are computed the way fumadocs' remark-heading does: github-slugger over the heading's
 *     plain text, with `-1`, `-2` suffixes for repeats. Headings inside code fences do not count.
 *   - Static files under public/ are accepted as link targets.
 *   - EXTERNAL URLs (http/https/mailto) are NOT checked. A network probe in a required check is a
 *     flake source; this guard answers "does the link point at something this site serves".
 *   - A link through one of next.config.mjs's redirects is reported as broken: a redirect keeps old
 *     URLs alive for readers, it is not where new links should point.
 *
 * Refused forms, each with a reason:
 *   - `/docs/...`  — the site's basePath is `/docs`, so this renders as /docs/docs/...
 *   - relative (`./x`, `../x`, `x`) — resolves against the reader's current URL, which differs
 *     between `/a/b` and `/a/b/`; the docs style bar requires absolute links.
 *
 * Usage:  node scripts/check-links.mjs [contentDir]      exit 1 on any finding
 *         node scripts/check-links.mjs --self-test       proves each finding class can fire
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = path.join(here, "..");

/** Lists every file under `dir`, recursively, as paths relative to `dir`. */
function walk(dir, rel = "") {
	const out = [];
	for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
		const r = path.posix.join(rel, entry.name);
		if (entry.isDirectory()) out.push(...walk(dir, r));
		else out.push(r);
	}
	return out;
}

/** Maps a content-relative .mdx path to its route: `a/b/index.mdx` → `/a/b`, `a/c.mdx` → `/a/c`. */
export function routeOf(relPath) {
	const noExt = relPath.replace(/\.mdx?$/, "");
	const trimmed = noExt === "index" ? "" : noExt.replace(/\/index$/, "");
	return `/${trimmed}`;
}

/** Replaces fenced code blocks with blank lines, so line numbers survive and code is not read. */
export function blankFences(src) {
	const lines = src.split("\n");
	let fence = null;
	return lines
		.map((line) => {
			const m = line.match(/^\s*(`{3,}|~{3,})/);
			if (fence) {
				if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
				return "";
			}
			if (m) {
				fence = m[1];
				return "";
			}
			return line;
		})
		.join("\n");
}

/** Strips YAML frontmatter, keeping its line count. */
function blankFrontmatter(src) {
	const m = src.match(/^---\n[\s\S]*?\n---\n/);
	return m ? m[0].replace(/[^\n]/g, "") + src.slice(m[0].length) : src;
}

/** github-slugger's transform: lowercase, drop everything but letters/numbers/marks/`_`/`-`/space, spaces → `-`. */
export function slug(text) {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, "")
		.replace(/ /g, "-");
}

/** Reduces a heading's markdown to the plain text fumadocs slugs: links to their text, code/emphasis unwrapped, JSX dropped. */
export function headingText(md) {
	return md
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/(\*\*|__|\*|_|~~)(.+?)\1/g, "$2")
		.trim();
}

/** The set of anchors a page exposes: slugged headings (deduped like github-slugger) plus explicit `id="…"` attributes. */
export function anchorsOf(src) {
	const body = blankFences(blankFrontmatter(src));
	const seen = new Map();
	const anchors = new Set();
	for (const line of body.split("\n")) {
		const h = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
		if (h) {
			const base = slug(headingText(h[1]));
			const n = seen.get(base) ?? 0;
			seen.set(base, n + 1);
			anchors.add(n === 0 ? base : `${base}-${n}`);
		}
		for (const m of line.matchAll(/\bid=["{]+["']?([A-Za-z0-9_-]+)/g)) anchors.add(m[1]);
	}
	return anchors;
}

/** Every link target in a page's prose, with its 1-based line number. Code spans and fences are skipped. */
export function linksOf(src) {
	const body = blankFences(blankFrontmatter(src));
	const out = [];
	body.split("\n").forEach((rawLine, i) => {
		const line = rawLine.replace(/`[^`]*`/g, (s) => " ".repeat(s.length));
		for (const m of line.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) out.push({ href: m[1], line: i + 1 });
		for (const m of line.matchAll(/\bhref=(?:\{\s*)?["'`]([^"'`]+)["'`]/g)) out.push({ href: m[1], line: i + 1 });
	});
	return out;
}

/** Classifies one href against the site; returns a finding message, or null when it resolves. */
export function checkHref(href, { fromRoute, pages, publicFiles }) {
	if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null; // external: out of scope
	if (href.startsWith("#")) {
		const anchor = decodeURIComponent(href.slice(1));
		return pages.get(fromRoute).has(anchor) ? null : `anchor "#${anchor}" is not a heading on this page`;
	}
	if (!href.startsWith("/")) return `relative link "${href}" — use an absolute path from the docs root`;
	const [pathPart, anchorPart] = href.split("#");
	const clean = pathPart.split("?")[0].replace(/\/+$/, "") || "/";
	if (clean === "/docs" || clean.startsWith("/docs/")) {
		return `"${href}" starts with /docs — the basePath is added for you, so this renders as /docs/docs/…`;
	}
	if (publicFiles.has(clean)) return null;
	const anchors = pages.get(clean);
	if (!anchors) return `"${href}" — no page at ${clean}`;
	if (anchorPart && !anchors.has(decodeURIComponent(anchorPart))) {
		return `"${href}" — ${clean} has no heading with anchor #${anchorPart}`;
	}
	return null;
}

/** Checks every directory's meta.json against the files beside it: no dangling entry, no unlisted page. */
export function checkMeta(contentDir, files) {
	const findings = [];
	const metas = files.filter((f) => path.posix.basename(f) === "meta.json");
	for (const meta of metas) {
		const dir = path.posix.dirname(meta);
		const { pages } = JSON.parse(fs.readFileSync(path.join(contentDir, meta), "utf8"));
		if (!Array.isArray(pages)) continue;
		const plain = pages.filter((p) => !/^(\.\.\.|---|\[|!|z\.\.\.a)/.test(p));
		const prefix = dir === "." ? "" : `${dir}/`;
		const children = new Set(
			files
				.filter((f) => f.startsWith(prefix) && f !== meta)
				.map((f) => f.slice(prefix.length).split("/")[0].replace(/\.mdx?$/, ""))
				.filter((c) => c !== "meta.json"),
		);
		for (const p of plain) {
			if (!children.has(p)) findings.push({ file: meta, line: 0, msg: `entry "${p}" names no file or folder` });
		}
		if (pages.some((p) => p.startsWith("..."))) continue; // a rest entry lists the remainder itself
		for (const c of children) {
			if (!plain.includes(c)) findings.push({ file: meta, line: 0, msg: `"${c}" exists but is not listed, so no navigation reaches it` });
		}
	}
	return findings;
}

/** Runs every check over one content directory and returns the findings. */
export function check(contentDir, publicDir = path.join(DOCS_ROOT, "public")) {
	const files = walk(contentDir);
	const mdx = files.filter((f) => /\.mdx?$/.test(f));
	const sources = new Map(mdx.map((f) => [f, fs.readFileSync(path.join(contentDir, f), "utf8")]));
	const pages = new Map(mdx.map((f) => [routeOf(f), anchorsOf(sources.get(f))]));
	const publicFiles = new Set(fs.existsSync(publicDir) ? walk(publicDir).map((f) => `/${f}`) : []);

	const findings = checkMeta(contentDir, files);
	let links = 0;
	for (const f of mdx) {
		const fromRoute = routeOf(f);
		for (const { href, line } of linksOf(sources.get(f))) {
			links++;
			const msg = checkHref(href, { fromRoute, pages, publicFiles });
			if (msg) findings.push({ file: f, line, msg });
		}
	}
	findings.stats = { pages: mdx.length, links };
	return findings;
}

/** Plants one instance of each finding class in a temp tree and asserts every one is reported. */
function selfTest() {
	const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "check-links-"));
	const put = (rel, body) => {
		fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
		fs.writeFileSync(path.join(tmp, rel), body);
	};
	put("meta.json", JSON.stringify({ pages: ["index", "a", "ghost"] }));
	put("index.mdx", "---\ntitle: x\n---\n\n## Step 1 — Create the `project`\n\n[ok](/a#second)\n[ok2](#step-1--create-the-project)\n");
	put("a/meta.json", JSON.stringify({ pages: ["index"] }));
	put("a/index.mdx", "## Second\n\n```md\n[in-fence](/nowhere)\n```\n\n`[in-code](/nowhere)`\n");
	put("a/unlisted.mdx", [
		"[missing](/nowhere)",
		"[bad-anchor](/a#first)",
		"[doubled](/docs/a)",
		"[relative](./index)",
		'<Card href="/also-nowhere" />',
		"[self-anchor](#nope)",
	].join("\n"));
	const got = check(tmp, path.join(tmp, "no-public"));
	fs.rmSync(tmp, { recursive: true, force: true });
	const want = [
		/entry "ghost" names no file/,
		/"unlisted" exists but is not listed/,
		/no page at \/nowhere/,
		/has no heading with anchor #first/,
		/starts with \/docs/,
		/relative link/,
		/no page at \/also-nowhere/,
		/anchor "#nope"/,
	];
	const missed = want.filter((re) => !got.some((f) => re.test(f.msg)));
	const extra = got.length - want.length;
	if (missed.length || extra !== 0) {
		console.error("check-links self-test FAILED");
		for (const re of missed) console.error(`  never reported: ${re}`);
		if (extra !== 0) console.error(`  expected ${want.length} findings, got ${got.length}:`, got);
		process.exit(1);
	}
	console.log(`check-links self-test: all ${want.length} planted defects reported, none invented.`);
}

/** Entry point: --self-test, or check the content tree and exit 1 on any finding. */
function main() {
	if (process.argv.includes("--self-test")) return selfTest();
	const contentDir = process.argv[2] ?? path.join(DOCS_ROOT, "content", "docs");
	const findings = check(contentDir);
	for (const f of findings) console.error(`${path.posix.join("content/docs", f.file)}${f.line ? `:${f.line}` : ""}  ${f.msg}`);
	if (findings.length) {
		console.error(`\n${findings.length} broken link(s) or navigation entries.`);
		process.exit(1);
	}
	// The counts are part of the verdict: a parser that silently stopped matching links would
	// otherwise print the same green line over zero links.
	const { pages, links } = findings.stats;
	if (pages === 0 || links === 0) {
		console.error(`check-links: read ${pages} pages and ${links} links — nothing was checked, refusing to pass.`);
		process.exit(1);
	}
	console.log(`check-links: ${links} links across ${pages} pages — every internal link and anchor resolves; every page is in navigation.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
