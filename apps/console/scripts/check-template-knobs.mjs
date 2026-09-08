// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The guard CUSTOMIZABILITY-PARITY.md said could not exist.
//
// That page's closing paragraph read: "no guard can red any cell on this page, and no deferral here
// can ever go stale the way a `baseline:` entry does." It was true when it was written — the offer
// guard measures canvas switches and the carriage guard measures user-settable columns, and a
// template variable reached through `provider_config` is neither. It is not true any more, and the
// reason it stopped being true is #4259: once the passthrough covers every leaf component, the
// question "is this knob reachable" has a derivable answer on every cloud.
//
// Four rules. Each one is a way the template can be advertising something it does not deliver:
//
//   1. DECLARED, REACHABLE, READ BY NOTHING. The `gke_spot` shape: the variable exists, a user can
//      set it, and no resource or module argument consumes it. `gke_spot` shipped `default = true`,
//      so the template advertised Spot node pools it never provisioned — and a raw variable count
//      credited that dead declaration exactly as much as a working knob. Listed in the ledger's
//      `dead:` section or the build fails; a ledger entry that is no longer dead ALSO fails, so the
//      list can only shrink.
//   2. DECLARED FOR A COMPONENT WITH NO PASSTHROUGH. The knob exists and nothing can reach it —
//      the "unwired template" state check-offer-parity.mjs is built to catch, one level down. Some
//      of these are ceilings (hetzner runs six services in-cluster, where a chart value is not a
//      tfvar); the rest are gaps. Both are recorded in `cells:`, and each entry says which it is.
//   3. THE COMMITTED FILES ARE THE MEASUREMENT. Regenerating must produce byte-identical output —
//      the manifest is what the console's card UI reads, so a stale one is a UI offering knobs the
//      templates no longer have.
//   4. TRIPWIRES. A per-cloud floor on the knob count, zero unattributed variables, zero unresolved
//      passthrough sites, and no stale ledger entry. Every rule above is a search for something
//      MISSING, and a reader that stopped reading finds nothing missing — which is indistinguishable
//      from a clean build. The floors are the difference.
//
// Run from apps/console: `pnpm -F console check:template-knobs`.

import { existsSync, readFileSync } from "node:fs";

import {
	CLOUDS,
	DOC_OUT,
	EXCLUDED,
	JSON_OUT,
	PASSTHROUGH,
	deadKnobs,
	docText,
	entries,
	jsonText,
	manifest,
	unattributed,
	uncoveredCells,
} from "./gen-template-knobs.mjs";

/** The floor under each cloud's knob count.
 *
 * A TRIPWIRE, not a target, and the same bargain check-config-carriage takes with `COLUMNS_FLOOR`:
 * chosen well under today's count so ordinary template churn does not trip it, and well over zero so
 * a reader that stopped matching does. Today: alibaba 63, aws 159, azure 90, gcp 104, hetzner 37. */
const FLOORS = { alibaba: 50, aws: 130, azure: 75, gcp: 85, hetzner: 30 };

const failures = [];
/** Record one failure with the action that clears it — a finding whose fix is not stated gets
 * cleared by whatever the next reader guesses. */
const fail = (title, detail) => failures.push({ title, detail });

// ── everything measured is printed BEFORE anything is adjudicated ───────────────────

console.log(`template knobs — ${entries.length} across ${CLOUDS.length} clouds (${CLOUDS.join(", ")}).`);
for (const c of CLOUDS) {
	const n = manifest.counts[c];
	console.log(
		`  ${c.padEnd(8)} declared ${String(n.declared).padStart(3)}  reachable ${String(n.reachable).padStart(3)}  ` +
			`settable ${String(n.settable).padStart(3)}  declared-and-dead ${n.dead}`,
	);
}
console.log(
	`\n· \`provider_config\` passthrough reaches: ${CLOUDS.map((c) => `${c} → ${[...(PASSTHROUGH.byCloud[c]?.keys() ?? [])].sort().join("/") || "nothing"}`).join(", ")}.`,
);

// ── rule 4 · the tripwires, first, because every other rule searches for something MISSING ──

for (const c of CLOUDS) {
	const floor = FLOORS[c];
	if (floor === undefined) {
		fail(
			`${c} has no knob floor`,
			`A cloud with no entry in FLOORS is a cloud whose knob surface could fall to zero without ` +
				`anything failing. Add \`${c}\` to FLOORS in this file, well under its current count of ${manifest.counts[c].declared}.`,
		);
		continue;
	}
	if (manifest.counts[c].declared < floor) {
		fail(
			`${c} declares ${manifest.counts[c].declared} knobs, below its floor of ${floor}`,
			"The reader has stopped matching (a formatting change, a moved file) — it is not that the template lost " +
				"three quarters of its variables. A guard measuring an empty surface reports success on nothing. Fix the " +
				"reader; lower the floor only when the template genuinely shrank, and say why in the commit.",
		);
	}
}

if (unattributed.length) {
	fail(
		`${unattributed.length} root variable(s) belong to no component`,
		`${unattributed.map((u) => `${u.cloud}:${u.name}`).join(", ")}. Add the module dir or root file to the ` +
			"generator's tables, or record the variable in infra/templates/project/knob-exclusions.yaml with a reason.",
	);
}

if (PASSTHROUGH.unresolved.length) {
	fail(
		`${PASSTHROUGH.unresolved.length} \`merge*ProviderConfig\` call site(s) could not be attributed to a component`,
		`${PASSTHROUGH.unresolved.map((u) => `${u.cloud}:${u.fn}:${u.expr}`).join(", ")}. In check-config-carriage an ` +
			"unread site only loses context; HERE it decides whether a knob is reachable, so an unread site silently " +
			"marks a working knob unreachable. Teach lib/go-passthrough.mjs the shape.",
	);
}

// A ledger entry naming a variable the template no longer declares is a decision about nothing. It
// reads as an active exception and is one more line the next reader must understand before they can
// change anything.
for (const e of EXCLUDED.filter((x) => x.section === "variables")) {
	if (!entries.some((k) => k.cloud === e.cloud && k.name === e.variable)) {
		fail(
			`stale ledger entry: ${e.cloud}:${e.variable}`,
			"No such variable is declared by that template any more. Delete the entry from " +
				"infra/templates/project/knob-exclusions.yaml — the list can only shrink.",
		);
	}
}

// ── rule 2 · a component whose knobs nothing can reach ──────────────────────────────

for (const cell of uncoveredCells) {
	if (cell.excluded) continue;
	const n = entries.filter((e) => e.cloud === cell.cloud && e.component === cell.component).length;
	fail(
		`${cell.cloud} declares ${n} knob(s) for \`${cell.component}\` and no passthrough reaches them`,
		"Either wire the component's `provider_config` in packages/core/cloud (one merge call), or record the cell in " +
			"infra/templates/project/knob-exclusions.yaml under `cells:` with a reason saying whether it is a ceiling " +
			"(the cloud has no analogue) or a gap (it is simply not wired yet).",
	);
}

// The other direction: a recorded cell that HAS gained a passthrough is a decision that has been
// overtaken. Left in place it would keep a real, reachable surface out of the guard's reach.
for (const e of EXCLUDED.filter((x) => x.section === "cells")) {
	const covered = CLOUDS.filter((c) => (e.cloud === "*" || e.cloud === c) && uncoveredCells.every((u) => !(u.cloud === c && u.component === e.component)))
		// A cell with no knobs at all is neither covered nor uncovered — hetzner declares nothing for
		// `queue`, and its ceiling entry is what says why. Only a cell the manifest actually names can
		// contradict the ledger.
		.filter((c) => entries.some((k) => k.cloud === c && k.component === e.component));
	if (covered.length) {
		fail(
			`ledger cell ${e.cloud}/${e.component} is reached after all (${covered.join(", ")})`,
			"A passthrough now lands on it, so the recorded reason no longer holds. Delete the entry — the list can only shrink.",
		);
	}
}

// ── rule 1 · declared, reachable, read by nothing ───────────────────────────────────

const deadLedger = EXCLUDED.filter((x) => x.section === "dead");
for (const d of deadKnobs) {
	if (deadLedger.some((x) => x.cloud === d.cloud && x.component === d.component && x.knob === d.name)) continue;
	fail(
		`${d.cloud}/${d.component}: \`${d.name}\` is declared, reachable, and read by nothing`,
		`Declared at ${d.declaredAt}. A user can set it and no resource or module argument consumes it — the template ` +
			"advertises a knob it does not honour. Wire it into the module, DELETE the declaration, or record it under " +
			"`dead:` in infra/templates/project/knob-exclusions.yaml as backlog.",
	);
}
for (const x of deadLedger) {
	if (deadKnobs.some((d) => d.cloud === x.cloud && d.component === x.component && d.name === x.knob)) continue;
	fail(
		`ledger \`dead:\` entry ${x.cloud}/${x.component}/${x.knob} is not dead`,
		"It is now read, or no longer declared. Delete the entry — the backlog can only shrink, and a fixed knob left " +
			"listed here is a defect the board still believes in.",
	);
}

// ── rule 3 · the committed files ARE the measurement ────────────────────────────────

const stale = [];
if (!existsSync(JSON_OUT) || readFileSync(JSON_OUT, "utf8") !== jsonText) stale.push(JSON_OUT);
if (!existsSync(DOC_OUT) || readFileSync(DOC_OUT, "utf8") !== docText) stale.push(DOC_OUT);
if (stale.length) {
	fail(
		`generated file(s) are stale: ${stale.join(", ")}`,
		"Run `pnpm -F console gen:template-knobs` and commit. The console's card UI reads the manifest, so a stale one " +
			"offers knobs the templates no longer declare.",
	);
}

// ── the verdict, once, at the bottom ────────────────────────────────────────────────

if (!failures.length) {
	const dead = deadLedger.length;
	console.log(
		`\n· ${uncoveredCells.length} cell(s) with no passthrough and ${dead} declared-and-dead knob(s), every one recorded in ` +
			"infra/templates/project/knob-exclusions.yaml. Both lists can only shrink.",
	);
	console.log("\ntemplate-knobs: OK");
	process.exit(0);
}

console.error(`\ntemplate-knobs: ${failures.length} failure(s).\n`);
for (const f of failures) console.error(`  ✗ ${f.title}\n      ${f.detail}\n`);
process.exit(1);
