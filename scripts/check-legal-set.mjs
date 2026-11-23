#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The legal-set register and its claims ledger (#6778, LEG-S1).
 *
 * `docs/legal/legal-set.json` holds three lists, and this script is what keeps each one true:
 *
 *   documents — every legal page and record, where it lives, whether it is hash-sealed, its
 *               version, and the board unit that owns its audit.
 *   claims    — a statement quoted from a document, tied to the code or configuration that makes it
 *               true.
 *   findings  — a statement quoted from a document that the code does not bear out, waiting for the
 *               unit that owns the document.
 *
 * Every check runs in both directions, because a ledger entry that outlives its subject fails
 * silently and for good. A document that exists and is not registered fails; a registered document
 * that is gone fails. A claim whose quote has left the page fails; a claim whose evidence no longer
 * matches the code fails. A finding whose quote has left the page fails too, which is how a fixed
 * page forces its finding to be removed.
 *
 * What this script does NOT see, stated so nobody infers more:
 *
 *   - A public legal page that is neither linked from the `DOCUMENTS` index in
 *     `apps/marketing/components/legal/legal-shell.tsx`, nor declared in
 *     `packages/legal/src/documents.ts`, nor a `.md` file directly in `docs/legal/`. Coverage is
 *     derived from those three places and from nothing else.
 *   - Whether a quote MEANS what its evidence shows. The script proves the words are still on the
 *     page and the pattern still matches the file. Choosing a pattern that actually carries the
 *     statement is the author's work and the reviewer's.
 *   - Anything about a statement nobody entered. A page with no claims is unexamined, not clean.
 *   - Values held outside the repository (a vault setting, a provider's dashboard). Those are
 *     `outside-repo` claims: recorded with what would settle them, and never counted as tied.
 *
 *   node scripts/check-legal-set.mjs              # verify (CI)
 *   node scripts/check-legal-set.mjs --sync       # rewrite the derived fields (version,
 *                                                 # displayedDate, contentHash) from their sources
 *   node scripts/check-legal-set.mjs --print      # the register, claims and findings as Markdown
 *   node scripts/check-legal-set.mjs --self-test  # prove each check can fail
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const REGISTER_PATH = "docs/legal/legal-set.json";
const DOCUMENTS_TS = "packages/legal/src/documents.ts";
const LEGAL_SHELL = "apps/marketing/components/legal/legal-shell.tsx";
const MARKETING_APP = "apps/marketing/app";
const LEGAL_DOCS_DIR = "docs/legal";
/** The register's own explanation; it is not a legal document and is not registered in itself. */
const LEGAL_DOCS_EXEMPT = new Set(["README.md"]);

const DOCUMENT_KINDS = ["public-page", "internal-record", "repository-file", "source-module"];
/**
 * `current` — written and in force. `planned` — a board unit has still to write it; the file must
 * not exist. `draft` — written but NOT in force (e.g. pending the maintainer's legal review): the
 * file must exist, it is never sealed, it carries no version, date or hash, it is skipped by
 * `--sync`, and no claim or finding may cite it — a draft is never counted as current or sealed.
 */
const DOCUMENT_STATUSES = ["current", "planned", "draft"];
const CLAIM_KINDS = [
	"retention",
	"consent",
	"device-storage",
	"subprocessor",
	"security",
	"entity",
	"commerce",
	"ai",
	"other",
];
const CLAIM_STATUSES = ["tied", "outside-repo"];
/** A board unit id, for example LEG-L1 or REL-S2. */
const UNIT = /^[A-Z]{3}-[A-Z]{1,2}\d+[a-z]?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** A pattern shorter than this proves nothing about the file it is run against. */
const MIN_PATTERN_LENGTH = 8;

const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

/** Collapses every run of whitespace to one space, so a quote survives a re-wrapped paragraph. */
export function squash(text) {
	return text.replace(/\s+/g, " ").trim();
}

/** Turns "August 12, 2026" into "2026-08-12", or returns null when it is not that shape. */
export function isoFromLongDate(text) {
	const m = text.trim().match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
	if (!m) return null;
	const month = MONTHS.indexOf(m[1].toLowerCase());
	if (month < 0) return null;
	return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/**
 * Reads the sealed documents out of `packages/legal/src/documents.ts`.
 *
 * The same block split as `scripts/check-legal-document-hashes.mjs`, for the same reason: this runs
 * as plain node with no transpile step. Returns a map keyed by SOURCE path.
 */
export function parseSealedDocuments(src) {
	const sealed = new Map();
	for (const block of src.split(/\n\t\{\n/).slice(1)) {
		const body = block.split(/\n\t\},?/)[0];
		const field = (name) => {
			const m = body.match(new RegExp(`\\b${name}:\\s*\\n?\\s*"([^"]*)"`));
			return m ? m[1] : null;
		};
		const id = field("id");
		const source = field("source");
		if (!id || !source) continue;
		sealed.set(source, {
			id,
			version: field("version"),
			contentHash: field("contentHash"),
			path: field("path"),
		});
	}
	return sealed;
}

/** Reads the routes the legal shell links to — the public index of legal pages. */
export function parseShellIndex(src) {
	const start = src.indexOf("const DOCUMENTS");
	if (start < 0) return [];
	const end = src.indexOf("];", start);
	const body = src.slice(start, end < 0 ? undefined : end);
	return [...body.matchAll(/href:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** The date a document shows its reader, as an ISO date, or null when it shows none. */
export function displayedDateOf(source, content) {
	if (source.endsWith(".md")) {
		const m = content.match(/^Effective:\s*(\d{4}-\d{2}-\d{2})/m);
		return m ? m[1] : null;
	}
	const m =
		content.match(/lastUpdated="([^"]+)"/) ?? content.match(/Last updated · ([^"<]+)"/);
	return m ? isoFromLongDate(m[1]) : null;
}

/** The fields of a register entry that are copied from elsewhere, recomputed from their sources. */
export function derivedFields(entry, fs, sealed) {
	const content = entry.status === "current" ? fs.read(entry.source) : null;
	const seal = sealed.get(entry.source) ?? null;
	const displayedDate = content === null ? null : displayedDateOf(entry.source, content);
	return {
		version: seal ? seal.version : displayedDate,
		displayedDate,
		contentHash: seal ? seal.contentHash : null,
	};
}

/**
 * What `--sync` writes for an entry: its derived fields when it is `current`, and null for a
 * `planned` or `draft` entry, which `--sync` never touches (neither is in force).
 */
export function syncedFields(entry, fs, sealed) {
	return entry.status === "current" ? derivedFields(entry, fs, sealed) : null;
}

/** Compiles an evidence pattern, or says why it may not be used. */
function compilePattern(pattern) {
	if (typeof pattern !== "string" || pattern.length < MIN_PATTERN_LENGTH) {
		return { error: `is shorter than ${MIN_PATTERN_LENGTH} characters` };
	}
	let re;
	try {
		re = new RegExp(pattern, "m");
	} catch (err) {
		return { error: `is not a regular expression (${err.message})` };
	}
	if (re.test("")) return { error: "matches the empty string, so it matches every file" };
	return { re };
}

/**
 * Checks a list of evidence items against the tree.
 *
 * An item is `{ path, pattern, shows }` — the pattern must match the file — or
 * `{ path, absent, shows }` — the pattern must NOT match it. The second form is for a finding that
 * something is missing: the day it is added, the finding stops reproducing and has to be removed.
 * `shows` is the sentence a reviewer reads to judge whether the pattern carries the statement, so
 * it is required.
 */
function checkEvidence(owner, evidence, fs, report) {
	for (const [i, item] of evidence.entries()) {
		const where = `${owner} evidence[${i}]`;
		const hasPattern = item && item.pattern !== undefined;
		const hasAbsent = item && item.absent !== undefined;
		if (
			!item ||
			typeof item.path !== "string" ||
			typeof item.shows !== "string" ||
			!item.shows ||
			hasPattern === hasAbsent
		) {
			report(
				"evidence-shape",
				`${where}: needs a path, a non-empty "shows", and exactly one of "pattern" or "absent".`,
			);
			continue;
		}
		const source = hasPattern ? item.pattern : item.absent;
		const compiled = compilePattern(source);
		if (compiled.error) {
			report("evidence-pattern", `${where}: the pattern ${compiled.error}.`);
			continue;
		}
		const content = fs.read(item.path);
		if (content === null) {
			report("evidence-missing-file", `${where}: ${item.path} does not exist.`);
			continue;
		}
		const matches = compiled.re.test(content);
		if (hasPattern && !matches) {
			report(
				"evidence-no-match",
				`${where}: /${source}/ no longer matches ${item.path}. Either the code changed and ` +
					`the document now says something untrue, or the pattern needs re-pointing. Read both.`,
			);
		}
		if (hasAbsent && matches) {
			report(
				"evidence-now-present",
				`${where}: /${source}/ now matches ${item.path}, and the entry says it should not. ` +
					`What was missing has been added: re-read it, then update or remove the entry.`,
			);
		}
	}
}

/** Whether `quote` is still in the document's source, ignoring how the text is wrapped. */
function quotePresent(quote, content) {
	return squash(content).includes(squash(quote));
}

/**
 * Runs every check and returns the problems found, each as `{ code, message }`.
 *
 * `fs` is `{ read(path) -> string | null, list(dir) -> string[] }` with repo-relative paths, so the
 * self-test can run the same function over a tree held in memory.
 */
export function checkLegalSet(fs) {
	const problems = [];
	const report = (code, message) => problems.push({ code, message });

	const raw = fs.read(REGISTER_PATH);
	if (raw === null) {
		report("register-missing", `${REGISTER_PATH} does not exist.`);
		return problems;
	}
	let register;
	try {
		register = JSON.parse(raw);
	} catch (err) {
		report("register-json", `${REGISTER_PATH} is not valid JSON: ${err.message}`);
		return problems;
	}
	const documents = Array.isArray(register.documents) ? register.documents : null;
	const claims = Array.isArray(register.claims) ? register.claims : null;
	const findings = Array.isArray(register.findings) ? register.findings : null;
	if (!documents || !claims || !findings) {
		report("register-shape", `${REGISTER_PATH} needs "documents", "claims" and "findings" arrays.`);
		return problems;
	}

	// ── What exists, read from the three places that define the legal set ───────────────────────
	const sealed = parseSealedDocuments(fs.read(DOCUMENTS_TS) ?? "");
	if (sealed.size === 0) {
		report(
			"parser-blind",
			`parsed no sealed documents out of ${DOCUMENTS_TS}; the parser has drifted from the file.`,
		);
	}
	const shellRoutes = parseShellIndex(fs.read(LEGAL_SHELL) ?? "");
	if (shellRoutes.length === 0) {
		report(
			"parser-blind",
			`parsed no routes out of the DOCUMENTS index in ${LEGAL_SHELL}; the parser has drifted.`,
		);
	}
	const legalDocs = fs
		.list(LEGAL_DOCS_DIR)
		.filter((name) => name.endsWith(".md") && !LEGAL_DOCS_EXEMPT.has(name))
		.map((name) => `${LEGAL_DOCS_DIR}/${name}`);

	// ── documents ───────────────────────────────────────────────────────────────────────────────
	const byId = new Map();
	const bySource = new Map();
	for (const entry of documents) {
		const label = `documents: ${entry?.id ?? "(no id)"}`;
		if (!entry || typeof entry.id !== "string" || !ID.test(entry.id)) {
			report("document-shape", `${label}: needs an id of lower-case words joined by "." or "-".`);
			continue;
		}
		if (byId.has(entry.id)) report("duplicate-id", `${label}: the id is used twice.`);
		byId.set(entry.id, entry);
		if (typeof entry.title !== "string" || !entry.title) {
			report("document-shape", `${label}: needs a title.`);
		}
		if (!DOCUMENT_KINDS.includes(entry.kind)) {
			report("document-shape", `${label}: kind must be one of ${DOCUMENT_KINDS.join(", ")}.`);
		}
		if (!DOCUMENT_STATUSES.includes(entry.status)) {
			report("document-shape", `${label}: status must be one of ${DOCUMENT_STATUSES.join(", ")}.`);
		}
		if (typeof entry.source !== "string" || !entry.source) {
			report("document-shape", `${label}: needs a source path.`);
			continue;
		}
		if (bySource.has(entry.source)) {
			report("duplicate-source", `${label}: ${entry.source} is registered twice.`);
		}
		bySource.set(entry.source, entry);
		if (entry.route !== null && (typeof entry.route !== "string" || !entry.route.startsWith("/"))) {
			report("document-shape", `${label}: route must be null or start with "/".`);
		}
		if (entry.owner === null) {
			if (typeof entry.ownerNote !== "string" || !entry.ownerNote) {
				report(
					"document-owner",
					`${label}: has no owner unit, so it needs an "ownerNote" saying why nobody audits it.`,
				);
			}
		} else if (typeof entry.owner !== "string" || !UNIT.test(entry.owner)) {
			report("document-owner", `${label}: owner must be a board unit id such as LEG-L1, or null.`);
		}

		const exists = fs.read(entry.source) !== null;
		if (entry.status === "current" && !exists) {
			report(
				"document-gone",
				`${label}: ${entry.source} does not exist. Remove the entry, or mark it "planned".`,
			);
			continue;
		}
		if (entry.status === "planned") {
			if (exists) {
				report(
					"planned-exists",
					`${label}: ${entry.source} now exists. Set status to "current" and run ` +
						`\`node scripts/check-legal-set.mjs --sync\`.`,
				);
			}
			if (entry.sealed !== false) {
				report("document-shape", `${label}: a planned document cannot be sealed.`);
			}
			continue;
		}
		if (entry.status === "draft") {
			if (!exists) {
				report(
					"document-gone",
					`${label}: ${entry.source} does not exist. A draft must be written; mark it "planned".`,
				);
			}
			if (entry.sealed !== false || sealed.has(entry.source)) {
				report(
					"draft-sealed",
					`${label}: a draft is not in force, so it cannot be sealed or declared in ${DOCUMENTS_TS}.`,
				);
			}
			for (const key of ["version", "displayedDate", "contentHash"]) {
				if ((entry[key] ?? null) !== null) {
					report("document-shape", `${label}: a draft carries no ${key}; set it to null.`);
				}
			}
			continue;
		}

		const isSealed = sealed.has(entry.source);
		if (entry.sealed !== isSealed) {
			report(
				"sealed-mismatch",
				`${label}: sealed is ${JSON.stringify(entry.sealed)} but ${DOCUMENTS_TS} ` +
					`${isSealed ? "declares" : "does not declare"} ${entry.source}.`,
			);
		}
		if (isSealed && entry.route !== sealed.get(entry.source).path) {
			report(
				"sealed-mismatch",
				`${label}: route ${JSON.stringify(entry.route)} differs from the sealed path ` +
					`${JSON.stringify(sealed.get(entry.source).path)}.`,
			);
		}
		const derived = derivedFields(entry, fs, sealed);
		for (const key of ["version", "displayedDate", "contentHash"]) {
			if ((entry[key] ?? null) !== derived[key]) {
				report(
					"derived-stale",
					`${label}: ${key} is ${JSON.stringify(entry[key] ?? null)} but its source says ` +
						`${JSON.stringify(derived[key])}. Run \`node scripts/check-legal-set.mjs --sync\`.`,
				);
			}
		}
	}

	// ── coverage: everything that exists is registered ──────────────────────────────────────────
	const byRoute = new Map(
		documents.filter((d) => d && typeof d.route === "string").map((d) => [d.route, d]),
	);
	for (const route of shellRoutes) {
		const entry = byRoute.get(route);
		const page = `${MARKETING_APP}${route}/page.tsx`;
		if (!entry) {
			report(
				"unregistered",
				`${route} is linked from the legal index in ${LEGAL_SHELL} and is not in the register.`,
			);
		} else if (entry.source !== page) {
			report(
				"unregistered",
				`documents: ${entry.id}: route ${route} is rendered by ${page}, not ${entry.source}.`,
			);
		}
	}
	for (const source of sealed.keys()) {
		if (!bySource.has(source)) {
			report("unregistered", `${source} is sealed in ${DOCUMENTS_TS} and is not in the register.`);
		}
	}
	for (const source of legalDocs) {
		if (!bySource.has(source)) {
			report("unregistered", `${source} is in ${LEGAL_DOCS_DIR}/ and is not in the register.`);
		}
	}

	// ── claims ──────────────────────────────────────────────────────────────────────────────────
	const seen = new Set();
	/** Shared by claims and findings: the id, the document, the owner and the quote. */
	const checkCommon = (list, entry) => {
		const label = `${list}: ${entry?.id ?? "(no id)"}`;
		if (!entry || typeof entry.id !== "string" || !ID.test(entry.id)) {
			report("entry-shape", `${label}: needs an id of lower-case words joined by "." or "-".`);
			return null;
		}
		if (seen.has(entry.id)) report("duplicate-id", `${label}: the id is used twice.`);
		seen.add(entry.id);
		if (typeof entry.owner !== "string" || !UNIT.test(entry.owner)) {
			report("entry-shape", `${label}: owner must be a board unit id such as LEG-L1.`);
		}
		const doc = byId.get(entry.document);
		if (!doc) {
			report("unknown-document", `${label}: "${entry.document}" is not a document id in the register.`);
			return null;
		}
		if (doc.status !== "current") {
			report(
				"unknown-document",
				`${label}: document "${entry.document}" is ${doc.status}, not current.`,
			);
			return null;
		}
		const content = fs.read(doc.source);
		if (content === null) return null;
		return { label, doc, content };
	};

	for (const claim of claims) {
		const ctx = checkCommon("claims", claim);
		if (!ctx) continue;
		const { label, doc, content } = ctx;
		if (!CLAIM_KINDS.includes(claim.kind)) {
			report("entry-shape", `${label}: kind must be one of ${CLAIM_KINDS.join(", ")}.`);
		}
		if (!CLAIM_STATUSES.includes(claim.status)) {
			report("entry-shape", `${label}: status must be one of ${CLAIM_STATUSES.join(", ")}.`);
		}
		if (typeof claim.verifiedOn !== "string" || !ISO_DATE.test(claim.verifiedOn)) {
			report("entry-shape", `${label}: verifiedOn must be an ISO date.`);
		}
		if (typeof claim.quote !== "string" || squash(claim.quote).length < MIN_PATTERN_LENGTH) {
			report("entry-shape", `${label}: needs a quote copied from the document's source.`);
		} else if (!quotePresent(claim.quote, content)) {
			report(
				"quote-gone",
				`${label}: the quote is no longer in ${doc.source}. The document changed: re-read the ` +
					`statement, then update or remove the claim.`,
			);
		}
		const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
		if (claim.status === "tied") {
			if (evidence.length === 0) {
				report("claim-untied", `${label}: a "tied" claim needs at least one evidence item.`);
			}
			if (claim.requires !== undefined) {
				report("entry-shape", `${label}: "requires" belongs only on an outside-repo claim.`);
			}
		}
		if (claim.status === "outside-repo") {
			if (typeof claim.requires !== "string" || !claim.requires) {
				report(
					"claim-untied",
					`${label}: an "outside-repo" claim needs "requires": what, held where, would settle it.`,
				);
			}
		}
		checkEvidence(label, evidence, fs, report);
	}

	// ── findings ────────────────────────────────────────────────────────────────────────────────
	for (const finding of findings) {
		const ctx = checkCommon("findings", finding);
		if (!ctx) continue;
		const { label, doc, content } = ctx;
		for (const key of ["says", "actually"]) {
			if (typeof finding[key] !== "string" || !finding[key]) {
				report("entry-shape", `${label}: needs "${key}".`);
			}
		}
		if (typeof finding.foundOn !== "string" || !ISO_DATE.test(finding.foundOn)) {
			report("entry-shape", `${label}: foundOn must be an ISO date.`);
		}
		if (finding.quote !== null) {
			if (typeof finding.quote !== "string" || squash(finding.quote).length < MIN_PATTERN_LENGTH) {
				report("entry-shape", `${label}: quote must be text from the document, or null.`);
			} else if (!quotePresent(finding.quote, content)) {
				report(
					"finding-stale",
					`${label}: the quote is no longer in ${doc.source}. If the document was corrected, ` +
						`remove the finding; if it was reworded, re-quote it.`,
				);
			}
		}
		checkEvidence(label, Array.isArray(finding.evidence) ? finding.evidence : [], fs, report);
	}

	return problems;
}

/** The real tree, as the `fs` shape `checkLegalSet` takes. */
function repoFs() {
	return {
		read(path) {
			const full = join(ROOT, path);
			try {
				return readFileSync(full, "utf8");
			} catch {
				return null;
			}
		},
		list(dir) {
			const full = join(ROOT, dir);
			return existsSync(full) ? readdirSync(full) : [];
		},
	};
}

/** Serialises the register the one way `--sync` and the committed file both use. */
export function serialise(register) {
	return `${JSON.stringify(register, null, "\t")}\n`;
}

/** Rewrites the derived fields of every current document from their sources. */
function sync() {
	const fs = repoFs();
	const register = JSON.parse(fs.read(REGISTER_PATH));
	const sealed = parseSealedDocuments(fs.read(DOCUMENTS_TS) ?? "");
	let changed = 0;
	for (const entry of register.documents) {
		const derived = syncedFields(entry, fs, sealed);
		if (derived === null) continue;
		for (const key of ["version", "displayedDate", "contentHash"]) {
			if ((entry[key] ?? null) !== derived[key]) {
				console.log(`  ${entry.id}: ${key} ${JSON.stringify(entry[key] ?? null)} → ${JSON.stringify(derived[key])}`);
				entry[key] = derived[key];
				changed += 1;
			}
		}
	}
	writeFileSync(join(ROOT, REGISTER_PATH), serialise(register));
	console.log(`✓ check-legal-set: synced ${changed} derived field(s).`);
}

/** Prints the register as Markdown: the document table, then the claims and the open findings. */
function print() {
	const register = JSON.parse(repoFs().read(REGISTER_PATH));
	const cell = (v) => (v === null || v === undefined ? "—" : String(v));
	console.log("| Document | Kind | Route | Source | Status | Sealed | Version | Owner |");
	console.log("|---|---|---|---|---|---|---|---|");
	for (const d of register.documents) {
		const seal = d.sealed ? `yes (${d.contentHash.slice(0, 12)}…)` : "no";
		console.log(
			`| ${d.title} | ${d.kind} | ${cell(d.route)} | \`${d.source}\` | ${d.status} | ${seal} | ` +
				`${cell(d.version)} | ${cell(d.owner)} |`,
		);
	}
	console.log("\n## Claims\n");
	for (const c of register.claims) {
		console.log(`- **${c.id}** (${c.document}, ${c.status}, ${c.owner}): "${squash(c.quote)}"`);
		for (const e of c.evidence) console.log(`  - \`${e.path}\`: ${e.shows}`);
		if (c.requires) console.log(`  - Needs: ${c.requires}`);
	}
	console.log("\n## Open findings\n");
	for (const f of register.findings) {
		console.log(`- **${f.id}** (${f.document}, ${f.owner})`);
		if (f.quote) console.log(`  - Quote: "${squash(f.quote)}"`);
		console.log(`  - Says: ${f.says}`);
		console.log(`  - Actually: ${f.actually}`);
	}
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────

/** A small, consistent tree: two pages (one sealed), one internal record, one claim, one finding. */
function fixtureTree() {
	const terms = `<LegalShell title="Terms" lastUpdated="August 24, 2026">\n<p>The company is not\n registered for VAT.</p>`;
	const privacy = `<LegalShell title="Privacy" lastUpdated="August 12, 2026">\n<li>Job logs: 30 days by default.</li>\n<p>You can change replay consent here.</p>`;
	const register = {
		schemaVersion: 1,
		documents: [
			{
				id: "terms",
				title: "Terms of Service",
				kind: "public-page",
				route: "/terms",
				source: "apps/marketing/app/terms/page.tsx",
				status: "current",
				sealed: true,
				version: "2026-08-24",
				displayedDate: "2026-08-24",
				contentHash: "a".repeat(64),
				owner: "LEG-L2",
			},
			{
				id: "privacy",
				title: "Privacy Policy",
				kind: "public-page",
				route: "/privacy",
				source: "apps/marketing/app/privacy/page.tsx",
				status: "current",
				sealed: false,
				version: "2026-08-12",
				displayedDate: "2026-08-12",
				contentHash: null,
				owner: "LEG-L1",
			},
			{
				id: "accountability",
				title: "Accountability record",
				kind: "internal-record",
				route: null,
				source: "docs/legal/ACCOUNTABILITY.md",
				status: "current",
				sealed: false,
				version: "2026-08-12",
				displayedDate: "2026-08-12",
				contentHash: null,
				owner: "LEG-L1",
			},
			{
				id: "dpia",
				title: "DPIA",
				kind: "internal-record",
				route: null,
				source: "docs/legal/DPIA.md",
				status: "planned",
				sealed: false,
				version: null,
				displayedDate: null,
				contentHash: null,
				owner: "LEG-L4",
			},
		],
		claims: [
			{
				id: "privacy.retention.job-logs",
				document: "privacy",
				kind: "retention",
				status: "tied",
				quote: "Job logs: 30 days by default.",
				evidence: [
					{ path: "lib/retention.ts", pattern: "jobLogs: 30,", shows: "The default window." },
				],
				owner: "LEG-L1",
				verifiedOn: "2026-11-17",
			},
			{
				id: "terms.email-provider",
				document: "terms",
				kind: "subprocessor",
				status: "outside-repo",
				quote: "registered for VAT.",
				evidence: [],
				requires: "The production vault value.",
				owner: "LEG-L2",
				verifiedOn: "2026-11-17",
			},
		],
		findings: [
			{
				id: "privacy.replay-consent",
				document: "privacy",
				quote: "You can change replay consent here.",
				says: "There is a replay consent.",
				actually: "There is none.",
				evidence: [
					{ path: "lib/retention.ts", pattern: "noReplay: true", shows: "Replay is pinned off." },
					{ path: "lib/retention.ts", absent: "replayConsent", shows: "No replay choice exists." },
				],
				owner: "LEG-L1",
				foundOn: "2026-11-17",
			},
		],
	};
	return {
		"docs/legal/legal-set.json": serialise(register),
		"docs/legal/README.md": "# The register\n",
		"docs/legal/ACCOUNTABILITY.md": "# Record\n\nEffective: 2026-08-12\n",
		"apps/marketing/app/terms/page.tsx": terms,
		"apps/marketing/app/privacy/page.tsx": privacy,
		"apps/marketing/components/legal/legal-shell.tsx":
			'const DOCUMENTS = [\n\t{ label: "Privacy", href: "/privacy" },\n\t{ label: "Terms", href: "/terms" },\n];\n',
		"packages/legal/src/documents.ts":
			`export const LEGAL_DOCUMENTS = [\n\t{\n\t\tid: "terms",\n\t\tversion: "2026-08-24",\n\t\tpath: "/terms",\n\t\tcontentHash:\n\t\t\t"${"a".repeat(64)}",\n\t\tsource: "apps/marketing/app/terms/page.tsx",\n\t},\n];\n`,
		"lib/retention.ts": "export const D = {\n\tjobLogs: 30,\n\tnoReplay: true,\n};\n",
	};
}

/** Wraps an in-memory tree in the `fs` shape. */
function memoryFs(tree) {
	return {
		read: (path) => (Object.hasOwn(tree, path) ? tree[path] : null),
		list: (dir) =>
			Object.keys(tree)
				.filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
				.map((p) => p.slice(dir.length + 1)),
	};
}

/** Edits the fixture's register in place. */
function editRegister(tree, edit) {
	const register = JSON.parse(tree[REGISTER_PATH]);
	edit(register);
	tree[REGISTER_PATH] = serialise(register);
}

/**
 * Each case breaks the clean fixture in one way and names the code that must be reported.
 * A case that reports nothing is the failure this self-test exists to catch.
 */
const SELF_TEST_CASES = [
	{
		name: "a page linked from the legal index that is not registered",
		code: "unregistered",
		mutate: (t) => {
			t[LEGAL_SHELL] = t[LEGAL_SHELL].replace("];", '\t{ label: "Cookies", href: "/cookies" },\n];');
		},
	},
	{
		name: "a new file in docs/legal that is not registered",
		code: "unregistered",
		mutate: (t) => {
			t["docs/legal/RETENTION_SCHEDULE.md"] = "# Schedule\n";
		},
	},
	{
		name: "a sealed document that is not registered",
		code: "unregistered",
		mutate: (t) => {
			// The index link goes too, so the registry is the only thing left that names the page.
			t[LEGAL_SHELL] = t[LEGAL_SHELL].replace('\t{ label: "Terms", href: "/terms" },\n', "");
			editRegister(t, (r) => {
				r.documents = r.documents.filter((d) => d.id !== "terms");
				r.claims = r.claims.filter((c) => c.document !== "terms");
			});
		},
	},
	{
		name: "a registered document whose file is gone",
		code: "document-gone",
		mutate: (t) => {
			delete t["docs/legal/ACCOUNTABILITY.md"];
		},
	},
	{
		name: "a planned document that has since been written",
		code: "planned-exists",
		mutate: (t) => {
			t["docs/legal/DPIA.md"] = "# DPIA\n";
		},
	},
	{
		name: "a draft whose file is gone",
		code: "document-gone",
		mutate: (t) => editRegister(t, (r) => {
			r.documents[3].status = "draft";
		}),
	},
	{
		name: "a draft marked sealed",
		code: "draft-sealed",
		mutate: (t) => {
			t["docs/legal/DPIA.md"] = "# DPIA\n\nEffective: 2026-11-23\n";
			editRegister(t, (r) => {
				r.documents[3].status = "draft";
				r.documents[3].sealed = true;
			});
		},
	},
	{
		name: "a draft declared in the sealed registry",
		code: "draft-sealed",
		mutate: (t) => {
			t[DOCUMENTS_TS] = t[DOCUMENTS_TS].replace(
				"apps/marketing/app/terms/page.tsx",
				"docs/legal/DPIA.md",
			);
			t["docs/legal/DPIA.md"] = "# DPIA\n\nEffective: 2026-11-23\n";
			editRegister(t, (r) => {
				r.documents[3].status = "draft";
			});
		},
	},
	{
		name: "a draft given a version as if it were in force",
		code: "document-shape",
		mutate: (t) => {
			t["docs/legal/DPIA.md"] = "# DPIA\n\nEffective: 2026-11-23\n";
			editRegister(t, (r) => {
				r.documents[3].status = "draft";
				r.documents[3].version = "2026-11-23";
			});
		},
	},
	{
		name: "a claim about a document that is only a draft",
		code: "unknown-document",
		mutate: (t) => {
			t["docs/legal/DPIA.md"] = "# DPIA\n\nEffective: 2026-11-23\n";
			editRegister(t, (r) => {
				r.documents[3].status = "draft";
				r.claims[0].document = "dpia";
			});
		},
	},
	{
		name: "a document marked sealed that the registry does not declare",
		code: "sealed-mismatch",
		mutate: (t) => editRegister(t, (r) => {
			r.documents[1].sealed = true;
		}),
	},
	{
		name: "a version left behind by a re-seal",
		code: "derived-stale",
		mutate: (t) => {
			t[DOCUMENTS_TS] = t[DOCUMENTS_TS].replace('version: "2026-08-24"', 'version: "2026-12-01"');
		},
	},
	{
		name: "a content hash left behind by a re-seal",
		code: "derived-stale",
		mutate: (t) => {
			t[DOCUMENTS_TS] = t[DOCUMENTS_TS].replace("a".repeat(64), "b".repeat(64));
		},
	},
	{
		name: "a page date changed without the register",
		code: "derived-stale",
		mutate: (t) => {
			const p = "apps/marketing/app/privacy/page.tsx";
			t[p] = t[p].replace("August 12, 2026", "December 1, 2026");
		},
	},
	{
		name: "a claim whose quote has left the page",
		code: "quote-gone",
		mutate: (t) => {
			const p = "apps/marketing/app/privacy/page.tsx";
			t[p] = t[p].replace("30 days by default", "90 days by default");
		},
	},
	{
		name: "a claim whose evidence no longer matches the code",
		code: "evidence-no-match",
		mutate: (t) => {
			t["lib/retention.ts"] = t["lib/retention.ts"].replace("jobLogs: 30,", "jobLogs: 90,");
		},
	},
	{
		name: "a claim whose evidence file is gone",
		code: "evidence-missing-file",
		mutate: (t) => editRegister(t, (r) => {
			r.claims[0].evidence[0].path = "lib/gone.ts";
		}),
	},
	{
		name: "a tied claim with no evidence",
		code: "claim-untied",
		mutate: (t) => editRegister(t, (r) => {
			r.claims[0].evidence = [];
		}),
	},
	{
		name: "an outside-repo claim that does not say what would settle it",
		code: "claim-untied",
		mutate: (t) => editRegister(t, (r) => {
			delete r.claims[1].requires;
		}),
	},
	{
		name: "an evidence pattern that matches every file",
		code: "evidence-pattern",
		mutate: (t) => editRegister(t, (r) => {
			r.claims[0].evidence[0].pattern = "(jobLogs)?";
		}),
	},
	{
		name: "an evidence pattern too short to mean anything",
		code: "evidence-pattern",
		mutate: (t) => editRegister(t, (r) => {
			r.claims[0].evidence[0].pattern = "30";
		}),
	},
	{
		name: "evidence with no sentence saying what it shows",
		code: "evidence-shape",
		mutate: (t) => editRegister(t, (r) => {
			delete r.claims[0].evidence[0].shows;
		}),
	},
	{
		name: "a claim about a document the register does not hold",
		code: "unknown-document",
		mutate: (t) => editRegister(t, (r) => {
			r.claims[0].document = "cookies";
		}),
	},
	{
		name: "a claim about a document that is only planned",
		code: "unknown-document",
		mutate: (t) => editRegister(t, (r) => {
			r.claims[0].document = "dpia";
		}),
	},
	{
		name: "a finding whose page has been corrected",
		code: "finding-stale",
		mutate: (t) => {
			const p = "apps/marketing/app/privacy/page.tsx";
			t[p] = t[p].replace("<p>You can change replay consent here.</p>", "");
		},
	},
	{
		name: "a finding whose evidence no longer matches the code",
		code: "evidence-no-match",
		mutate: (t) => {
			t["lib/retention.ts"] = t["lib/retention.ts"].replace("noReplay: true", "noReplay: false");
		},
	},
	{
		name: "a finding that something is missing, after it was added",
		code: "evidence-now-present",
		mutate: (t) => {
			t["lib/retention.ts"] += "export const replayConsent = true;\n";
		},
	},
	{
		name: "evidence that both requires and forbids a pattern",
		code: "evidence-shape",
		mutate: (t) => editRegister(t, (r) => {
			r.findings[0].evidence[1].pattern = "noReplay: true";
		}),
	},
	{
		name: "the same id used by a claim and a finding",
		code: "duplicate-id",
		mutate: (t) => editRegister(t, (r) => {
			r.findings[0].id = r.claims[0].id;
		}),
	},
	{
		name: "a document with no owner and no reason",
		code: "document-owner",
		mutate: (t) => editRegister(t, (r) => {
			r.documents[2].owner = null;
		}),
	},
	{
		name: "an owner that is not a board unit",
		code: "document-owner",
		mutate: (t) => editRegister(t, (r) => {
			r.documents[2].owner = "counsel";
		}),
	},
	{
		name: "a registry file the parser can no longer read",
		code: "parser-blind",
		mutate: (t) => {
			t[DOCUMENTS_TS] = "export const LEGAL_DOCUMENTS = [];\n";
		},
	},
	{
		name: "a legal index the parser can no longer read",
		code: "parser-blind",
		mutate: (t) => {
			t[LEGAL_SHELL] = "export const LINKS = [];\n";
		},
	},
	{
		name: "a register that is not JSON",
		code: "register-json",
		mutate: (t) => {
			t[REGISTER_PATH] = "{";
		},
	},
];

/** Runs the fixtures; returns the number of cases that did not behave as stated. */
function selfTest() {
	let failed = 0;
	const clean = checkLegalSet(memoryFs(fixtureTree()));
	if (clean.length > 0) {
		failed += 1;
		console.error("✗ self-test: the clean fixture reported problems:");
		for (const p of clean) console.error(`    [${p.code}] ${p.message}`);
	}
	// A quote must survive re-wrapping, or every prettier run would red the ledger.
	const rewrapped = fixtureTree();
	rewrapped["apps/marketing/app/privacy/page.tsx"] = rewrapped[
		"apps/marketing/app/privacy/page.tsx"
	].replace("Job logs: 30 days", "Job logs:\n\t\t\t30 days");
	if (checkLegalSet(memoryFs(rewrapped)).length > 0) {
		failed += 1;
		console.error("✗ self-test: a re-wrapped paragraph was reported as a changed quote.");
	}
	// A written draft is the one status whose file must exist and that --sync leaves alone: it is
	// clean as it stands, and syncing must not give it a version (that would read as in force).
	const drafted = fixtureTree();
	drafted["docs/legal/DPIA.md"] = "# DPIA\n\nEffective: 2026-11-23\n";
	editRegister(drafted, (r) => {
		r.documents.find((d) => d.id === "dpia").status = "draft";
	});
	const draftFs = memoryFs(drafted);
	const draftEntry = JSON.parse(drafted[REGISTER_PATH]).documents.find((d) => d.id === "dpia");
	if (checkLegalSet(draftFs).length > 0 || syncedFields(draftEntry, draftFs, new Map()) !== null) {
		failed += 1;
		console.error("✗ self-test: a written draft was reported, or --sync would give it a version.");
	}
	for (const testCase of SELF_TEST_CASES) {
		const tree = fixtureTree();
		testCase.mutate(tree);
		const codes = checkLegalSet(memoryFs(tree)).map((p) => p.code);
		if (!codes.includes(testCase.code)) {
			failed += 1;
			console.error(
				`✗ self-test: ${testCase.name} — expected [${testCase.code}], got ` +
					`${codes.length === 0 ? "no problem at all" : `[${codes.join(", ")}]`}.`,
			);
		}
	}
	if (isoFromLongDate("August 5, 2026") !== "2026-08-05" || isoFromLongDate("5 August 2026") !== null) {
		failed += 1;
		console.error("✗ self-test: isoFromLongDate does not read the page date format.");
	}
	return failed;
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) {
		const failed = selfTest();
		if (failed > 0) {
			console.error(`::error::check-legal-set --self-test: ${failed} case(s) failed.`);
			process.exit(1);
		}
		console.log(`✓ check-legal-set --self-test: ${SELF_TEST_CASES.length + 4} case(s) behave as stated.`);
		process.exit(0);
	}
	if (argv.includes("--sync")) {
		sync();
	} else if (argv.includes("--print")) {
		print();
		process.exit(0);
	}
	const problems = checkLegalSet(repoFs());
	if (problems.length > 0) {
		for (const p of problems) console.error(`::error::check-legal-set [${p.code}] ${p.message}`);
		console.error(`\ncheck-legal-set: ${problems.length} problem(s). See docs/legal/README.md.`);
		process.exit(1);
	}
	const register = JSON.parse(repoFs().read(REGISTER_PATH));
	const tied = register.claims.filter((c) => c.status === "tied").length;
	console.log(
		`✓ check-legal-set: ${register.documents.length} document(s) registered; ${tied} claim(s) tied ` +
			`to code, ${register.claims.length - tied} held outside the repository; ` +
			`${register.findings.length} open finding(s) still reproduce.`,
	);
}
