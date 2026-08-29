// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The measuring half of check-resource-fit.sh. See that file for why this exists.

import fs from "node:fs";
import { execSync } from "node:child_process";

// Usage: resource-fit.mjs <allowlist> <ceilingMi> <fixture[::prefix]> [<fixture[::prefix]> …]
//
// MORE THAN ONE FIXTURE, because the marketplace catalogue is not the only place this repo renders
// a chart: `hetzner-services.ts` renders nine more for the data-service node KINDS (#3299). Ids are
// namespaced per source, since the two fixtures are independent id spaces — the marketplace `vault`
// is a different release from the data-service `secrets-vault`.
const [allowPath, ceilingArg, ...fixtureArgs] = process.argv.slice(2);
const ceilingMi = Number(ceilingArg);

/** Kubernetes quantity → MiB. Returns null for anything unparseable, which is reported, never
 *  silently treated as zero — a unit this does not understand would make a huge pod look free. */
function toMi(q) {
	const m = String(q).trim().match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T|e\d+)?$/);
	if (!m) return null;
	const v = parseFloat(m[1]);
	const unit = m[2] ?? "";
	const table = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1024 ** 2 * 1024, M: 1000 ** 2 / 1024 ** 2, G: 1000 ** 3 / 1024 ** 2, T: 1000 ** 4 / 1024 ** 2 };
	if (unit === "") return v / 1024 / 1024; // bare bytes
	return table[unit] !== undefined ? v * table[unit] : null;
}

if (fixtureArgs.length === 0) {
	console.error("::error::check-resource-fit: no fixture given — nothing would be checked");
	process.exit(1);
}
const specs = [];
const perSource = [];
for (const arg of fixtureArgs) {
	const [path, prefix = ""] = arg.split("::");
	const raw = JSON.parse(fs.readFileSync(path, "utf8"));
	const list = Array.isArray(raw) ? raw : (raw.addons || raw.specs || Object.values(raw)[0]);
	// PER SOURCE, not on the total. One combined count would let a half go to zero — a renamed
	// fixture key, an exporter writing `[]` — while the number still looked healthy, which is the
	// "found nothing == nothing wrong" collapse this guard family exists to refuse.
	if (!Array.isArray(list) || list.length === 0) {
		console.error(`::error::check-resource-fit: ${path} yielded no specs — that half was not checked`);
		process.exit(1);
	}
	// The `id` is namespaced for reporting and for the allowlist; `release` keeps the name that
	// actually ships, because a chart can derive rendered content from its release name.
	for (const s of list) specs.push({ ...s, id: prefix + s.id, release: s.id });
	perSource.push(`${list.length} from ${path.split("/").pop()}`);
}

const declared = new Map();
for (const line of fs.readFileSync(allowPath, "utf8").split("\n")) {
	const t = line.trim();
	if (t === "" || t.startsWith("#")) continue;
	declared.set(t.split(/\s+/)[0], true);
}

const fail = [];
const over = new Set();
let podsSeen = 0;
const tmp = fs.mkdtempSync("/tmp/resfit-");

for (const s of specs) {
	fs.writeFileSync(`${tmp}/values.json`, JSON.stringify(s.values ?? {}));
	// Retried, then FATAL. A chart that does not render is a chart that was not checked, and a
	// printed skip is how coverage shrinks while the summary still says OK — the exact shape this
	// guard exists to catch. The retry is because the failure observed in practice was a transient
	// `500 Internal Server Error` fetching the .tgz from GitHub releases, which is not a finding
	// about the chart and must not red a PR on its own.
	let rendered = null;
	let lastErr = "";
	for (let attempt = 0; attempt < 3 && rendered === null; attempt++) {
		try {
			rendered = execSync(
				`helm template ${s.release ?? s.id} ${s.chart} --repo ${s.chartRepo} --version ${s.version} -n ${s.namespace || s.release || s.id} -f ${tmp}/values.json`,
				{ maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] },
			).toString();
		} catch (e) {
			lastErr = String(e.stderr ?? e.message ?? "").trim().split("\n").slice(-1)[0];
		}
	}
	if (rendered === null) {
		console.log(`  ${"RENDER FAILED".padEnd(14)} ${"".padStart(6)}    ${s.id}`);
		fail.push(`${s.id} did not render after 3 attempts, so it was NOT checked: ${lastErr}`);
		continue;
	}

	// Largest single `requests.memory` in the chart's rendered pod specs. Per POD, because a pod
	// over the ceiling cannot schedule at ANY cluster size.
	let worst = 0;
	const lines = rendered.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (!/^\s*requests:\s*$/.test(lines[i])) continue;
		for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
			const m = lines[j].match(/^\s*memory:\s*"?([^"\s]+)"?\s*$/);
			if (m) {
				podsSeen++;
				const mi = toMi(m[1]);
				if (mi === null) {
					fail.push(`${s.id}: could not parse the memory quantity ${JSON.stringify(m[1])} — refusing to treat an unreadable request as small`);
				} else if (mi > worst) worst = mi;
				break;
			}
			if (/^\s*\S+:\s*$/.test(lines[j]) && !/^\s*(cpu|memory|ephemeral)/.test(lines[j])) break;
		}
	}

	const isOver = worst > ceilingMi;
	if (isOver) over.add(s.id);
	const state = isOver ? (declared.has(s.id) ? "over (declared)" : "OVER CEILING") : "fits";
	console.log(`  ${state.padEnd(14)} ${String(Math.round(worst)).padStart(6)} Mi  ${s.id}`);
	if (isOver && !declared.has(s.id)) {
		fail.push(`${s.id} renders a pod requesting ${Math.round(worst)}Mi, over the ${ceilingMi}Mi ceiling — no default node can hold it, so it will sit Pending forever. Lower it in the catalog, or declare it in ${allowPath} with the reason.`);
	}
}

// A render that found no requests at all means the extractor stopped matching, and every
// comparison above silently passed. Fatal, and checked explicitly.
if (podsSeen === 0) {
	fail.push("no memory requests were found in ANY rendered chart — the extractor has stopped matching, so NOTHING was checked");
}

// Ratchet, the other direction.
for (const id of declared.keys()) {
	if (!specs.some((s) => s.id === id)) {
		fail.push(`${id} is declared in ${allowPath} but is no longer in the catalog — remove the stale line`);
	} else if (!over.has(id)) {
		fail.push(`${id} is declared over-ceiling but now fits — remove the line, so the list can only shrink`);
	}
}

console.log(`\nchecked ${specs.length} chart render(s) (${perSource.join(" + ")}), ${podsSeen} pod spec(s), ceiling ${ceilingMi}Mi per pod`);
if (fail.length > 0) {
	for (const f of fail) console.error(`::error::check-resource-fit: ${f}`);
	console.error(`\ncheck-resource-fit: ${fail.length} problem(s).`);
	process.exit(1);
}
console.log("OK — every chart this repo renders, from either source, has its largest pod under the ceiling, and the allowlist is exact");
