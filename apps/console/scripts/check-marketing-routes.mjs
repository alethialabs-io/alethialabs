// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Marketing path-list drift guard. apps/console/microfrontends.json is the single source
// of truth for the paths the marketing zone owns. RESERVED_SLUGS (lib/routing.ts) is
// DERIVED from it (lib/marketing-zone.ts), so the org-slug reservation can never drift —
// no check needed there. This guard keeps the other two encodings honest:
//   1. every marketing app/ route is registered in microfrontends.json (so a new page
//      can't ship unrouted / unreserved), and
//   2. the off-Vercel Caddy mirror's @marketing path list matches microfrontends.json.
// Plus a cheap asset-prefix consistency check across the three. Run from apps/console
// (the `check:marketing-routes` script): cwd is apps/console.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MF_PATH = "marketing-zones.json";
const MARKETING_APP = "../marketing/app";
const CADDY = "../../deploy/caddy/marketing.caddy.example";
const MARKETING_NEXT_CONFIG = "../marketing/next.config.ts";

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
if (existsSync(CADDY)) {
	const caddy = readFileSync(CADDY, "utf8");
	const line = caddy.split("\n").find((l) => l.trim().startsWith("@marketing path"));
	if (!line) {
		failures.push(`${CADDY}: no "@marketing path …" matcher line found.`);
	} else {
		const caddyPaths = line.trim().replace(/^@marketing path\s+/, "").split(/\s+/);
		const caddyCanon = new Set(caddyPaths.map(canon));
		for (const p of mfCanon) {
			if (!caddyCanon.has(p)) {
				failures.push(
					`Path "${p}" is in ${MF_PATH} but missing from the Caddy @marketing matcher (${CADDY}).`,
				);
			}
		}
		for (const p of caddyCanon) {
			if (!mfCanon.has(p)) {
				failures.push(
					`Path "${p}" is in the Caddy @marketing matcher (${CADDY}) but not in ${MF_PATH}.`,
				);
			}
		}
	}
} else {
	failures.push(`Caddy mirror not found at ${CADDY}.`);
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

// ── Report ───────────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(
		"Marketing path list out of sync (source of truth: apps/console/microfrontends.json):",
	);
	for (const f of failures) console.error(`  ✗ ${f}`);
	console.error(
		"\nKeep apps/console/microfrontends.json, deploy/caddy/marketing.caddy.example, and the\n" +
			"apps/marketing/app/ routes in sync. RESERVED_SLUGS derives from microfrontends.json automatically.",
	);
	process.exit(1);
}

console.log(
	`OK — ${mfPaths.length} marketing paths in sync across microfrontends.json, the Caddy mirror, and apps/marketing/app/.`,
);
