#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THREE LISTS OF REQUIRED CHECKS HAVE TO AGREE, AND NOTHING COMPARED THEM (#3180).
//
//   infra/github/variables.tf   `required_status_checks`, filtered per ruleset in main.tf
//   .mergify.yml                the dev queue's `merge_conditions` AND `merge_protections`
//   the live rulesets           GitHub state, not in the tree
//
// Measured 2026-08-28: the live `protect-dev` ruleset was last updated 2026-07-29 and carries 9
// contexts; the HCL names 11 for dev. So the repository had been carrying written-down requirements
// that nothing enforced, for a month. That is the SECOND occurrence — .mergify.yml's own header
// records the first ("the enforcement lived only in unapplied infra/github HCL"). A defect class
// that recurs after being written down in a comment needs a check, not a better comment.
//
// ── THE DIRECTIONS ARE NOT SYMMETRIC, and that is the whole design ────────────────────────────────
//
// It is tempting to say "the two lists must be equal". They must not be, and treating them as a set
// comparison hides the only direction that can actually hurt anyone.
//
//   HCL ∖ MERGIFY — a check the dev ruleset requires and Mergify does not wait for. Mergify queues
//   the PR, decides it is mergeable, and GitHub REFUSES the merge because the ruleset is unsatisfied
//   (protect-dev has no bypass actors — verified against the live ruleset, `bypass_actors: []`). The
//   result is a stuck queue entry with no visible cause: nothing is red, and nothing merges. This is
//   the direction .mergify.yml's own note warns about, and it is NEVER legitimate. Undeclarable.
//
//   MERGIFY ∖ HCL — a check Mergify waits for that the ruleset does not yet require. This is the
//   repo's DOCUMENTED ordering ("listed here BEFORE it is required in branch protection,
//   deliberately"), and it is safe: Mergify simply holds the PR until the check is green. It is
//   allowed, but it must be DECLARED with a reason, because the state is meant to be temporary and
//   an undeclared one is indistinguishable from a forgotten one.
//
// So this is not a lint about tidiness. One direction is a production hazard, the other is a
// deliberate migration step, and the check exists to keep them apart.
//
// ── WHAT IT REFUSES TO GUESS ──────────────────────────────────────────────────────────────────────
//
// Every parse has a shape it recognises and fails on anything else. A guard that cannot find what it
// is looking for must not report "nothing wrong" — that is the same green-on-blindness defect this
// repo has now shipped several fixes for. Concretely: an unparseable dev filter, a ruleset wired to
// an expression this script does not model, an empty context list, or a Mergify block that yields no
// checks are all HARD ERRORS, not quiet passes.
//
// ── THE LIVE HALF ─────────────────────────────────────────────────────────────────────────────────
//
// `--live` is the half that would have caught THIS instance, and it can only ever be a report: the
// fix is a `tofu apply`, which is the maintainer's. It runs from workflow-health.yml — the workflow
// whose entire premise is asking GitHub a question nobody is asking and putting the answer where a
// human reads — and drift becomes a title-deduped issue rather than a log line, because "a report
// nobody reads" is exactly how the first occurrence survived.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const VARIABLES = "infra/github/variables.tf";
const MAIN = "infra/github/main.tf";
const MERGIFY = ".mergify.yml";
const DIVERGENCE = "infra/github/required-checks-divergence.json";

/** The ruleset Mergify's dev queue is the counterpart of. The other two have no queue. */
const DEV_RULESET = "protect-dev";

// WHICH BRANCHES, AND WHY NOT `/rulesets`.
//
// The first version of this read `GET /repos/{o}/{r}/rulesets`, which needs Administration:read —
// a scope `GITHUB_TOKEN` cannot be granted at all. It also tried to ask for it via a
// `permissions: administration: read` key that does not exist, and an unknown key makes Actions
// REJECT the whole file at load time: zero jobs, a run named after the file path rather than the
// workflow, and dev red on 16034c6d.
//
// `GET /repos/{o}/{r}/rules/branches/{branch}` answers the same question — the required contexts
// actually in force — and is readable with plain repo read. It is also strictly better here: it
// returns the EFFECTIVE rules for one branch, so an unrelated repo ruleset can no longer be
// compared against this list, and a ruleset that is disabled or in `evaluate` mode simply does
// not appear rather than rendering as agreement.
const RULESET_BRANCHES = [
	["dev", "protect-dev"],
	["staging", "protect-staging"],
	["main", "protect-main"],
];

/**
 * Strip HCL comments without eating a `#` that sits inside a string literal.
 *
 * Written as a character scan rather than a regex because the lists this reads are surrounded by
 * long prose comments that themselves quote check names — a line-anchored regex over the raw text
 * would harvest context names out of the commentary and report a list nobody wrote.
 */
export function stripHclComments(text) {
	const out = [];
	for (const line of text.split("\n")) {
		let inStr = false;
		let cut = line.length;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
			if (inStr) continue;
			if (c === "#" || (c === "/" && line[i + 1] === "/")) {
				cut = i;
				break;
			}
		}
		out.push(line.slice(0, cut));
	}
	return out.join("\n");
}

/** The `required_status_checks` variable's default list, in declaration order. */
export function parseRequiredStatusChecks(varsText) {
	const src = stripHclComments(varsText);
	const at = src.indexOf('variable "required_status_checks"');
	if (at < 0) throw new Error(`${VARIABLES}: no \`variable "required_status_checks"\` block — this script's model of the required-check source is wrong, or the variable was renamed.`);
	const defaultAt = src.indexOf("default", at);
	const open = src.indexOf("[", defaultAt);
	const close = src.indexOf("]", open);
	if (defaultAt < 0 || open < 0 || close < 0) throw new Error(`${VARIABLES}: \`required_status_checks\` has no \`default = [ ... ]\` list this script can read.`);
	const contexts = [...src.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	if (contexts.length === 0) throw new Error(`${VARIABLES}: \`required_status_checks\` parsed to ZERO contexts. An empty list is never right, and reporting agreement from it would be agreement about nothing.`);
	return contexts;
}

/**
 * The contexts main.tf removes from the dev ruleset, read from the `dev_required_status_checks`
 * local rather than assumed.
 *
 * #3180's own issue body got this wrong — it counted the HCL as 12 against Mergify's 10 and asked
 * for a decision on `branch-flow-guard`, which main.tf has excluded from dev since the local was
 * written. Modelling the filter is what makes the comparison true rather than plausible.
 */
export function parseDevFilter(mainText) {
	return parseFilter(mainText, DEV_LOCAL);
}

/** The locals main.tf derives a ruleset's list from. Named once so the parser and the wiring check agree. */
export const DEV_LOCAL = "dev_required_status_checks";
export const STAGING_LOCAL = "staging_required_status_checks";
const STAGING_RULESET = "protect-staging";

/**
 * The contexts a `<local> = [for c in var.required_status_checks : c if …]` filter removes.
 *
 * Generalised from the dev-only parser when the release gate arrived (#4265): staging now carries
 * its own filtered local — the gate runs on staging PRs but is required only on main — and a
 * parser that modelled dev alone would have compared staging against a list its ruleset does not
 * use. Same grammar for both: only a conjunction of plain inequalities is modelled, and anything
 * richer is an error rather than a guess about which contexts survive.
 *
 * @param {string} mainText
 * @param {string} localName
 * @returns {string[]} the excluded contexts
 */
export function parseFilter(mainText, localName) {
	const src = stripHclComments(mainText);
	const re = new RegExp(`${localName}\\s*=\\s*\\[for\\s+(\\w+)\\s+in\\s+var\\.required_status_checks\\s*:\\s*\\1\\s+if\\s+([^\\]]+)\\]`);
	const m = re.exec(src);
	if (!m) throw new Error(`${MAIN}: no \`${localName} = [for c in var.required_status_checks : c if …]\` local. That ruleset's effective list cannot be derived, so this check would be comparing against the wrong set.`);
	const [, , cond] = m;
	const clauses = cond.split("&&").map((s) => s.trim());
	const excluded = [];
	for (const clause of clauses) {
		const c = /^\w+\s*!=\s*"([^"]+)"$/.exec(clause);
		if (!c) throw new Error(`${MAIN}: the ${localName} filter clause \`${clause}\` is not a plain \`c != "context"\`. This script models only a conjunction of inequalities; extend it deliberately rather than letting it guess which contexts survive.`);
		excluded.push(c[1]);
	}
	return excluded;
}

/**
 * The staging filter, or `null` when main.tf declares none — an absent staging local is the
 * pre-#4265 shape (staging iterates the full variable) and is not an error; a PRESENT one that
 * does not parse is.
 */
export function parseStagingFilter(mainText) {
	if (!new RegExp(`\\b${STAGING_LOCAL}\\s*=`).test(stripHclComments(mainText))) return null;
	return parseFilter(mainText, STAGING_LOCAL);
}

/**
 * Each `github_repository_ruleset` block's name and the expression its required_status_checks
 * iterates, so the dev ruleset's wiring is verified rather than assumed.
 */
export function parseRulesetWiring(mainText) {
	const src = stripHclComments(mainText);
	const out = [];
	const re = /resource\s+"github_repository_ruleset"\s+"([^"]+)"\s*\{/g;
	for (let m = re.exec(src); m; m = re.exec(src)) {
		const start = m.index;
		const next = re.lastIndex;
		const nextBlock = src.indexOf('resource "github_repository_ruleset"', next);
		const body = src.slice(start, nextBlock < 0 ? src.length : nextBlock);
		const name = /\bname\s*=\s*"([^"]+)"/.exec(body)?.[1];
		const forEach = /required_status_checks\s*\{[\s\S]*?for_each\s*=\s*([^\n]+)/.exec(body)?.[1]?.trim();
		out.push({ label: m[1], name, forEach });
	}
	if (out.length === 0) throw new Error(`${MAIN}: no \`github_repository_ruleset\` resources found. Nothing here requires any check, which is not a state this repo has ever been in — the parse is wrong.`);
	return out;
}

/**
 * Every Mergify condition block that names at least one status check, keyed by the block that
 * holds it.
 *
 * .mergify.yml carries the SAME list twice — the queue's `merge_conditions` and the merge
 * protection's `success_conditions` — which is a fourth place for the lists to disagree, so they
 * are collected separately and compared to each other rather than merged.
 */
export function parseMergifyCheckBlocks(yamlText) {
	const lines = yamlText.split("\n");
	const blocks = [];
	for (let i = 0; i < lines.length; i++) {
		const key = /^(\s*)([a-z_]+conditions):\s*$/.exec(lines[i]);
		if (!key) continue;
		const indent = key[1].length;
		const contexts = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			if (line.trim() === "" || /^\s*#/.test(line)) continue;
			const lead = line.length - line.trimStart().length;
			if (lead <= indent) break;
			const item = /^\s*-\s*"?check-success=(.*?)"?\s*$/.exec(line);
			if (item) contexts.push(item[1]);
		}
		if (contexts.length > 0) blocks.push({ key: key[2], line: i + 1, contexts });
	}
	return blocks;
}

/**
 * The review-findings gate (#3498). Its PLACEMENT is the whole of its correctness, and neither
 * wrong placement is visible to the check-list comparison below, because it names no check.
 *
 * `#review-threads-unresolved = 0` keeps a PR with unresolved review threads out of the merge
 * queue. In `queue_conditions` / `auto_merge_conditions` it is evaluated against the REAL pull
 * request and is continuously re-enforced, so a PR whose review lands after it queued is EVICTED.
 * In `merge_conditions` / `success_conditions` it is evaluated against Mergify's TEMPORARY MERGE —
 * a fresh pull request carrying no review threads — where it reads 0 = 0 and is true forever: a
 * gate that looks installed and gates nothing.
 */
const THREAD_GATE = "#review-threads-unresolved";

/** Every `*conditions:` block with its list items VERBATIM, so non-check conditions are visible. */
export function parseMergifyConditionBlocks(yamlText) {
	const lines = yamlText.split("\n");
	const blocks = [];
	for (let i = 0; i < lines.length; i++) {
		const key = /^(\s*)([a-z_]+conditions):\s*$/.exec(lines[i]);
		if (!key) continue;
		const indent = key[1].length;
		const items = [];
		const commented = [];
		let nested = null;
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j];
			if (line.trim() === "" || /^\s*#/.test(line)) continue;
			const lead = line.length - line.trimStart().length;
			if (lead <= indent) break;
			const item = /^\s*-\s*(.*?)\s*$/.exec(line);
			if (!item) continue;
			// ⚠️ ONLY THE BLOCK'S OWN ITEMS. Flattening on indent alone attributed everything
			// nested under a `- or:` / `- and:` to the enclosing block, so a gate sitting inside
			// `- or: [gate, label=override]` — fully bypassable by anyone who can add a label —
			// read as correctly placed. Depth is tracked so a nested item is never counted as a
			// top-level condition of this block.
			if (/^(or|and|not):\s*$/.test(item[1])) {
				nested = lead;
				continue;
			}
			if (nested !== null && lead > nested) continue;
			nested = null;
			// ⚠️ AN UNQUOTED `- #…` IS A YAML COMMENT, and the list item is therefore null. This
			// parser must agree with YAML about that or it reports the gate PRESENT while Mergify
			// sees a null — a guard whose "nothing found" branch is indistinguishable from
			// "nothing wrong", over the very condition it exists to protect. Kept separately
			// rather than dropped, so the failure can name the cause instead of saying the gate
			// vanished for no reason.
			if (item[1].startsWith("#")) {
				commented.push({ text: item[1], line: j + 1 });
				continue;
			}
			// BOTH quote styles. Stripping only double quotes made a single-quoted
			// `- '#review-threads-unresolved = 0'` invisible twice over: it does not start with
			// `#`, so it is not caught as the YAML-comment footgun, and the leading `'` defeats
			// the startsWith below — so the gate present-but-single-quoted in one block read as
			// absent from both, and the missing-eviction half shipped green.
			items.push(item[1].replace(/^(['"])(.*)\1$/, "$2"));
		}
		blocks.push({ key: key[2], line: i + 1, items, commented });
	}
	return blocks;
}

/**
 * Where the thread gate may and may not appear.
 *
 * It deliberately does NOT assert that the gate is PRESENT. Requiring presence would make the
 * one-line rollback red CI and turn an emergency revert into a two-file change — and a full
 * deletion is a visible, intentional act. A MISPLACEMENT is the mistake that looks correct, so
 * that is what this catches.
 */
export function compareThreadGate(conditionBlocks) {
	const failures = [];
	// The gate is `#review-threads-unresolved = 0` and NOTHING ELSE. Matching the key alone left
	// the operator and the value unchecked, and both directions are silent: `>= 0` can never be
	// false, so the gate is installed and inert — exactly the state the placement rules exist to
	// prevent — while `> 0` inverts it, so nothing WITHOUT unresolved findings can ever queue and
	// the dev queue stops. Neither produced a failure.
	const gateItems = (k) =>
		conditionBlocks.filter((b) => b.key === k).flatMap((b) => b.items.filter((i) => i.startsWith(THREAD_GATE)).map((i) => ({ item: i, line: b.line })));
	const has = (k) => gateItems(k).length > 0;
	for (const k of ["queue_conditions", "auto_merge_conditions", "merge_conditions", "success_conditions"]) {
		for (const { item, line } of gateItems(k)) {
			if (!/^#review-threads-unresolved\s*=\s*0$/.test(item)) {
				failures.push(
					`.mergify.yml:${line}: \`${item}\` in \`${k}\` is not the gate. It must be exactly ` +
						`\`${THREAD_GATE} = 0\`: \`>= 0\` can never be false, so the gate is installed and inert, ` +
						`and \`> 0\` inverts it so nothing without unresolved findings can ever queue and the dev ` +
						`queue stops. Both read as present to a check that only matches the key.`,
				);
			}
		}
	}
	// The two dead placements are dead for DIFFERENT reasons, and one of the two explanations is
	// false about the other. merge_conditions is evaluated on the temporary merge — a synthetic
	// commit with no review threads — so the count really is always 0. success_conditions IS
	// evaluated on the pull request, so the count is real; its defect is only that it does not
	// EVICT. Emitting the temporary-merge rationale for both told a reader something untrue about
	// the config in front of them.
	if (has("merge_conditions")) {
		failures.push(
			`.mergify.yml: \`${THREAD_GATE}\` is in \`merge_conditions\`, where it cannot work. Mergify ` +
				`evaluates that block on the TEMPORARY MERGE, not on the pull request — a fresh commit with no ` +
				`review threads — so the condition reads 0 = 0 and is true forever: installed and inert. And if ` +
				`it is not dead it is worse, because an unsatisfied CONDITION is not a FAILED CHECK: Mergify does ` +
				`not eject the PR, it holds the head of the train pending indefinitely with no checks_timeout to ` +
				`break it. Move it to queue_conditions and auto_merge_conditions.`,
		);
	}
	if (has("success_conditions")) {
		failures.push(
			`.mergify.yml: \`${THREAD_GATE}\` is in \`success_conditions\`. That block IS evaluated on the ` +
				`pull request, so the count is real — but it only decides how the merge protection REPORTS, and it ` +
				`never evicts a PR already in the train. #3444 lost that race by four minutes. ` +
				`Move it to queue_conditions and auto_merge_conditions.`,
		);
	}
	// The quoting footgun, and it is silent in both directions: YAML reads `- #foo` as a comment
	// and the item becomes null, so Mergify either rejects the whole config (nothing merges,
	// repo-wide) or accepts a shorter list with the gate absent and nothing saying so.
	for (const b of conditionBlocks) {
		for (const c of b.commented ?? []) {
			if (c.text.startsWith(THREAD_GATE)) {
				failures.push(
					`.mergify.yml:${c.line}: \`- ${c.text}\` in \`${b.key}\` is UNQUOTED, so YAML reads it as a ` +
						`comment and the list item is null — the gate is absent and nothing else says so. ` +
						`Quote it: \`- "${c.text}"\`.`,
				);
			}
		}
	}
	const inQueue = has("queue_conditions");
	const inAuto = has("auto_merge_conditions");
	if (inQueue !== inAuto) {
		const present = inQueue ? "queue_conditions" : "auto_merge_conditions";
		const missing = inQueue ? "auto_merge_conditions" : "queue_conditions";
		failures.push(
			`.mergify.yml: \`${THREAD_GATE}\` is in \`${present}\` but not \`${missing}\`. The two halves do ` +
				`different jobs and one alone is not half a gate: auto_merge_conditions decides whether to ENQUEUE, ` +
				`queue_conditions is the only one that EVICTS a PR whose findings arrive after it was already queued ` +
				`(#3444 lost that race by four minutes). Put it in both, or in neither.`,
		);
	}
	return failures;
}

/** The in-tree comparison. Returns `{failures, notes}` — nothing here reaches the network. */
export function compare({ hclAll, devExcluded, wiring, mergifyBlocks, divergence, stagingExcluded = null }) {
	const failures = [];
	const notes = [];

	const dup = (list, where) => {
		const seen = new Set();
		for (const c of list) {
			if (seen.has(c)) failures.push(`${where}: \`${c}\` is listed twice. A duplicate is dead weight at best and, in a list somebody is about to edit, a rename that only lands on one of the copies.`);
			seen.add(c);
		}
	};
	dup(hclAll, VARIABLES);

	// The dev ruleset must actually be wired to the filtered local, or "dev's effective list" is a
	// fiction this script invented.
	const dev = wiring.find((w) => w.name === DEV_RULESET);
	if (!dev) {
		failures.push(`${MAIN}: no ruleset named \`${DEV_RULESET}\`. Mergify's queue gates \`base = dev\`, so without it there is nothing to compare Mergify against.`);
	} else if (dev.forEach !== "local.dev_required_status_checks") {
		failures.push(`${MAIN}: the \`${DEV_RULESET}\` ruleset iterates \`${dev.forEach}\`, not \`local.dev_required_status_checks\`. This check derives dev's effective list from that local; wired to anything else it would compare Mergify against a set the ruleset does not use.`);
	}
	for (const w of wiring.filter((x) => x.name !== DEV_RULESET)) {
		// Staging may iterate its own filtered local (the release gate runs there but is required
		// only on main). Wired to that local, the local must parse — a ruleset pointing at a name
		// that does not exist requires nothing, silently.
		if (w.name === STAGING_RULESET && w.forEach === `local.${STAGING_LOCAL}`) {
			if (!Array.isArray(stagingExcluded)) {
				failures.push(`${MAIN}: the \`${STAGING_RULESET}\` ruleset iterates \`local.${STAGING_LOCAL}\`, but no such local parses. It would require nothing.`);
			} else if (hclAll.filter((c) => !stagingExcluded.includes(c)).length === 0) {
				failures.push(`${MAIN}: the staging filter removes every context. Staging would require nothing.`);
			} else {
				notes.push(`${MAIN}: \`${STAGING_RULESET}\` requires everything but ${stagingExcluded.map((c) => `\`${c}\``).join(", ")} (observed there, required on main).`);
			}
			continue;
		}
		if (w.forEach !== "var.required_status_checks") {
			notes.push(`${MAIN}: ruleset \`${w.name}\` iterates \`${w.forEach}\` rather than \`var.required_status_checks\`. Not checked here — Mergify only gates dev — but it is no longer covered by the assumption this file is built on.`);
		}
	}

	const devHcl = hclAll.filter((c) => !devExcluded.includes(c));
	if (devHcl.length === 0) failures.push(`${MAIN}: the dev filter removes every context. Dev would require nothing.`);

	// The two Mergify lists are a list each, not one list read twice.
	if (mergifyBlocks.length < 2) {
		failures.push(`${MERGIFY}: found ${mergifyBlocks.length} condition block(s) naming a status check; expected the queue's \`merge_conditions\` AND the merge protection's \`success_conditions\`. Either the file changed shape or this parser is blind, and both mean the comparison below is meaningless.`);
		return { failures, notes, devHcl, mergify: [] };
	}
	for (const b of mergifyBlocks) dup(b.contexts, `${MERGIFY}:${b.line} (${b.key})`);
	const [first, ...rest] = mergifyBlocks;
	const key = (b) => [...b.contexts].sort().join("\n");
	for (const b of rest) {
		if (key(b) !== key(first)) {
			const only = (a, z) => a.contexts.filter((c) => !z.contexts.includes(c));
			failures.push(
				`${MERGIFY}: \`${first.key}\` (line ${first.line}) and \`${b.key}\` (line ${b.line}) do not require the same checks. ` +
					`Only in ${first.key}: ${only(first, b).map((c) => `\`${c}\``).join(", ") || "—"}. Only in ${b.key}: ${only(b, first).map((c) => `\`${c}\``).join(", ") || "—"}. ` +
					`The merge protection decides when the PR is auto-queued and the queue decides when it merges, so a check in one and not the other is a PR that queues and then waits, or waits and then merges unchecked.`,
			);
		}
	}
	const mergify = first.contexts;

	// ── the hazardous direction: required by the ruleset, not waited for by Mergify ──
	for (const c of devHcl.filter((x) => !mergify.includes(x))) {
		failures.push(
			`\`${c}\` is required by the \`${DEV_RULESET}\` ruleset (${VARIABLES}) but is not a \`check-success=\` condition in ${MERGIFY}. ` +
				`Mergify will queue a PR without waiting for it and GitHub will then REFUSE the merge — protect-dev has no bypass actors — which is a stuck queue entry with nothing red to explain it. ` +
				`Add \`- "check-success=${c}"\` to BOTH ${MERGIFY} blocks. This direction cannot be declared away: there is no state of the world in which it is what someone meant.`,
		);
	}

	// ── the deliberate direction: Mergify leading the ruleset, which must be declared ──
	const records = Array.isArray(divergence?.mergify_leads?.records) ? divergence.mergify_leads.records : [];
	const unmatched = new Map();
	for (const rec of records) {
		if (unmatched.has(rec.context)) {
			failures.push(`${DIVERGENCE}: duplicate record for \`${rec.context}\`. One record per context is the most that can ever match; the extra can never be satisfied and would pad the list.`);
			continue;
		}
		unmatched.set(rec.context, rec);
	}
	for (const c of mergify.filter((x) => !devHcl.includes(x))) {
		const rec = unmatched.get(c);
		if (rec) {
			unmatched.delete(c);
			notes.push(`\`${c}\` is required by Mergify and not yet by the \`${DEV_RULESET}\` ruleset — declared in ${DIVERGENCE}: ${rec.reason ?? "no reason recorded"}${rec.issue ? ` (${rec.issue})` : ""}.`);
			continue;
		}
		failures.push(
			`\`${c}\` is a \`check-success=\` condition in ${MERGIFY} but is not in \`required_status_checks\` (${VARIABLES}). ` +
				`Leading the ruleset is the documented order and is safe — Mergify simply holds the PR — but an undeclared lead is indistinguishable from a forgotten one, and this pair has now been out of step for a month twice. ` +
				`Either add \`${c}\` to the HCL, or record it in ${DIVERGENCE} under \`mergify_leads\` with the reason and the issue tracking the apply.`,
		);
	}
	for (const [c, rec] of unmatched) {
		failures.push(
			`${DIVERGENCE}: the record for \`${c}\` no longer corresponds to a divergence — it is either in both lists now, or in neither. ` +
				`Delete it; this list only shrinks. A record for something that does not exist is the same stale-evidence shape the record was meant to expose.` +
				(rec.issue ? ` It named ${rec.issue}.` : ""),
		);
	}

	return { failures, notes, devHcl, mergify };
}

/**
 * The live rulesets, read from GitHub. Returns `null` with a reason when it cannot read them —
 * "could not look" and "looked and found nothing" must never render the same.
 */
export function readLiveRulesets(repo, run = (args) => execFileSync("gh", args, { encoding: "utf8" })) {
	try {
		const rulesets = [];
		for (const [branch, name] of RULESET_BRANCHES) {
			const rules = JSON.parse(run(["api", `repos/${repo}/rules/branches/${branch}`]));
			if (!Array.isArray(rules)) return { rulesets: null, error: `the rules endpoint returned no array for \`${branch}\`` };
			const checks = rules
				.filter((x) => x.type === "required_status_checks")
				.flatMap((x) => (x.parameters?.required_status_checks ?? []).map((c) => c.context));
			rulesets.push({ name, branch, checks });
		}
		return { rulesets, error: null };
	} catch (e) {
		return { rulesets: null, error: String(e.message ?? e).split("\n")[0] };
	}
}

/** Drift between the HCL's intent and what the rulesets actually enforce today. */
export function compareLive({ rulesets, hclAll, devExcluded, stagingExcluded = null }) {
	const rows = [];
	for (const rs of rulesets) {
		const excluded = rs.name === DEV_RULESET ? devExcluded : rs.name === STAGING_RULESET && Array.isArray(stagingExcluded) ? stagingExcluded : [];
		const expected = hclAll.filter((c) => !excluded.includes(c));
		const missing = expected.filter((c) => !rs.checks.includes(c));
		const extra = rs.checks.filter((c) => !expected.includes(c));
		rows.push({ name: rs.name, branch: rs.branch, missing, extra, live: rs.checks.length, expected: expected.length });
	}
	return rows;
}

// ── THE FOURTH QUESTION: has a required context ever been SATISFIED? ──────────────────────────────
//
// The three comparisons above all ask whether the LISTS agree. None of them asks whether the checks
// on those lists can go green — and a context nothing has ever satisfied is the one failure that
// cannot be recovered from without `--admin`: it blocks every PR into the branch, permanently, with
// nothing red to point at. The merge box just says a required check has not run.
//
// This was reached twice in one day. #4435 added `Release gate (audit-interaction)` under a name no
// job produced (a NAME mismatch, since fixed). #4510 then found the same context under the RIGHT
// name with no observed success, because `apps/console/e2e/gate-baseline.json` carried no baseline
// for it and the ratchet fails closed on an uncaptured one — correctly, since a gate that passes
// against an empty ledger is vacuous. The three lists agreed perfectly in both cases.
//
// The hazard is at APPLY time, not now: `infra/github` is applied by hand, so the HCL's INTENT is
// what this is measured against. The question is "would an apply wedge this branch", and it is worth
// answering before the apply rather than discovering it afterwards on a promotion that will not move.

/**
 * Fold observed CI jobs into `context → Set(conclusion)`.
 *
 * Pure, so the fixtures exercise it without the network. A job that has not finished contributes its
 * `status` (`queued`, `in_progress`) rather than a conclusion, and that distinction is load-bearing:
 * a queued job is evidence the leg EXISTS, and is NOT evidence it can pass. Collapsing the two is
 * exactly how #4510's leg read as "present" while never having gone green.
 */
export function collectObservedConclusions(jobs) {
	const observed = new Map();
	for (const j of jobs ?? []) {
		const name = j?.name;
		if (typeof name !== "string" || name === "") continue;
		const outcome = j.conclusion ?? j.status ?? "unknown";
		if (!observed.has(name)) observed.set(name, new Set());
		observed.get(name).add(outcome);
	}
	return observed;
}

/**
 * Required contexts nothing has ever been seen to satisfy.
 *
 * `unseen` and `neverGreen` are reported apart on purpose — they call for different actions. A
 * context no job has ever produced is usually a NAME or a trigger (#4435's case); a context whose
 * every run failed is a real red someone has to fix (#4510's case, and #4445's `canvas` today).
 * Merging them into one "bad" list would have made those two indistinguishable in the report.
 */
export function neverSatisfied({ contexts, observed }) {
	const unseen = [];
	const neverGreen = [];
	for (const c of contexts) {
		const seen = observed.get(c);
		if (!seen || seen.size === 0) {
			unseen.push(c);
			continue;
		}
		if (!seen.has("success")) neverGreen.push({ context: c, seen: [...seen].sort() });
	}
	return { unseen, neverGreen };
}

/**
 * Re-ask, deeper, about the contexts the shallow pass flagged.
 *
 * The shallow window is uniform across workflows, so a leg that passes RARELY reads as never-green
 * purely because its last success fell outside it — measured: at 8 runs per workflow `Release gate
 * (audit)` was flagged, and it had in fact gone green 12 runs back. Deepening everything to cover
 * that costs a multiple of the API calls for a question already answered about most contexts.
 *
 * So deepen only where the answer is still "no", and only in the workflows that actually emit the
 * context — which pass 1 recorded. A context nothing produced at all (`unseen`) cannot be deepened
 * and stays flagged, which is the correct answer for it: no workflow emits that name.
 */
export function deepenNeverGreen({ repo, neverGreen, jobs, depth, run }) {
	const cleared = [];
	for (const n of neverGreen) {
		const wfs = [...new Set(jobs.filter((j) => j.name === n.context).map((j) => j.workflow))];
		let green = false;
		for (const wf of wfs) {
			if (green) break;
			try {
				const runs = JSON.parse(run(["api", `repos/${repo}/actions/workflows/${wf}/runs?per_page=${depth}`]));
				for (const r of runs?.workflow_runs ?? []) {
					const page = JSON.parse(run(["api", `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`]));
					if ((page?.jobs ?? []).some((j) => j.name === n.context && j.conclusion === "success")) {
						green = true;
						break;
					}
				}
			} catch {
				// A deepening that cannot read leaves the flag STANDING. Failing to clear an alarm is
				// the safe direction; clearing one on an unread page is not.
			}
		}
		if (green) cleared.push(n.context);
	}
	return cleared;
}

/**
 * Read recent job names + conclusions across the repo's workflow runs.
 *
 * Bounded by `runLimit` because the question is "has this EVER gone green recently", not "produce a
 * history" — and an unbounded walk over a repo with this much CI is a rate-limit incident.
 *
 * SAMPLE BY WORKFLOW, NOT BY RECENCY. This took three tries, and each wrong one over-reported:
 *
 *   1. The most recent runs, unfiltered, reported ALL 19 required contexts as never-green —
 *      including `TypeScript (lint · types · test · docs)`, which passes on essentially every push.
 *      On a busy queue the newest runs are `in_progress`, so the window held runs with no verdict.
 *   2. `status=completed` reported the same 19, now all `cancelled`: Mergify's speculative queue
 *      drafts are cancelled constantly, so recent COMPLETED runs are mostly cancellations.
 *   3. `status=success` finally cleared the 12 ordinary contexts, but still flagged all seven
 *      release-gate legs. Four of those seven were wrong — `hero`, `elench-ai`, `console` and
 *      `audit` HAVE each gone green, inside runs whose overall conclusion was `failure`. A job's
 *      conclusion is independent of its run's, so filtering by run status discards real evidence.
 *
 * Every one of those windows sampled by RECENCY, and recency is dominated by the chattiest
 * workflow. A required context emitted by a rare, label-gated workflow (`release-gate.yml` runs
 * only on a labelled PR) is crowded out of any recency window long before it is crowded out of its
 * own workflow's history. So the frame is one slice per WORKFLOW: every workflow gets equal
 * representation and a rare leg is as visible as a chatty one.
 *
 * The remaining bound is stated rather than hidden: only the last `perWorkflow` runs of each
 * workflow are read, so a context that last passed longer ago than that reads as never-green. That
 * direction is deliberate — it over-reports a wedge risk rather than under-reporting one, and a
 * missed wedge is unrecoverable without `--admin` while a false alarm costs one look.
 *
 * FAIL-CLOSED, like every other reader in this file: an API error, or a walk that yields no jobs at
 * all, returns an error rather than an empty map. "I could not look" must never render as "I looked
 * and everything is fine" — that is the green-on-blindness defect this file exists to argue against.
 */
export function readObservedJobs(repo, { perWorkflow = 8, run = (args) => execFileSync("gh", args, { encoding: "utf8" }) } = {}) {
	try {
		const wfs = JSON.parse(run(["api", `repos/${repo}/actions/workflows?per_page=100`]));
		const wfIds = (wfs?.workflows ?? []).filter((w) => w.state === "active").map((w) => w.id);
		if (wfIds.length === 0) return { jobs: null, error: "the workflows endpoint returned no active workflows" };
		const jobs = [];
		let runsRead = 0;
		for (const wf of wfIds) {
			const runs = JSON.parse(run(["api", `repos/${repo}/actions/workflows/${wf}/runs?per_page=${perWorkflow}`]));
			for (const r of runs?.workflow_runs ?? []) {
				runsRead++;
				const page = JSON.parse(run(["api", `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`]));
				for (const j of page?.jobs ?? []) jobs.push({ name: j.name, conclusion: j.conclusion, status: j.status, workflow: wf });
			}
		}
		if (runsRead === 0) return { jobs: null, error: `read ${wfIds.length} workflow(s) and found no runs at all` };
		if (jobs.length === 0) return { jobs: null, error: `read ${runsRead} run(s) and found no jobs at all` };
		return { jobs, error: null };
	} catch (e) {
		return { jobs: null, error: String(e.message ?? e).split("\n")[0] };
	}
}

function ok(label, cond, detail = "") {
	if (cond) {
		console.log(`ok   - ${label}`);
		return true;
	}
	console.log(`FAIL - ${label}${detail ? `: ${detail}` : ""}`);
	return false;
}

function selfTest() {
	let pass = true;
	const P = (l, c, d) => {
		pass = ok(l, c, d) && pass;
	};

	const vars = `
variable "required_status_checks" {
  description = "CI check contexts"
  type        = list(string)
  # A comment that names "branch-flow-guard" in quotes, which a naive parser would harvest.
  default = [
    "A",
    "B",
    "branch-flow-guard",
  ]
}
`;
	const main = `
locals {
  dev_required_status_checks = [for c in var.required_status_checks : c if c != "branch-flow-guard"]
}
resource "github_repository_ruleset" "dev" {
  name = "protect-dev"
  rules {
    required_status_checks {
      dynamic "required_check" {
        for_each = local.dev_required_status_checks
      }
    }
  }
}
resource "github_repository_ruleset" "main" {
  name = "protect-main"
  rules {
    required_status_checks {
      dynamic "required_check" {
        for_each = var.required_status_checks
      }
    }
  }
}
`;
	const mergify = (list) => `
queue_rules:
  - name: dev
    queue_conditions:
      - base = dev
      - "-draft"
    merge_conditions:
${list.map((c) => `      - "check-success=${c}"`).join("\n")}
merge_protections:
  - name: dev required CI
    success_conditions:
${list.map((c) => `      - "check-success=${c}"`).join("\n")}
`;

	// A comment that quotes a context name must not become part of the list. This is the parse the
	// real variables.tf demands: every entry there sits under several paragraphs of prose.
	P("a context quoted inside a comment is not harvested", JSON.stringify(parseRequiredStatusChecks(vars)) === JSON.stringify(["A", "B", "branch-flow-guard"]), JSON.stringify(parseRequiredStatusChecks(vars)));
	P("the dev filter is read from the local, not assumed", JSON.stringify(parseDevFilter(main)) === JSON.stringify(["branch-flow-guard"]));
	P("the dev ruleset's wiring is resolved", parseRulesetWiring(main).find((w) => w.name === "protect-dev")?.forEach === "local.dev_required_status_checks");
	P("...and so is a sibling's", parseRulesetWiring(main).find((w) => w.name === "protect-main")?.forEach === "var.required_status_checks");

	// ── staging's own filtered local (#4265). Absent is the old shape and not an error; present
	//    must parse, and a ruleset wired to it must find it.
	P("no staging local means null, not an error", parseStagingFilter(main) === null);
	const mainStaging = main + `
locals {
  staging_required_status_checks = [for c in var.required_status_checks : c if c != "B"]
}
resource "github_repository_ruleset" "staging" {
  name = "protect-staging"
  rules {
    required_status_checks {
      dynamic "required_check" {
        for_each = local.staging_required_status_checks
      }
    }
  }
}
`;
	P("the staging filter is read from its local", JSON.stringify(parseStagingFilter(mainStaging)) === JSON.stringify(["B"]));
	P("an unmodelled staging clause is an error", (() => { try { parseStagingFilter("staging_required_status_checks = [for c in var.required_status_checks : c if contains(c, \"x\")]"); return false; } catch { return true; } })());
	{
		const w = parseRulesetWiring(mainStaging);
		const a = compare({ hclAll: parseRequiredStatusChecks(vars), devExcluded: parseDevFilter(mainStaging), stagingExcluded: parseStagingFilter(mainStaging), wiring: w, mergifyBlocks: parseMergifyCheckBlocks(mergify(["A", "B"])), divergence: undefined });
		P("staging wired to its local, with the local present, is not a failure", a.failures.length === 0, JSON.stringify(a.failures));
		P("...and it is reported as observed-not-required", a.notes.some((n) => /protect-staging/.test(n) && /`B`/.test(n)), JSON.stringify(a.notes));
		const b = compare({ hclAll: parseRequiredStatusChecks(vars), devExcluded: parseDevFilter(mainStaging), stagingExcluded: null, wiring: w, mergifyBlocks: parseMergifyCheckBlocks(mergify(["A", "B"])), divergence: undefined });
		P("staging wired to a local that does not parse is a failure", b.failures.some((f) => /no such local parses/.test(f)), JSON.stringify(b.failures));
		const live = compareLive({ rulesets: [{ name: "protect-staging", checks: ["A", "branch-flow-guard"] }], hclAll: parseRequiredStatusChecks(vars), devExcluded: parseDevFilter(mainStaging), stagingExcluded: parseStagingFilter(mainStaging) });
		P("live staging drift is measured against the staging local, not the full list", live[0].missing.length === 0 && live[0].extra.length === 0, JSON.stringify(live));
	}
	P("both Mergify blocks are found separately", parseMergifyCheckBlocks(mergify(["A", "B"])).length === 2);
	P("...and queue_conditions, which names no check, is not one of them", parseMergifyCheckBlocks(mergify(["A", "B"])).every((b) => b.key !== "queue_conditions"));

	// ── The review-findings gate (#3498). Its placement is its correctness, and `compare` cannot
	//    see it: it names no check, so parseMergifyCheckBlocks drops the block entirely.
	const GATE = '      - "#review-threads-unresolved = 0"';
	const withGate = (where) => {
		const base = mergify(["A", "B"]).split("\n");
		const out = [];
		for (const line of base) {
			out.push(line);
			const k = /^\s*([a-z_]+conditions):\s*$/.exec(line);
			if (k && where.includes(k[1])) out.push(GATE);
		}
		// auto_merge_conditions does not exist in the fixture's shape; append one when asked for.
		if (where.includes("auto_merge_conditions")) out.push("merge_protections_settings:", "  auto_merge_conditions:", "    - base = dev", '    - "#review-threads-unresolved = 0"');
		return out.join("\n");
	};
	const gateFails = (where) => compareThreadGate(parseMergifyConditionBlocks(withGate(where)));

	P("the gate in BOTH eligibility blocks is accepted", gateFails(["queue_conditions", "auto_merge_conditions"]).length === 0, JSON.stringify(gateFails(["queue_conditions", "auto_merge_conditions"])));
	P("the gate in merge_conditions is a failure", gateFails(["merge_conditions", "queue_conditions", "auto_merge_conditions"]).some((f) => /merge_conditions/.test(f)));
	P("...and the message names the dead-condition half, not just 'wrong block'", gateFails(["merge_conditions", "queue_conditions", "auto_merge_conditions"]).some((f) => /TEMPORARY MERGE/.test(f) && /0 = 0/.test(f)));
	P("the gate in success_conditions is a failure too", gateFails(["success_conditions", "queue_conditions", "auto_merge_conditions"]).some((f) => /success_conditions/.test(f)));
	P("the gate in only queue_conditions is a failure", gateFails(["queue_conditions"]).some((f) => /auto_merge_conditions/.test(f)));
	P("the gate in only auto_merge_conditions is a failure", gateFails(["auto_merge_conditions"]).some((f) => /queue_conditions/.test(f)));
	// ⚠️ RECORDED ON PURPOSE, not an oversight: absence is NOT a failure. Asserting presence would
	//    make the one-line rollback red CI, turning an emergency revert into a two-file change.
	P("the gate being ABSENT everywhere is not a failure — the rollback stays one line", gateFails([]).length === 0);
	// And the parser must still be a parser: a condition that is not the gate is not the gate.
	// ⚠️ The silent footgun, found by mutating the real file: unquoting makes YAML see null, and a
	//    parser that harvests the text anyway reports the gate PRESENT over an absent gate.
	const unquoted = withGate(["queue_conditions", "auto_merge_conditions"]).replace('      - "#review-threads-unresolved = 0"', "      - #review-threads-unresolved = 0");
	P("an UNQUOTED gate is a failure — YAML reads it as a comment and the item is null", compareThreadGate(parseMergifyConditionBlocks(unquoted)).some((f) => /UNQUOTED/.test(f)));
	P("...and the parser does not count it as present", parseMergifyConditionBlocks(unquoted).filter((b) => b.key === "queue_conditions").every((b) => !b.items.some((i) => i.startsWith("#review-threads-unresolved"))));
	P("a different condition in merge_conditions is not mistaken for the gate", compareThreadGate(parseMergifyConditionBlocks(mergify(["A"]).replace("    merge_conditions:", '    merge_conditions:\n      - "#commits-behind > 0"'))).length === 0);

	// ── THREE MORE BLIND SPOTS, each found by mutating the REAL .mergify.yml and each silent. ──
	//
	// The placement rules above all matched the gate by its KEY, so the operator and the value went
	// unchecked in both directions.
	const both = ["queue_conditions", "auto_merge_conditions"];
	const withOp = (op) => compareThreadGate(parseMergifyConditionBlocks(withGate(both).replaceAll("#review-threads-unresolved = 0", `#review-threads-unresolved ${op}`)));
	P("`>= 0` is a failure — it can never be false, so the gate is installed and inert", withOp(">= 0").some((f) => /not the gate/.test(f)));
	P("`> 0` is a failure — inverted, nothing without findings could ever queue", withOp("> 0").some((f) => /not the gate/.test(f)));
	P("...and the exact gate still passes, so the check is not just 'any gate is wrong'", withOp("= 0").length === 0);

	// SINGLE quotes are valid YAML and were invisible: not caught as the `#` comment footgun, and
	// the leading quote defeated the key match — so a gate single-quoted in one block read as
	// absent from BOTH, and the missing-eviction half (#3444) shipped green.
	const singleQuoted = withGate(both).replace('      - "#review-threads-unresolved = 0"', "      - '#review-threads-unresolved = 0'");
	P("a SINGLE-quoted gate is seen (valid YAML, and it was invisible)", compareThreadGate(parseMergifyConditionBlocks(singleQuoted)).length === 0);
	const singleQuotedOneSided = singleQuoted.replace("      - '#review-threads-unresolved = 0'", "");
	P("...so a single-quoted gate in only ONE block is still caught as one-sided", compareThreadGate(parseMergifyConditionBlocks(singleQuotedOneSided)).some((f) => /but not/.test(f)));

	// A gate nested under `- or:` is bypassable by anything else in the or — and flattening on
	// indent alone attributed it to the enclosing block, so a fully bypassable gate read as
	// correctly placed.
	const nested = withGate(both).replace('      - "#review-threads-unresolved = 0"', '      - or:\n        - "#review-threads-unresolved = 0"\n        - "label=override"');
	P("a gate nested under `- or:` does not count as a top-level condition", compareThreadGate(parseMergifyConditionBlocks(nested)).some((f) => /but not/.test(f)));

	const wiring = parseRulesetWiring(main);
	const hclAll = parseRequiredStatusChecks(vars);
	const devExcluded = parseDevFilter(main);
	const run = (m, divergence) => compare({ hclAll, devExcluded, wiring, mergifyBlocks: parseMergifyCheckBlocks(m), divergence });

	// The agreeing case. `branch-flow-guard` is in the HCL and in NEITHER Mergify list, and that must
	// raise nothing at all — it is filtered out of dev by the local, so it was never dev's to require.
	let r = run(mergify(["A", "B"]));
	P("lists that agree raise nothing", r.failures.length === 0, JSON.stringify(r.failures));
	P("...and a context the dev filter removes is not treated as missing", !r.failures.some((f) => /branch-flow-guard/.test(f)), JSON.stringify(r.failures));

	// The hazardous direction.
	r = run(mergify(["A"]));
	P("a check the ruleset requires and Mergify does not is a failure", r.failures.some((f) => /`B` is required by the `protect-dev` ruleset/.test(f)), JSON.stringify(r.failures));
	P("...and the message names the consequence, not just the difference", r.failures.some((f) => /stuck queue entry/.test(f)), JSON.stringify(r.failures));
	P("...and it says to add it to BOTH blocks", r.failures.some((f) => /BOTH/.test(f)), JSON.stringify(r.failures));
	// It must not be declarable. A hazard with an escape hatch is a hazard with a habit.
	r = run(mergify(["A"]), { mergify_leads: { records: [{ context: "B", reason: "nope" }] } });
	P("...and it cannot be declared away", r.failures.some((f) => /`B` is required by the `protect-dev` ruleset/.test(f)), JSON.stringify(r.failures));

	// The deliberate direction.
	r = run(mergify(["A", "B", "C"]));
	P("an undeclared Mergify lead is a failure", r.failures.some((f) => /`C` is a `check-success=` condition/.test(f)), JSON.stringify(r.failures));
	r = run(mergify(["A", "B", "C"]), { mergify_leads: { records: [{ context: "C", reason: "awaiting the apply", issue: "#2606" }] } });
	P("a declared Mergify lead is not a failure", r.failures.length === 0, JSON.stringify(r.failures));
	P("...but it is still reported, with its reason", r.notes.some((n) => /`C`/.test(n) && /awaiting the apply/.test(n)), JSON.stringify(r.notes));

	// Shrink-only.
	r = run(mergify(["A", "B"]), { mergify_leads: { records: [{ context: "C", reason: "gone" }] } });
	P("a record for a divergence that no longer exists is a failure", r.failures.some((f) => /no longer corresponds to a divergence/.test(f)), JSON.stringify(r.failures));
	r = run(mergify(["A", "B", "C"]), { mergify_leads: { records: [{ context: "C" }, { context: "C" }] } });
	P("a duplicate record is a failure", r.failures.some((f) => /duplicate record/.test(f)), JSON.stringify(r.failures));

	// The two Mergify lists against each other — the fourth place these can disagree.
	const skewed = mergify(["A", "B"]).replace('      - "check-success=B"\nmerge_protections', "merge_protections");
	r = run(skewed);
	P("the two Mergify blocks disagreeing is a failure", r.failures.some((f) => /do not require the same checks/.test(f)), JSON.stringify(r.failures));

	// Blindness. Every one of these used to be, or would naturally be, a silent pass.
	P("an absent variable is an error, not an empty list", (() => { try { parseRequiredStatusChecks("variable \"other\" {}"); return false; } catch { return true; } })());
	P("an empty default is an error, not agreement about nothing", (() => { try { parseRequiredStatusChecks('variable "required_status_checks" {\n default = [\n]\n}'); return false; } catch { return true; } })());
	P("an unmodelled dev filter is an error, not an unfiltered list", (() => { try { parseDevFilter('dev_required_status_checks = [for c in var.required_status_checks : c if length(c) > 3]'); return false; } catch { return true; } })());
	P("an absent dev filter is an error", (() => { try { parseDevFilter("locals {}"); return false; } catch { return true; } })());
	P("no rulesets at all is an error", (() => { try { parseRulesetWiring("locals {}"); return false; } catch { return true; } })());
	r = run("queue_rules:\n  - name: dev\n");
	P("a Mergify file naming no checks is a failure, not a pass", r.failures.some((f) => /this parser is blind/.test(f)), JSON.stringify(r.failures));
	const rewired = main.replace("for_each = local.dev_required_status_checks", "for_each = var.required_status_checks");
	r = compare({ hclAll, devExcluded, wiring: parseRulesetWiring(rewired), mergifyBlocks: parseMergifyCheckBlocks(mergify(["A", "B"])), divergence: undefined });
	P("the dev ruleset wired to a different expression is a failure", r.failures.some((f) => /iterates `var.required_status_checks`/.test(f)), JSON.stringify(r.failures));

	// A duplicate in the source list.
	P("a context listed twice in the HCL is a failure", compare({ hclAll: ["A", "A"], devExcluded: [], wiring, mergifyBlocks: parseMergifyCheckBlocks(mergify(["A"])), divergence: undefined }).failures.some((f) => /listed twice/.test(f)));

	// The live half: "could not look" must never render as "looked and found nothing".
	const boom = readLiveRulesets("x/y", () => { throw new Error("HTTP 403: Resource not accessible by integration"); });
	P("an unreadable rulesets API returns an error, not an empty result", boom.rulesets === null && /403/.test(boom.error), JSON.stringify(boom));
	const live = compareLive({ rulesets: [{ name: "protect-dev", checks: ["A"] }], hclAll, devExcluded });
	P("live drift names what the ruleset is missing", live[0].missing.includes("B") && !live[0].missing.includes("branch-flow-guard"), JSON.stringify(live));
	const liveExtra = compareLive({ rulesets: [{ name: "protect-dev", checks: ["A", "B", "Z"] }], hclAll, devExcluded });
	P("...and what it requires that the HCL does not", liveExtra[0].extra.includes("Z"), JSON.stringify(liveExtra));

	// ── the fourth question: a required context nothing can satisfy ──────────────────────────────
	const jobsFixture = [
		{ name: "TypeScript (lint · types · test · docs)", conclusion: "success", status: "completed" },
		{ name: "TypeScript (lint · types · test · docs)", conclusion: "failure", status: "completed" },
		{ name: "Release gate (canvas)", conclusion: "failure", status: "completed" },
		{ name: "Release gate (audit-interaction)", conclusion: null, status: "queued" },
	];
	const obs = collectObservedConclusions(jobsFixture);
	P("a context seen green at least once is satisfiable", neverSatisfied({ contexts: ["TypeScript (lint · types · test · docs)"], observed: obs }).neverGreen.length === 0);
	P("a context observed only as failure is neverGreen, not unseen", (() => { const r = neverSatisfied({ contexts: ["Release gate (canvas)"], observed: obs }); return r.unseen.length === 0 && r.neverGreen[0]?.context === "Release gate (canvas)"; })(), JSON.stringify(neverSatisfied({ contexts: ["Release gate (canvas)"], observed: obs })));
	// A QUEUED job must not read as satisfiable. This is the #4510 shape exactly: the leg existed,
	// one run carried it, and it had never concluded — "present" was mistaken for "can pass".
	P("a context only ever queued is NOT satisfied", neverSatisfied({ contexts: ["Release gate (audit-interaction)"], observed: obs }).neverGreen.some((n) => n.context === "Release gate (audit-interaction)"));
	P("a context no job has ever produced is unseen, not neverGreen", (() => { const r = neverSatisfied({ contexts: ["Release gate (nobody-emits-this)"], observed: obs }); return r.unseen.length === 1 && r.neverGreen.length === 0; })());
	// MUTATION CONTROL: drop the green fixture and the same context must flip to a finding. Without
	// this the two assertions above would both pass against a predicate that never fires.
	P("...and removing the only success flips it to a finding", neverSatisfied({ contexts: ["TypeScript (lint · types · test · docs)"], observed: collectObservedConclusions(jobsFixture.filter((j) => j.conclusion !== "success")) }).neverGreen.length === 1);
	P("a job with no name is ignored rather than recorded as an empty context", collectObservedConclusions([{ name: "", conclusion: "success" }, { conclusion: "success" }]).size === 0);
	// "Could not look" must never render as "looked and found nothing" — same rule as the rulesets reader.
	// The deepening pass: it must CLEAR a context that passed outside the shallow window, and must
	// leave one standing when the deeper look is unreadable (failing to clear is the safe direction).
	const deepJobs = [{ name: "Release gate (audit)", conclusion: "failure", workflow: 7 }];
	const deepRun = (a) => (a[1].includes("/runs?per_page") ? JSON.stringify({ workflow_runs: [{ id: 99 }] }) : JSON.stringify({ jobs: [{ name: "Release gate (audit)", conclusion: "success" }] }));
	P("deepening clears a context that passed outside the shallow window", deepenNeverGreen({ repo: "x/y", neverGreen: [{ context: "Release gate (audit)", seen: ["failure"] }], jobs: deepJobs, depth: 30, run: deepRun }).includes("Release gate (audit)"));
	P("deepening that cannot read leaves the flag standing", deepenNeverGreen({ repo: "x/y", neverGreen: [{ context: "Release gate (audit)", seen: ["failure"] }], jobs: deepJobs, depth: 30, run: () => { throw new Error("HTTP 500"); } }).length === 0);
	P("deepening never invents a clear for a context nothing emits", deepenNeverGreen({ repo: "x/y", neverGreen: [{ context: "Nobody emits this", seen: ["failure"] }], jobs: deepJobs, depth: 30, run: deepRun }).length === 0);
	const jobsBoom = readObservedJobs("x/y", { run: () => { throw new Error("HTTP 403: Resource not accessible by integration"); } });
	P("an unreadable runs API returns an error, not an empty job list", jobsBoom.jobs === null && /403/.test(jobsBoom.error), JSON.stringify(jobsBoom));
	const jobsEmpty = readObservedJobs("x/y", { run: () => JSON.stringify({ workflows: [] }) });
	P("zero active workflows is an error, not 'every context is satisfiable'", jobsEmpty.jobs === null && /no active workflows/.test(jobsEmpty.error), JSON.stringify(jobsEmpty));
	// A workflow list that yields no RUNS is also no measurement — the second fail-closed arm.
	const jobsNoRuns = readObservedJobs("x/y", { run: (a) => (a[1].includes("/workflows?") ? JSON.stringify({ workflows: [{ id: 1, state: "active" }] }) : JSON.stringify({ workflow_runs: [] })) });
	P("workflows with no runs is an error, not a clean bill", jobsNoRuns.jobs === null && /no runs at all/.test(jobsNoRuns.error), JSON.stringify(jobsNoRuns));

	console.log(pass ? "\nself-test: all passed" : "\nself-test: FAILED");
	return pass;
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

	const read = (f) => {
		if (!fs.existsSync(f)) {
			console.error(`::error::check-required-checks: ${f} is missing. Refusing to report agreement between lists one of which does not exist.`);
			process.exit(1);
		}
		return fs.readFileSync(f, "utf8");
	};

	let hclAll;
	let devExcluded;
	let stagingExcluded;
	let wiring;
	let mergifyBlocks;
	let conditionBlocks;
	try {
		hclAll = parseRequiredStatusChecks(read(VARIABLES));
		devExcluded = parseDevFilter(read(MAIN));
		stagingExcluded = parseStagingFilter(read(MAIN));
		wiring = parseRulesetWiring(read(MAIN));
		mergifyBlocks = parseMergifyCheckBlocks(read(MERGIFY));
		conditionBlocks = parseMergifyConditionBlocks(read(MERGIFY));
	} catch (e) {
		console.error(`::error::check-required-checks: ${e.message}`);
		process.exit(1);
	}

	// ABSENT MEANS EMPTY, not "skip the rule". Deleting the declaration file must make this LOUDER
	// (every lead becomes a failure), never quieter.
	const divergence = fs.existsSync(DIVERGENCE) ? JSON.parse(fs.readFileSync(DIVERGENCE, "utf8")) : {};

	const { failures, notes, devHcl, mergify } = compare({ hclAll, devExcluded, stagingExcluded, wiring, mergifyBlocks, divergence });
	// The thread gate names no CHECK, so `compare` above is structurally blind to it — which is
	// exactly why its placement needs its own question asked.
	const gateFailures = compareThreadGate(conditionBlocks);
	failures.push(...gateFailures);

	if (argv.includes("--live")) {
		const repo = process.env.GITHUB_REPOSITORY ?? "alethialabs-io/alethialabs";
		const { rulesets, error } = readLiveRulesets(repo);
		console.log(`# Required checks — HCL vs the live rulesets\n`);
		if (!rulesets) {
			console.log(`**Could not read the live rulesets** (\`${error}\`). That is not "no drift" — it is no measurement. This job needs \`administration: read\` on the token.`);
			process.exit(1);
		}
		let drifted = false;
		for (const row of compareLive({ rulesets, hclAll, devExcluded, stagingExcluded })) {
			const agree = row.missing.length === 0 && row.extra.length === 0;
			drifted = drifted || !agree;
			console.log(`- **${row.name}** (branch \`${row.branch}\`) — live ${row.live}, HCL ${row.expected}${agree ? " · agrees" : ""}`);
			if (row.missing.length) console.log(`  - the HCL requires, the ruleset does NOT: ${row.missing.map((c) => `\`${c}\``).join(", ")} — an unapplied requirement enforces nothing`);
			if (row.extra.length) console.log(`  - the ruleset requires, the HCL does NOT: ${row.extra.map((c) => `\`${c}\``).join(", ")} — an apply would REMOVE these`);
		}
		if (drifted) console.log(`\nThe fix is a \`tofu apply\` in \`infra/github/\`, which is the maintainer's — see #2606. Nothing here can close this by itself.`);

		// THE FOURTH QUESTION. `hclAll` is what an apply would require on `main` — main takes the
		// list unfiltered, which is why it is the branch a never-satisfiable context wedges.
		const { jobs, error: jobsError } = readObservedJobs(repo);
		console.log(`\n## Can every required context actually go green?\n`);
		if (!jobs) {
			console.log(`**Could not read recent job conclusions** (\`${jobsError}\`). That is not "every context is fine" — it is no measurement.`);
			process.exit(1);
		}
		const first = neverSatisfied({ contexts: hclAll, observed: collectObservedConclusions(jobs) });
		const cleared = deepenNeverGreen({ repo, neverGreen: first.neverGreen, jobs, depth: 30, run: (args) => execFileSync("gh", args, { encoding: "utf8" }) });
		const unseen = first.unseen;
		const neverGreen = first.neverGreen.filter((n) => !cleared.includes(n.context));
		if (cleared.length) console.log(`- cleared on a deeper look (passed further back than the shallow window): ${cleared.map((c) => `\`${c}\``).join(", ")}`);
		if (unseen.length === 0 && neverGreen.length === 0) {
			console.log(`- all ${hclAll.length} context(s) the HCL requires have been observed \`success\` at least once.`);
		}
		for (const c of unseen) console.log(`- **\`${c}\`** — NO job by this name in the last runs read. Applying this would require a context nothing produces: every PR into \`main\` blocks with nothing red to point at, and \`--admin\` becomes the only way past.`);
		for (const n of neverGreen) console.log(`- **\`${n.context}\`** — observed only as ${n.seen.map((x) => `\`${x}\``).join(", ")}, never \`success\`. It exists but has never passed; requiring it wedges \`main\` until it can.`);
		const wedgeRisk = unseen.length > 0 || neverGreen.length > 0;
		if (wedgeRisk) console.log(`\nHold these out of \`required_status_checks\` until each has one observed success, or fix the leg first. See #4510.`);
		// REPORTED HERE TOO. These were computed above and then thrown away: this branch exits
		// without ever reading `failures`, so the drift report could never mention a misplaced
		// review gate it had just found. The PR-time run still catches it, so this was a missing
		// REPORT rather than a missed merge — but a report that silently drops the one finding it
		// already holds is the failure mode this file exists to argue against.
		if (gateFailures.length) {
			console.log(`\n## The review-thread gate\n`);
			for (const f of gateFailures) console.log(`- ${f}`);
			console.log(`\nThis is a \`.mergify.yml\` problem, not ruleset drift — no \`tofu apply\` will fix it.`);
		}
		process.exit(drifted || gateFailures.length || wedgeRisk ? 2 : 0);
	}

	for (const n of notes) console.log(`::warning::check-required-checks: ${n}`);
	if (failures.length === 0) {
		console.log(`check-required-checks: ${devHcl.length} required on ${DEV_RULESET}, ${mergify.length} in ${MERGIFY} — they agree.`);
		process.exit(0);
	}
	for (const f of failures) console.error(`::error::check-required-checks: ${f}`);
	console.error(`\ncheck-required-checks: ${failures.length} disagreement(s).`);
	process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
