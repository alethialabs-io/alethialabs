#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DESTRUCTIVE-ACTION CENSUS — the static half of #4266.
//
//   node scripts/check-destructive-actions.mjs              census the tree against the registry
//   node scripts/check-destructive-actions.mjs --self-test  the fixtures, no tree, no board
//   node scripts/check-destructive-actions.mjs --json       the derived view; writes nothing
//
// `apps/console/destructive-actions.yaml` is a ledger of every control that deletes, removes,
// destroys, revokes, cancels, detaches, disconnects, discards or suspends something. A ledger is a
// claim about the tree, and an unmeasured claim is how the drift this repo keeps paying for got
// here. This script makes the claim true in the STATIC direction; `apps/console/e2e/audit/
// destructive.spec.ts` makes it true in the LIVE one.
//
// ── WHAT IT ASKS, AND IN BOTH DIRECTIONS ────────────────────────────────────────────────────────
//
//   1. TREE → LEDGER.  Every destructive call site under the scan roots has an entry (or an
//      `allow:` exemption with a reason). This is the direction that catches a NEW delete button
//      shipped without a confirmation and without anybody noticing.
//   2. LEDGER → TREE.  Every entry's `mutation` really occurs in the file that is supposed to
//      invoke it. This is the direction that catches an entry outliving its subject — the failure
//      mode that is SILENT, because a stale entry suppresses a real finding forever by making a
//      site look accounted for.
//
// Both directions matter and they fail differently: (1) is loud on a new defect, (2) is the one
// nobody notices. An exception ledger checked in only one direction is worse than none.
//
// ── THE FLOOR, AND WHAT IT PROTECTS AGAINST ─────────────────────────────────────────────────────
//
// `SITE_FLOOR` refuses a run that finds fewer than 30 call sites. It is NOT a quality bar and it
// is not "we expect 30 destructive controls". It exists because every rule above is of the shape
// "for each site found…", and a scan that finds nothing satisfies all of them vacuously. The
// import-shape regex, the scan roots and the verb table are each one refactor away from matching
// zero — `apps/console/app` moving under a `src/`, imports switching to a barrel file, the
// codebase adopting `use server` inline — and in every one of those cases this guard would go
// green while measuring nothing. 30 sits below today's census with room for a lane to legitimately
// delete a handful of controls, and far above zero. If it ever fires, the answer is to find out
// what stopped matching, NOT to lower it.
//
// ── OMISSIONS, STATED RATHER THAN INFERRED ──────────────────────────────────────────────────────
//
// Read these here rather than concluding from the rules above that the census is exhaustive:
//
//   · A destructive mutation reached through a VARIABLE (`const fn = cond ? deleteA : deleteB;
//     fn()`) is not matched. The census greps for a called identifier, and an indirect call has no
//     identifier at the call site. Not worked around, because the workaround is a type-aware pass
//     and this is a grep; the LIVE spec is what covers the control regardless of how it dispatches.
//   · A mutation invoked from a file outside `SCAN_ROOTS` — `packages/**`, `ee/**` — is found by
//     direction (1) only if an entry names it via `mutation_surface`, which direction (2) then
//     reads directly. The roots are the three trees a console control can be reached from; the two
//     `SCAN_EXCLUDE` subtrees inside them are argued at their declaration.
//   · An ALIASED import is matched on either name (see `scanSource`), so a ledger may record the
//     exported identifier or the local one. It may NOT record a third name that appears nowhere.
//   · A `fetch` whose path is BUILT (`fetch(`/api/org/${id}`, …)`) is matched on the literal
//     prefix only. The registry's bare-fetch shape carries a literal path for exactly this reason.
//   · Verb coverage is a TABLE, not a language model. `DESTRUCTIVE_VERB` plus `HIDDEN_VERBS` is
//     what is asked; a destructive action named `purgeFoo` or `expireFoo` would be missed until
//     the table learns it. That is a known and accepted bound: the table is cheap to extend and a
//     regex over English is not.
//
// ── WHY A HAND-ROLLED YAML READER ───────────────────────────────────────────────────────────────
//
// A de-hydrated worktree has no `node_modules`, so there is no `js-yaml` and never will be here —
// the same reason `check-shared-surface.mjs` and `check-coverage-exclusions.mjs` each carry one.
// It reads the subset this one file uses and REFUSES anything else rather than guessing, because a
// reader that silently drops a field it did not understand turns every rule above into a vacuous
// pass over a shorter list.
//
// It is EXPORTED, and `apps/console/e2e/audit/destructive.spec.ts` imports it. One list read by
// three instruments is the registry's whole premise; two readers of one list would reintroduce the
// disagreement the registry exists to prevent, one level down.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripCommentLines } from "./lib/console-routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

export const REGISTRY_PATH = "apps/console/destructive-actions.yaml";

/**
 * The trees a destructive control can be reached from: the components, the routed pages, and the
 * hooks and stores those two delegate to.
 *
 * `lib` is here because six controls are PRESENTATIONAL — `pool-card.tsx` renders the trigger and
 * raises `onDelete`, and a query hook or a store is what actually calls the server action. Without
 * `lib` those six mutations have no call site at all and direction (1) never sees them.
 */
export const SCAN_ROOTS = ["apps/console/components", "apps/console/app", "apps/console/lib"];

/**
 * Subtrees excluded from direction (1), each because it is the OTHER SIDE of the click.
 *
 * This is the dangerous direction — an over-broad exclusion makes the census pass on the very
 * regression it exists to catch — so each is argued here and PINNED by a self-test fixture below,
 * and the list is deliberately two entries rather than a pattern anybody can extend by habit:
 *
 *   · `app/api/**` are HTTP route handlers. A `route.ts` renders nothing and has no dialog, so
 *     "what stands between a click and the mutation" is not a question that can be asked of it.
 *     Whether those routes are correctly authorized is a real question — it is just a different
 *     one, and it has its own guards (`check:action-boundary`, the authz suites).
 *   · `app/server/**` are the server actions themselves. An action DEFINES the mutation; it is
 *     what the click reaches, not what a person clicks. Counting a definition as a call site would
 *     make every entry self-satisfying.
 *
 * Neither exclusion weakens direction (2): an entry's `mutation_surface` may still point anywhere
 * in the tree, and that check reads the named file directly rather than through this walk.
 */
export const SCAN_EXCLUDE = ["apps/console/app/api", "apps/console/app/server"];

/** See "THE FLOOR" above. Lower this only after finding out what stopped matching. */
export const SITE_FLOOR = 30;

const SCAN_EXT = new Set([".tsx", ".ts"]);

/**
 * The verbs that announce themselves. `[A-Z]` after the verb is what makes this a NAME rather than
 * a substring: it matches `deleteProject`, never `deleted` or `cancellationReason`.
 */
export const DESTRUCTIVE_VERB =
	/^(delete|remove|destroy|revoke|cancel|detach|disconnect|reject|unshare|suspend)[A-Z]/;

/**
 * The verbs that HIDE — destructive mutations whose names are neutral, so `DESTRUCTIVE_VERB` reads
 * them as ordinary. Each carries why it is destructive, because "it is on the list" is not a reason
 * a later reader can check.
 *
 * This table is the census's known bound and its cheapest extension point. A new destructive
 * control with a neutral name is invisible to direction (1) until it is added here — which is why
 * the LIVE spec walks the whole ledger rather than only what this table can find.
 */
export const HIDDEN_VERBS = new Map([
	["setMemberSuspended", "suspending a member is destructive; the name says only that a flag moved"],
	["setChannelEnabled", "disabling a channel silently stops alert delivery — the confirm fires only on the false branch"],
	["bulkRemove", "the bulk form of removeMember, named for the batch rather than the act"],
	["bulkSuspend", "the bulk form of setMemberSuspended"],
	["useDisableAddon", "a hook wrapping the disable mutation; the call site is the hook, not the action"],
	["discardStagedChanges", "discards every staged canvas edit — destructive, and named for the buffer"],
	["upsertAgentContext", "the knowledge-doc delete rewrites the whole context; the delete is an upsert of a shorter list"],
	["togglePolicy", "disabling an alert policy silences a class of alerts across every channel routed to it — found by a human reading the surface, not by this table (#4492)"],
]);

/**
 * `authClient.organization.*` methods that destroy something. The auth client is a third-party
 * surface, so its names are not ours to make legible — they are enumerated instead.
 */
export const AUTH_CLIENT_DESTRUCTIVE = new Set([
	"delete",
	"removeMember",
	"cancelInvitation",
	"removeTeam",
	"leave",
]);

/** Statuses the registry's field contract defines. */
const STATUSES = new Set(["confirmed", "missing", "inert"]);

// ── the reader ──────────────────────────────────────────────────────────────────────────────────

/**
 * Split a YAML scalar off a `key: value` line, honouring quotes so a `#` inside a string is not
 * read as a comment. Returns the raw value text with a trailing comment removed.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingComment(text) {
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		// A `#` opens a comment only when it follows whitespace or starts the value — `a#b` is a
		// scalar. Every YAML reader agrees on this and so must this one.
		if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
	}
	return text;
}

/**
 * Unquote a YAML scalar. `""` stays the empty string — the registry uses it deliberately for an
 * `inert` control, and collapsing it to undefined would erase the distinction the field contract
 * draws between "no mutation exists" and "nobody has pinned it".
 *
 * @param {string} raw
 * @returns {string}
 */
function scalar(raw) {
	const t = raw.trim();
	if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
		return t.slice(1, -1).replace(/\\"/g, '"');
	}
	return t;
}

/**
 * Parse a YAML FLOW map — `{ role: button, name: "Delete" }` — or a flow sequence of them.
 * Deliberately small: it handles the two shapes `reach:` and `control:` use and refuses the rest,
 * because a reader that half-understands a flow collection is a reader that drops fields.
 *
 * @param {string} raw
 * @returns {unknown}
 */
export function parseFlow(raw) {
	const t = raw.trim();
	if (t.startsWith("[")) {
		if (!t.endsWith("]")) throw new Error(`unterminated flow sequence: ${t}`);
		const inner = t.slice(1, -1).trim();
		if (!inner) return [];
		/** @type {string[]} */
		const parts = [];
		let depth = 0;
		let quote = "";
		let start = 0;
		for (let i = 0; i < inner.length; i++) {
			const ch = inner[i];
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "{" || ch === "[") depth++;
			else if (ch === "}" || ch === "]") depth--;
			else if (ch === "," && depth === 0) {
				parts.push(inner.slice(start, i));
				start = i + 1;
			}
		}
		parts.push(inner.slice(start));
		return parts.map((p) => parseFlow(p));
	}
	if (t.startsWith("{")) {
		if (!t.endsWith("}")) throw new Error(`unterminated flow map: ${t}`);
		const inner = t.slice(1, -1);
		/** @type {Record<string, string>} */
		const out = {};
		let quote = "";
		let start = 0;
		/** @type {string[]} */
		const pairs = [];
		for (let i = 0; i < inner.length; i++) {
			const ch = inner[i];
			if (quote) {
				if (ch === "\\") i++;
				else if (ch === quote) quote = "";
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === ",") {
				pairs.push(inner.slice(start, i));
				start = i + 1;
			}
		}
		pairs.push(inner.slice(start));
		for (const pair of pairs) {
			if (!pair.trim()) continue;
			const c = pair.indexOf(":");
			if (c === -1) throw new Error(`flow map entry without a colon: ${pair}`);
			out[pair.slice(0, c).trim()] = scalar(pair.slice(c + 1));
		}
		return out;
	}
	return scalar(t);
}

/**
 * Read the registry. Understands exactly the shape `destructive-actions.yaml` uses: top-level
 * scalars, and the two block sequences `allow:` and `controls:` whose items are maps of scalars and
 * flow collections. Anything else RAISES.
 *
 * @param {string} source raw YAML
 * @returns {{version: string, allow: Record<string, string>[], controls: Record<string, any>[]}}
 */
export function parseRegistry(source) {
	/** @type {{version: string, allow: Record<string, string>[], controls: Record<string, any>[]}} */
	const doc = { version: "", allow: [], controls: [] };
	/** @type {"root"|"allow"|"controls"} */
	let section = "root";
	/** @type {Record<string, any>|null} */
	let item = null;

	const lines = source.split("\n");
	for (let n = 0; n < lines.length; n++) {
		const rawLine = lines[n];
		const where = `${REGISTRY_PATH}:${n + 1}`;
		// A whole-line comment. Leading-`#` lines are the file's prose; they carry no data.
		if (/^\s*#/.test(rawLine) || !rawLine.trim()) continue;

		const indent = rawLine.length - rawLine.trimStart().length;
		const body = stripTrailingComment(rawLine.trimStart()).trimEnd();
		if (!body) continue;

		if (indent === 0) {
			const c = body.indexOf(":");
			if (c === -1) throw new Error(`${where}: top-level line without a colon: ${body}`);
			const key = body.slice(0, c).trim();
			const rest = body.slice(c + 1).trim();
			if (key === "allow") {
				section = "allow";
				item = null;
			} else if (key === "controls") {
				section = "controls";
				item = null;
			} else if (key === "version") {
				doc.version = scalar(rest);
				section = "root";
				item = null;
			} else {
				throw new Error(`${where}: unknown top-level key "${key}" — this reader understands version, allow, controls`);
			}
			continue;
		}

		if (section === "root") throw new Error(`${where}: indented line outside allow/controls: ${body}`);

		if (body.startsWith("- ")) {
			item = {};
			(section === "allow" ? doc.allow : doc.controls).push(item);
			const first = body.slice(2).trim();
			const c = first.indexOf(":");
			if (c === -1) throw new Error(`${where}: list item without a key: ${first}`);
			item[first.slice(0, c).trim()] = readValue(first.slice(c + 1), where);
			continue;
		}

		if (!item) throw new Error(`${where}: a field before any list item: ${body}`);
		const c = body.indexOf(":");
		if (c === -1) throw new Error(`${where}: field without a colon: ${body}`);
		item[body.slice(0, c).trim()] = readValue(body.slice(c + 1), where);
	}
	return doc;
}

/**
 * @param {string} rest
 * @param {string} where
 * @returns {unknown}
 */
function readValue(rest, where) {
	const t = rest.trim();
	if (t.startsWith("[") || t.startsWith("{")) {
		try {
			return parseFlow(t);
		} catch (err) {
			throw new Error(`${where}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return scalar(t);
}

// ── the scanner ─────────────────────────────────────────────────────────────────────────────────

/**
 * One destructive call site found in the tree.
 * @typedef {{file: string, mutation: string, local?: string, kind: "action"|"authClient"|"fetch"}} Site
 */

/**
 * Find the destructive call sites in one source file.
 *
 * The rule for a server action is deliberately two-part — IMPORTED and CALLED — because either
 * half alone is wrong in a way that matters. Imported-only would count a re-export; called-only
 * would count a local helper that happens to share a destructive name, and this tree has several
 * (`removeNodes` is also a React Flow store method).
 *
 * @param {string} rel repo-relative path, for the finding
 * @param {string} source
 * @returns {{sites: Site[], refused: string|null}}
 */
export function scanSource(rel, source) {
	const { lines, unterminated } = stripCommentLines(source);
	// A block comment still open at EOF means the stripper has blanked live code. Reading the
	// result would under-report, and under-reporting is the direction that passes on the very
	// regression the guard exists to catch — so refuse the file loudly instead.
	if (unterminated) return { sites: [], refused: `${rel}: a block comment is still open at EOF — refusing to census a file this stripper cannot lex` };

	const code = lines.join("\n");
	/** @type {Site[]} */
	const sites = [];

	// ── imported identifiers, from any import in the file.
	//
	// An ALIASED import carries two names and the ledger may reasonably record either: the call
	// site reads `deleteThreadAction(…)` while `destructive-actions.yaml` records the exported
	// `deleteThread`, because "the identifier the click reaches" is the action's own name and the
	// alias is local decoration. Reporting only the local name made three real entries look
	// unaccounted (`deleteThreadAction`, `destroyRunnerAction`, `removeRunnerAction`) — a false
	// finding, which is the failure mode that gets a guard switched off.
	//
	// So a site carries `mutation` (the exported name, what the ledger should say) and `local`
	// (what the file actually calls), and the census accepts a ledger entry matching either.
	/** @type {Map<string, string>} local name → exported name */
	const imported = new Map();
	for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
		for (const piece of m[1].split(",")) {
			const t = piece.trim();
			if (!t) continue;
			const parts = t.split(/\s+as\s+/);
			const exported = parts[0].trim();
			const local = (parts[1] ?? parts[0]).trim();
			if (local) imported.set(local, exported);
		}
	}

	for (const [local, exported] of imported) {
		const destructive =
			DESTRUCTIVE_VERB.test(local) || HIDDEN_VERBS.has(local) || DESTRUCTIVE_VERB.test(exported) || HIDDEN_VERBS.has(exported);
		if (!destructive) continue;
		// Called, not merely imported. `\b` before the name keeps `deleteFoo` from matching
		// `safeDeleteFoo`; the `(` after it is what makes it a call.
		const called = new RegExp(`\\b${local}\\s*\\(`).test(code);
		if (called) sites.push({ file: rel, mutation: exported, local, kind: "action" });
	}

	// ── the auth client. Enumerated rather than verb-matched: they are not our names.
	for (const m of code.matchAll(/authClient\.organization\.([A-Za-z]+)\s*\(/g)) {
		if (AUTH_CLIENT_DESTRUCTIVE.has(m[1])) {
			sites.push({ file: rel, mutation: `authClient.organization.${m[1]}`, kind: "authClient" });
		}
	}

	// ── a bare fetch with a destructive verb. There is no identifier to grep, so the PATH is the
	// key and the method is read from the same call.
	for (const m of code.matchAll(/fetch\(\s*["'`]([^"'`$]+)["'`]\s*,\s*\{[^}]*method:\s*["'](DELETE|PUT|POST)["']/g)) {
		if (m[2] === "DELETE") sites.push({ file: rel, mutation: `${m[1]} DELETE`, kind: "fetch" });
	}

	return { sites, refused: null };
}

/**
 * Walk the scan roots.
 *
 * @param {{listDir: (dir: string) => string[], isDir: (p: string) => boolean, read: (p: string) => string}} io
 * @param {string[]} roots
 * @returns {{sites: Site[], refusals: string[], files: number}}
 */
export function collectSites(io, roots = SCAN_ROOTS) {
	/** @type {Site[]} */
	const sites = [];
	/** @type {string[]} */
	const refusals = [];
	let files = 0;

	/** @param {string} dir */
	const walk = (dir) => {
		for (const entry of io.listDir(dir)) {
			const full = path.posix.join(dir, entry);
			if (io.isDir(full)) {
				if (entry === "node_modules" || entry === ".next") continue;
				if (SCAN_EXCLUDE.includes(full)) continue;
				walk(full);
				continue;
			}
			if (!SCAN_EXT.has(path.extname(entry))) continue;
			// The suites are not the product. A spec naming `deleteProject` is describing a
			// control, not shipping one.
			if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
			files++;
			const { sites: found, refused } = scanSource(full, io.read(full));
			if (refused) refusals.push(refused);
			sites.push(...found);
		}
	};
	for (const root of roots) walk(root);
	return { sites, refusals, files };
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────

/**
 * The census. Pure over its inputs so the self-test drives it with fixtures rather than the tree.
 *
 * @param {{registry: ReturnType<typeof parseRegistry>, sites: Site[], refusals?: string[], floor?: number, read?: (p: string) => string|null}} args
 * @returns {string[]} problems; empty is a pass
 */
export function census({ registry, sites, refusals = [], floor = SITE_FLOOR, read }) {
	/** @type {string[]} */
	const problems = [...refusals];

	// ── the ledger's own shape. A malformed entry makes every rule below read the wrong thing.
	/** @type {Map<string, Record<string, any>>} */
	const byId = new Map();
	for (const c of registry.controls) {
		const id = String(c.id ?? "");
		if (!id) problems.push("a control with no `id` — the census and the spec both key on it");
		if (byId.has(id)) problems.push(`${id}: a duplicate entry — two rows for one control means one of them can never be reached`);
		byId.set(id, c);

		const status = String(c.status ?? "");
		if (!STATUSES.has(status)) problems.push(`${id}: status "${status}" is not one of ${[...STATUSES].join(" | ")}`);
		if ((status === "missing" || status === "inert") && !String(c.issue ?? "").trim()) {
			problems.push(`${id}: status "${status}" is a DEFECT recorded, and the field contract requires an \`issue\` naming the lane that flips it`);
		}
		if (!String(c.surface ?? "").trim()) problems.push(`${id}: no \`surface\` — the spec has nowhere to look for the control`);

		const mutation = String(c.mutation ?? "");
		if (!mutation.trim()) {
			// An `inert` control genuinely HAS no mutation — that emptiness IS the recorded
			// finding, and `issue` (checked above) is what carries it. For every other status an
			// empty mutation is a to-do wearing an exemption's clothes, which is what the field
			// contract refuses.
			if (status !== "inert") {
				problems.push(
					`${id}: \`mutation\` is empty on a "${status}" control. The field contract calls that a to-do, not an exemption — ` +
						"pin the identifier the click reaches by reading `surface`. (An empty mutation is legitimate ONLY on an `inert` control, where nothing is reached at all.)",
				);
			}
		}
	}

	// ── direction 2: LEDGER → TREE. The silent one.
	if (read) {
		for (const c of registry.controls) {
			const id = String(c.id ?? "");
			const mutation = String(c.mutation ?? "");
			if (!mutation.trim()) continue; // already ruled on above
			const holder = String(c.mutation_surface ?? c.surface ?? "");
			if (!holder) continue; // already reported
			const source = read(holder);
			if (source === null) {
				problems.push(`${id}: \`${c.mutation_surface ? "mutation_surface" : "surface"}\` names ${holder}, which does not exist`);
				continue;
			}
			if (!mutationOccursIn(mutation, source)) {
				problems.push(
					`${id}: \`${mutation}\` does not occur in ${holder}. Either the control moved and the entry outlived it — ` +
						"which silently suppresses a real finding — or the mutation is reached from elsewhere and the entry needs a `mutation_surface`.",
				);
			} else if (definedLocallyIn(mutation, source)) {
				// The occurrence check alone accepts a LOCAL function of the same name, and that is
				// not a hypothetical: `billing.card.remove` recorded `removeBackup`, which is a
				// local handler in `payment-methods-card.tsx` that merely OPENS the confirm. The
				// entry read as accounted for while the mutation the click actually reaches
				// (`detachPaymentMethod`) was recorded nowhere. An occurrence is not an invocation.
				problems.push(
					`${id}: \`${mutation}\` is DEFINED in ${holder} rather than imported into it, so it is a local handler, not the mutation the click reaches. ` +
						"Record the server action / authClient method / fetch path it calls; a local name satisfies the occurrence check while measuring nothing.",
				);
			}
		}
	}

	// ── direction 1: TREE → LEDGER.
	/** @type {Map<string, Set<string>>} mutation → files the ledger accounts for */
	const ledgerSites = new Map();
	for (const c of registry.controls) {
		const mutation = String(c.mutation ?? "");
		if (!mutation.trim()) continue;
		const holder = String(c.mutation_surface ?? c.surface ?? "");
		if (!ledgerSites.has(mutation)) ledgerSites.set(mutation, new Set());
		ledgerSites.get(mutation)?.add(holder);
	}
	/** @type {Map<string, Set<string>>} */
	const allowed = new Map();
	for (const a of registry.allow) {
		const mutation = String(a.mutation ?? "");
		const surface = String(a.surface ?? "");
		const reason = String(a.reason ?? "").trim();
		if (!mutation || !surface) {
			problems.push("an `allow:` entry needs both a `mutation` and a `surface` — an exemption that names neither exempts everything");
			continue;
		}
		if (!reason) {
			problems.push(`allow ${mutation} @ ${surface}: an empty \`reason\` is refused. An exemption whose argument is missing reads to the next person as one already made.`);
		}
		if (!allowed.has(mutation)) allowed.set(mutation, new Set());
		allowed.get(mutation)?.add(surface);
	}

	for (const site of sites) {
		// Either name may be what the ledger recorded — see the aliased-import note in scanSource.
		const names = site.local && site.local !== site.mutation ? [site.mutation, site.local] : [site.mutation];
		const known = names.map((n) => ledgerSites.get(n)).find((s) => s !== undefined);
		if (names.some((n) => ledgerSites.get(n)?.has(site.file))) continue;
		if (names.some((n) => allowed.get(n)?.has(site.file))) continue;
		// A mutation the ledger knows, in a file it does not: the control was copied to a second
		// surface and only one of them is accounted for.
		if (known && known.size > 0) {
			problems.push(
				`${site.file}: calls \`${site.mutation}\`, which the registry records only at ${[...known].join(", ")}. ` +
					"A second call site is a second control — give it its own entry, or an `allow:` exemption with a reason.",
			);
			continue;
		}
		problems.push(
			`${site.file}: calls \`${site.mutation}\` and no registry entry accounts for it. ` +
				"Add one to apps/console/destructive-actions.yaml (with its confirmation, or `status: missing` and the issue that adds one).",
		);
	}

	// ── the floor. Last, so a real finding is never hidden behind it.
	if (sites.length < floor) {
		problems.push(
			`the census found ${sites.length} destructive call site(s), below the floor of ${floor}. ` +
				"Every rule above is of the form \"for each site found\", so a scan that matches nothing passes them all. " +
				"Find out what stopped matching — the scan roots, the import shape, or the verb table — rather than lowering the floor.",
		);
	}

	return problems;
}

/**
 * Does `mutation` really occur in this source? Two shapes, because the registry carries two.
 *
 * @param {string} mutation
 * @param {string} source
 * @returns {boolean}
 */
export function mutationOccursIn(mutation, source) {
	const { lines, unterminated } = stripCommentLines(source);
	// Refusing here would be a silent pass; the caller's file-level refusal already covers a
	// truly unlexable file, and a ledger check reading a commented-out call is the safer error.
	const code = unterminated ? source : lines.join("\n");

	// The bare-fetch shape: `<path> <VERB>`. Match the PATH; the verb is documentation, because
	// there is no identifier to anchor on and the path is what a reader can chase.
	const fetchShape = mutation.match(/^(\S+)\s+(DELETE|PUT|POST)$/);
	if (fetchShape) return code.includes(fetchShape[1]);

	// A dotted path matches whole, or by its last segment — `authClient.organization.delete` is
	// also reached as `organization.delete` off a destructured client.
	if (mutation.includes(".")) {
		if (code.includes(mutation)) return true;
		const last = mutation.split(".").pop() ?? "";
		return new RegExp(`\\.${last}\\s*\\(`).test(code);
	}

	return new RegExp(`\\b${mutation}\\b`).test(code);
}

/**
 * Is `name` a function DEFINED in this source rather than imported into it? A dotted path or a
 * fetch shape can never be, so those are exempt.
 *
 * @param {string} name
 * @param {string} source
 * @returns {boolean}
 */
export function definedLocallyIn(name, source) {
	if (name.includes(".") || /\s+(DELETE|PUT|POST)$/.test(name)) return false;
	const { lines, unterminated } = stripCommentLines(source);
	const code = unterminated ? source : lines.join("\n");
	// Imported wins: a file may legitimately import `deleteFoo` and also shadow nothing.
	if (new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(code)) return false;

	// A local DEFINITION is a function body authored here. A `const x = useStore(s => s.x)` is a
	// BINDING to something defined elsewhere, and the field contract explicitly admits a store
	// action as a mutation — `canvas.delete-resource` records `removeNodes`, bound exactly that way
	// in `collection-panel.tsx`, and it is correct. Matching every `const x =` flagged it, so the
	// two forms are separated rather than the rule being dropped: narrowing is the dangerous
	// direction here, and both halves are pinned by fixtures below.
	const declared = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).test(code);
	const arrowOrFn = new RegExp(
		`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>|(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s+)?function\\b`,
	).test(code);
	return declared || arrowOrFn;
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────

/**
 * Fixtures are STRINGS in this file, never files on disk — the same rule the sibling guards keep.
 * A fixture on disk is a file the tree's own guards then have to exempt, and an exemption is the
 * thing this script exists to make expensive.
 *
 * Every case is a MUTATION of a passing baseline: the assertion is that the guard's verdict FLIPS,
 * which is what proves the rule is load-bearing rather than merely present.
 */
function selfTest() {
	/** @type {{name: string, ok: boolean, detail?: string}[]} */
	const results = [];
	/** @param {string} name @param {boolean} ok @param {string} [detail] */
	const check = (name, ok, detail) => results.push({ name, ok, detail });

	const baseYaml = [
		"version: 1",
		"",
		"allow:",
		"  - mutation: discardChanges",
		"    surface: apps/console/lib/stores/use-canvas-store.ts",
		"    reason: the client half; the server half is the registered mutation",
		"",
		"controls:",
		"  - id: project.delete",
		"    route: /[org]/[project]/settings/general",
		"    surface: apps/console/components/settings/project-general.tsx",
		"    mutation: deleteProject",
		'    control: { role: button, name: "Delete" }',
		'    reach: [{ section: "Delete project" }]',
		"    confirm: alert-dialog",
		"    status: confirmed",
		"    prod-qa: own-rows-only",
	].join("\n");

	const baseSource = [
		'import { deleteProject } from "@/app/server/actions/projects";',
		"export function ProjectGeneral() {",
		"  return <button onClick={() => deleteProject(id)}>Delete</button>;",
		"}",
	].join("\n");

	const surfaceFile = "apps/console/components/settings/project-general.tsx";
	/** @param {string} src */
	const readerFor = (src) => (/** @type {string} */ p) => (p === surfaceFile ? src : null);

	// ── the reader
	try {
		const doc = parseRegistry(baseYaml);
		check("the reader returns the controls and the allow block", doc.controls.length === 1 && doc.allow.length === 1);
		check("a flow map is parsed into fields", doc.controls[0].control?.name === "Delete");
		check("a flow sequence of flow maps is parsed", Array.isArray(doc.controls[0].reach) && doc.controls[0].reach[0]?.section === "Delete project");
	} catch (err) {
		check("the reader parses the baseline", false, String(err));
	}

	check(
		"an unknown top-level key RAISES rather than being skipped",
		(() => {
			try {
				parseRegistry("version: 1\nsurprise:\n  - id: x\n");
				return false;
			} catch {
				return true;
			}
		})(),
	);
	check(
		"an unterminated flow map RAISES rather than yielding a partial control",
		(() => {
			try {
				parseRegistry(`${baseYaml}\n    fixture: { a: b\n`);
				return false;
			} catch {
				return true;
			}
		})(),
	);
	check(
		'a `#` inside a quoted scalar is NOT read as a comment',
		parseRegistry('version: 1\ncontrols:\n  - id: a\n    dialog_title: "Delete #1?"\n').controls[0].dialog_title === "Delete #1?",
	);

	// ── the baseline passes
	const registry = parseRegistry(baseYaml);
	const { sites } = scanSource(surfaceFile, baseSource);
	check("the baseline finds the call site", sites.length === 1 && sites[0].mutation === "deleteProject");
	const basePass = census({ registry, sites, floor: 1, read: readerFor(baseSource) });
	check("the baseline is clean", basePass.length === 0, basePass.join(" · "));

	// ── direction 1: an unlisted destructive call site FAILS
	const strayFile = "apps/console/components/settings/danger.tsx";
	const { sites: stray } = scanSource(
		strayFile,
		'import { deleteFoo } from "@/app/server/actions/foo";\nexport const X = () => deleteFoo(1);',
	);
	check("an unlisted `deleteFoo(` is found", stray.length === 1);
	check(
		"…and it FAILS the census",
		census({ registry, sites: [...sites, ...stray], floor: 1, read: readerFor(baseSource) }).some((p) => p.includes("no registry entry accounts for it")),
	);

	// ── direction 1: imported-but-not-called is NOT a site
	check(
		"an imported-but-never-called destructive action is not a call site",
		scanSource(strayFile, 'import { deleteFoo } from "@/app/server/actions/foo";\nexport const X = 1;').sites.length === 0,
	);
	// ── direction 1: called-but-not-imported is NOT a site
	check(
		"a local helper sharing a destructive name is not a call site",
		scanSource(strayFile, "function removeNodes(a) { return a; }\nremoveNodes([]);").sites.length === 0,
	);

	// ── direction 2: an entry whose surface lacks the call FAILS
	check(
		"an entry whose surface no longer contains its mutation FAILS",
		census({ registry, sites, floor: 1, read: readerFor("export const ProjectGeneral = () => null;") }).some((p) => p.includes("does not occur in")),
	);
	check(
		"…and a commented-out call does not rescue it",
		census({ registry, sites, floor: 1, read: readerFor("// deleteProject(id)\nexport const X = () => null;") }).some((p) => p.includes("does not occur in")),
	);

	// ── the floor
	check(
		"zero sites FAILS rather than passing vacuously",
		census({ registry, sites: [], floor: 1, read: readerFor(baseSource) }).some((p) => p.includes("below the floor")),
	);
	check(
		"a census below the floor FAILS even with no other finding",
		census({ registry, sites, floor: 99, read: readerFor(baseSource) }).some((p) => p.includes("below the floor")),
	);

	// ── the ledger's own shape
	/** @param {string} yaml */
	const shapeProblems = (yaml) => census({ registry: parseRegistry(yaml), sites: [], floor: 0, read: () => null });
	check(
		"an empty `mutation` on a non-inert control FAILS",
		shapeProblems("version: 1\ncontrols:\n  - id: a\n    surface: s.tsx\n    mutation: \"\"\n    status: missing\n    issue: \"#1\"\n").some((p) => p.includes("to-do, not an exemption")),
	);
	check(
		"…but an empty `mutation` on an INERT control is legitimate",
		!shapeProblems("version: 1\ncontrols:\n  - id: a\n    surface: s.tsx\n    mutation: \"\"\n    status: inert\n    issue: \"#4273\"\n").some((p) => p.includes("to-do, not an exemption")),
	);
	check(
		"an inert control with no `issue` FAILS",
		shapeProblems("version: 1\ncontrols:\n  - id: a\n    surface: s.tsx\n    mutation: \"\"\n    status: inert\n").some((p) => p.includes("requires an `issue`")),
	);
	check(
		"an unknown status FAILS",
		shapeProblems("version: 1\ncontrols:\n  - id: a\n    surface: s.tsx\n    mutation: x\n    status: probably-fine\n").some((p) => p.includes("is not one of")),
	);
	check(
		"a duplicate id FAILS",
		shapeProblems("version: 1\ncontrols:\n  - id: a\n    surface: s.tsx\n    mutation: x\n    status: confirmed\n  - id: a\n    surface: t.tsx\n    mutation: y\n    status: confirmed\n").some((p) => p.includes("duplicate entry")),
	);
	check(
		"an `allow:` entry with an empty reason FAILS",
		shapeProblems("version: 1\nallow:\n  - mutation: x\n    surface: s.ts\n    reason: \"\"\ncontrols:\n  - id: a\n    surface: s.tsx\n    mutation: x\n    status: confirmed\n").some((p) => p.includes("empty `reason` is refused")),
	);

	// ── the hidden-verb table is wired into the scanner, not merely declared
	check(
		"a HIDDEN verb is found even though it does not match DESTRUCTIVE_VERB",
		(() => {
			const name = "setMemberSuspended";
			if (DESTRUCTIVE_VERB.test(name)) return false; // the premise of the table
			return scanSource("apps/console/components/x.tsx", `import { ${name} } from "@/app/server/actions/members";\nexport const X = () => ${name}(1);`).sites.length === 1;
		})(),
	);
	check(
		"every HIDDEN_VERBS entry carries a reason",
		[...HIDDEN_VERBS.values()].every((r) => r.trim().length > 0),
	);

	// ── an occurrence is not an invocation. The regression fixture is the real one: `removeBackup`
	// is a local handler that opens a confirm, and recording it satisfied the occurrence check
	// while the mutation the click reaches went unrecorded.
	{
		const localHandler = [
			'import { detachPaymentMethod } from "@/app/server/actions/billing";',
			"function removeBackup(card) { setConfirmRemove(card); }",
			"const onConfirm = () => detachPaymentMethod(card.id);",
		].join("\n");
		check("a LOCAL function of the mutation's name is not the mutation", definedLocallyIn("removeBackup", localHandler));
		check("…and an IMPORTED action of the same name is not flagged", !definedLocallyIn("detachPaymentMethod", localHandler));
		check(
			"…so an entry recording the local handler FAILS the census",
			census({
				registry: parseRegistry("version: 1\ncontrols:\n  - id: billing.card.remove\n    surface: c.tsx\n    mutation: removeBackup\n    status: confirmed\n"),
				sites: [],
				floor: 0,
				read: () => localHandler,
			}).some((p) => p.includes("is a local handler")),
		);
		check(
			"…while the corrected entry passes",
			!census({
				registry: parseRegistry("version: 1\ncontrols:\n  - id: billing.card.remove\n    surface: c.tsx\n    mutation: detachPaymentMethod\n    status: confirmed\n"),
				sites: [],
				floor: 0,
				read: () => localHandler,
			}).some((p) => p.includes("local handler")),
		);
		check("a dotted authClient path is never read as a local definition", !definedLocallyIn("authClient.organization.delete", "const authClient = x;"));
		// The narrowing, pinned in BOTH directions. A store binding is not a local definition — the
		// field contract admits a store action as a mutation, and `canvas.delete-resource` records
		// one. But an arrow-function handler of the same shape still IS one, or the narrowing would
		// have quietly reopened the hole it was cut from.
		check(
			"a store selector binding is NOT a local definition",
			!definedLocallyIn("removeNodes", "const removeNodes = useCanvasStore((s) => s.removeNodes);"),
		);
		check(
			"…and neither is a plain call binding",
			!definedLocallyIn("cancelJob", "const cancelJob = useJobsQuery().cancelJob;"),
		);
		check(
			"…but an arrow-function handler still IS one",
			definedLocallyIn("removeThing", "const removeThing = (id) => { setConfirm(id); };"),
		);
		check(
			"…including an async arrow handler",
			definedLocallyIn("removeThing", "const removeThing = async (id) => { setConfirm(id); };"),
		);
		check(
			"…and a bare `async function` declaration",
			definedLocallyIn("bulkRemove", "async function bulkRemove() { await authClient.organization.removeMember({}); }"),
		);
	}

	// ── the exclusions. Exclusion is the direction that passes on a real regression, so each is
	// pinned BOTH ways: the excluded tree is skipped, and an identical file one directory over is
	// still found. A one-sided test here would go green on an exclusion that had swallowed the
	// console.
	{
		const call = 'import { deleteFoo } from "@/app/server/actions/foo";\nexport const X = () => deleteFoo(1);';
		/** @param {string[]} files */
		const io = (files) => ({
			listDir: (/** @type {string} */ d) => {
				const kids = new Set();
				for (const f of files) {
					if (!f.startsWith(`${d}/`)) continue;
					kids.add(f.slice(d.length + 1).split("/")[0]);
				}
				return [...kids];
			},
			isDir: (/** @type {string} */ p) => files.some((f) => f.startsWith(`${p}/`)),
			read: () => call,
		});
		const inApi = collectSites(io(["apps/console/app/api/cli/route.ts"]), ["apps/console/app"]);
		check("a destructive call in app/api is NOT a control (no click, no dialog)", inApi.sites.length === 0);
		const inServer = collectSites(io(["apps/console/app/server/actions/foo.ts"]), ["apps/console/app"]);
		check("a destructive call in app/server is NOT a control (it is the definition)", inServer.sites.length === 0);
		const inPage = collectSites(io(["apps/console/app/(private)/x/page.tsx"]), ["apps/console/app"]);
		check("…but the SAME call in a routed page IS still found — the exclusion is two directories, not the tree", inPage.sites.length === 1);
		const inLib = collectSites(io(["apps/console/lib/query/use-x-query.ts"]), ["apps/console/lib"]);
		check("…and a store or query hook IS scanned, which is where presentational controls delegate", inLib.sites.length === 1);
	}

	// ── a file the stripper cannot lex is REFUSED, not read short
	check(
		"an unterminated block comment refuses the file rather than under-reporting",
		scanSource("apps/console/components/x.tsx", "/* open\nimport { deleteFoo } from \"a\";\ndeleteFoo();").refused !== null,
	);

	// ── the auth client
	check(
		"an enumerated authClient method is a site",
		scanSource("apps/console/components/x.tsx", "authClient.organization.removeMember({});").sites[0]?.mutation === "authClient.organization.removeMember",
	);
	check(
		"a NON-destructive authClient method is not",
		scanSource("apps/console/components/x.tsx", "authClient.organization.list({});").sites.length === 0,
	);
	check(
		"a dotted mutation is matched by its last segment too",
		mutationOccursIn("authClient.organization.delete", "const { organization } = client;\norganization.delete();"),
	);

	// ── the bare-fetch shape
	check(
		"a bare DELETE fetch is a site keyed on its path",
		scanSource("apps/console/components/x.tsx", 'fetch("/api/org/logo", { method: "DELETE" });').sites[0]?.mutation === "/api/org/logo DELETE",
	);
	check("…and the ledger matches it on the path", mutationOccursIn("/api/org/logo DELETE", 'fetch("/api/org/logo", { method: "DELETE" })'));

	const failed = results.filter((r) => !r.ok);
	for (const r of results) {
		if (r.ok) console.log(`ok   - ${r.name}`);
		else console.error(`FAIL - ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	}
	console.log(`\n  ${results.length - failed.length} passed, ${failed.length} failed`);
	return failed.length === 0;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

/** @param {string} p @returns {string|null} */
function readRepo(p) {
	try {
		return readFileSync(path.join(REPO, p), "utf8");
	} catch {
		return null;
	}
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help") || argv.includes("-h")) {
		console.log("node scripts/check-destructive-actions.mjs [--self-test] [--json]");
		return 0;
	}
	if (argv.includes("--self-test")) return selfTest() ? 0 : 1;

	const source = readRepo(REGISTRY_PATH);
	if (source === null) {
		console.error(`::error::${REGISTRY_PATH} is missing — the registry is the census's denominator, and its absence is a failure, not an empty run.`);
		return 2;
	}
	/** @type {ReturnType<typeof parseRegistry>} */
	let registry;
	try {
		registry = parseRegistry(source);
	} catch (err) {
		console.error(`::error::${REGISTRY_PATH} could not be read: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}

	const io = {
		listDir: (/** @type {string} */ d) => {
			try {
				return readdirSync(path.join(REPO, d));
			} catch {
				return [];
			}
		},
		isDir: (/** @type {string} */ p) => {
			try {
				return statSync(path.join(REPO, p)).isDirectory();
			} catch {
				return false;
			}
		},
		read: (/** @type {string} */ p) => readRepo(p) ?? "",
	};

	// A scan root that resolves to nothing is a moved tree, not an empty one.
	for (const root of SCAN_ROOTS) {
		if (!io.isDir(root)) {
			console.error(`::error::scan root ${root} is not a directory — the console tree moved and this census is measuring nothing.`);
			return 2;
		}
	}

	// The registry, through THIS reader, for the live spec. `e2e/audit/manifest.ts` reads
	// `console-routes.mjs` the same way — a subprocess rather than an import — because a spec and a
	// repo script do not share a module system, and a second reader of one list is the disagreement
	// the registry exists to prevent, one level down.
	if (argv.includes("--registry-json")) {
		console.log(JSON.stringify(registry, null, 2));
		return 0;
	}

	const { sites, refusals, files } = collectSites(io);
	if (argv.includes("--json")) {
		console.log(JSON.stringify({ files, sites, controls: registry.controls.length, allow: registry.allow.length }, null, 2));
		return 0;
	}

	const problems = census({ registry, sites, refusals, read: readRepo });
	const statuses = registry.controls.reduce((acc, c) => {
		const s = String(c.status ?? "?");
		acc[s] = (acc[s] ?? 0) + 1;
		return acc;
	}, /** @type {Record<string, number>} */ ({}));

	if (problems.length) {
		for (const p of problems) console.error(`::error::check-destructive-actions: ${p}`);
		console.error(
			`\n✗ check-destructive-actions: ${problems.length} finding(s) over ${sites.length} call site(s) in ${files} file(s) ` +
				`against ${registry.controls.length} registry entries.`,
		);
		return 1;
	}

	console.log(
		`✓ check-destructive-actions: ${sites.length} destructive call site(s) across ${files} scanned file(s), ` +
			`every one accounted for by ${REGISTRY_PATH} — ${registry.controls.length} entries (` +
			`${Object.entries(statuses).map(([k, v]) => `${v} ${k}`).join(", ")}), ${registry.allow.length} allowed with reasons. ` +
			`Floor ${SITE_FLOOR}.`,
	);
	return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	process.exit(main());
}
