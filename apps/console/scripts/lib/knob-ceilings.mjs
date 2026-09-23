// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `ceiling:` section of infra/templates/project/knob-exclusions.yaml — a knob that is declared,
// reachable, and UNHONORABLE BY THE PROVIDER (#4320, maintainer ruling 2026-09-23).
//
// It exists because the ledger had no honest home for that shape. `dead:` is a backlog — every entry
// is a defect a lane can fix, and the list can only shrink — and `reported:` is the output-reader
// shape, which the check verifies. A provider ceiling is neither: nothing on that cloud could ever
// read the knob, so it will never shrink, and filing it as backlog put a permanent line in a list
// whose whole meaning is that it empties.
//
// A decision section is also the easiest place in a ledger to launder a defect: move an inconvenient
// `dead:` entry here with a confident sentence and the backlog shrinks for free. So every claim an
// entry makes is RE-READ, and each rule below is one way an entry can be wrong:
//
//   1. EVIDENCE. An `issue:` (#n) or a `docs:` https link to the provider's own documentation. A
//      ceiling is a claim about somebody else's product; with no pointer to where it was settled it is
//      an opinion.
//   2. THE CARRIAGE LEDGER AGREES. `carriage:` names the `<kind>.<column>` cell, and
//      infra/config-carriage-exclusions.yaml must hold an `exclusions:` entry for that field on this
//      cloud. The two ledgers measure different units, but a ceiling is a fact about the cloud, and
//      two documents disagreeing about one cloud is worse than either — both print into public boards.
//   3. STILL DECLARED. A ceiling about a variable the template no longer declares is a decision about
//      nothing. Delete it.
//   4. STILL UNREAD. If a resource or module argument now reads the knob, the provider was not the
//      ceiling after all — it became wireable. The entry FAILS rather than going quiet, exactly as a
//      `dead:` entry that is no longer dead does.
//   5. ONE SECTION. An entry also listed under `dead:` or `reported:` is two contradictory decisions.
//
// Pure functions over plain data, so the adjudication can be pinned against fixtures (`selfCheck`,
// run by check-template-knobs.mjs before it trusts itself, and tests/scripts/knob-ceilings.test.ts).

/**
 * Read the `exclusions:` section of infra/config-carriage-exclusions.yaml into `{ field, cloud }`
 * pairs. Minimal on purpose — the same no-YAML-dependency reader shape as the knob ledger's — and it
 * stops at the next top-level key, because `baseline:`/`wired:` entries are NOT ceilings and must not
 * be able to satisfy rule 2.
 *
 * @param {string} text
 * @returns {Array<{ field: string, cloud: string }>}
 */
export function readCarriageExclusions(text) {
	/** @type {Array<Record<string, string>>} */
	const out = [];
	let inSection = false;
	/** @type {Record<string, string> | null} */
	let cur = null;
	for (const raw of text.split("\n")) {
		if (/^\s*#/.test(raw) || !raw.trim()) continue;
		const top = raw.match(/^(\w+):\s*$/);
		if (top) {
			if (cur) out.push(cur);
			cur = null;
			inSection = top[1] === "exclusions";
			continue;
		}
		if (!inSection) continue;
		const start = raw.match(/^\s*-\s+(\w+):\s*(.+)$/);
		if (start) {
			if (cur) out.push(cur);
			cur = { [start[1]]: unquote(start[2]) };
			continue;
		}
		const kv = raw.match(/^\s+(\w+):\s*(.+)$/);
		if (kv && cur) cur[kv[1]] = unquote(kv[2]);
	}
	if (cur) out.push(cur);
	return out.flatMap((e) => (e.field && e.cloud ? [{ field: e.field, cloud: e.cloud }] : []));
}

/** Strip one layer of matching quotes from a scalar.
 * @param {string} v */
function unquote(v) {
	return v.trim().replace(/^["']|["']$/g, "");
}

/** Is `(cloud, component, knob)` the same knob as this manifest entry?
 * @param {{ cloud: string, component: string, knob: string }} x
 * @param {{ cloud: string, component: string, name: string }} k */
const same = (x, k) => x.cloud === k.cloud && x.component === k.component && x.knob === k.name;

/**
 * Every way the `ceiling:` section is wrong, as `{ title, detail }` findings — empty when it is right.
 *
 * @param {object} input
 * @param {Array<{cloud: string, component: string, knob: string, issue?: string | undefined, docs?: string | undefined, carriage?: string | undefined}>} input.ceilings
 * @param {Array<{cloud: string, component: string, name: string}>} input.declared  every manifest entry
 * @param {Array<{cloud: string, component: string, name: string}>} input.dead      declared, reachable, read by nothing
 * @param {Array<{cloud: string, component: string, knob: string}>} input.otherLedgers  `dead:` + `reported:` entries
 * @param {Array<{field: string, cloud: string}>} input.carriageExclusions
 * @returns {Array<{ title: string, detail: string }>}
 */
export function ceilingFindings({ ceilings, declared, dead, otherLedgers, carriageExclusions }) {
	/** @type {Array<{ title: string, detail: string }>} */
	const findings = [];
	/** @param {string} title @param {string} detail */
	const fail = (title, detail) => findings.push({ title, detail });
	for (const x of ceilings) {
		const id = `${x.cloud}/${x.component}/${x.knob}`;
		const issueOk = typeof x.issue === "string" && /^#\d+$/.test(x.issue);
		const docsOk = typeof x.docs === "string" && /^https:\/\/\S+$/.test(x.docs);
		if (!issueOk && !docsOk) {
			fail(
				`ledger \`ceiling:\` entry ${id} carries no evidence`,
				"A ceiling is a claim about a provider's product. Add `issue: \"#<n>\"` naming where it was settled, or " +
					"`docs: https://…` pointing at the provider's own documentation of the limit.",
			);
		}
		if (!x.carriage) {
			fail(
				`ledger \`ceiling:\` entry ${id} names no \`carriage:\` cell`,
				"Name the `<kind>.<column>` cell (e.g. `dns.managed_certificate`) so the check can confirm " +
					"infra/config-carriage-exclusions.yaml records the same ceiling for this cloud.",
			);
		} else if (!carriageExclusions.some((e) => e.field === x.carriage && (e.cloud === x.cloud || e.cloud === "*"))) {
			fail(
				`ledger \`ceiling:\` entry ${id} has no matching carriage exclusion`,
				`infra/config-carriage-exclusions.yaml has no \`exclusions:\` entry for \`${x.carriage}\` on ${x.cloud}. ` +
					"Either the ceiling is real and that ledger should say so too, or it is not a ceiling and belongs in " +
					"`dead:` as backlog. Two ledgers disagreeing about one cloud is the state this rule forbids.",
			);
		}
		if (!declared.some((k) => same(x, k))) {
			fail(
				`ledger \`ceiling:\` entry ${id} names a knob that is not declared`,
				"The template no longer declares it (or it is attributed to another component). A decision about a " +
					"variable that does not exist is a decision about nothing — delete the entry.",
			);
			continue;
		}
		if (!dead.some((k) => same(x, k))) {
			fail(
				`ledger \`ceiling:\` entry ${id} is READ by a resource — it became wireable`,
				"Something in the template now consumes this knob, so the provider was not the ceiling after all. " +
					"Delete the entry (and revisit the matching carriage exclusion): a ceiling that is being honoured is a " +
					"false statement on two public boards.",
			);
		}
		if (otherLedgers.some((o) => o.cloud === x.cloud && o.component === x.component && o.knob === x.knob)) {
			fail(
				`ledger \`ceiling:\` entry ${id} is also listed under \`dead:\` or \`reported:\``,
				"One knob, two contradictory decisions. Keep exactly one.",
			);
		}
	}
	return findings;
}

/**
 * Prove `ceilingFindings` can go red — once per rule — and stays green on a correct entry.
 *
 * Throws, never returns a flag: a guard whose adjudication silently stopped finding anything reports
 * a clean ledger forever, and the only defence is to make it fail against a case known to be wrong
 * BEFORE it is trusted with the real one.
 */
export function selfCheck() {
	const knob = { cloud: "c", component: "dns", name: "k" };
	const good = { cloud: "c", component: "dns", knob: "k", issue: "#1", carriage: "dns.k" };
	const base = {
		ceilings: [good],
		declared: [knob],
		dead: [knob],
		otherLedgers: [],
		carriageExclusions: [{ field: "dns.k", cloud: "c" }],
	};
	/** Abort with the rule that did not fire. */
	const expectRed = (label, input, pattern) => {
		const got = ceilingFindings({ ...base, ...input });
		if (!got.some((f) => pattern.test(f.title))) {
			throw new Error(`knob-ceilings self-check failed: ${label} did not go red (got ${JSON.stringify(got.map((f) => f.title))}). Do not trust this run.`);
		}
	};
	const clean = ceilingFindings(base);
	if (clean.length) throw new Error(`knob-ceilings self-check failed: a correct entry went red: ${clean.map((f) => f.title).join("; ")}`);
	if (ceilingFindings({ ...base, ceilings: [{ ...good, issue: undefined, docs: "https://example.com/limit" }] }).length) {
		throw new Error("knob-ceilings self-check failed: a `docs:` link was not accepted as evidence");
	}
	expectRed("missing evidence", { ceilings: [{ ...good, issue: undefined }] }, /no evidence/);
	expectRed("a non-issue `issue:`", { ceilings: [{ ...good, issue: "soon" }] }, /no evidence/);
	expectRed("missing carriage cell", { ceilings: [{ ...good, carriage: undefined }] }, /names no `carriage:`/);
	expectRed("no carriage exclusion", { carriageExclusions: [{ field: "dns.k", cloud: "other" }] }, /no matching carriage exclusion/);
	expectRed("an undeclared knob", { declared: [] }, /not declared/);
	expectRed("a knob that became read", { dead: [] }, /became wireable/);
	expectRed("a knob in two sections", { otherLedgers: [{ cloud: "c", component: "dns", knob: "k" }] }, /also listed/);
	const parsed = readCarriageExclusions("exclusions:\n  - field: dns.k\n    cloud: c\nbaseline:\n  - field: dns.x\n    cloud: c\n");
	if (parsed.length !== 1 || parsed[0].field !== "dns.k") {
		throw new Error(`knob-ceilings self-check failed: the carriage reader must read \`exclusions:\` and nothing else, read ${JSON.stringify(parsed)}`);
	}
}
