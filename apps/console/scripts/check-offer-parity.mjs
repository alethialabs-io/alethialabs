// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Offer-parity guard: nothing the canvas OFFERS may be unbuildable on a cloud without a recorded
// exclusion. This is the cloud-parity rule from CLAUDE.md made mechanical.
//
// It exists because the class kept shipping. Four instances found by hand in one sitting, in three
// different shapes — and each one presents to a user identically: pick it, get silence or something
// else. So the guard checks the three shapes rather than one:
//
//   A · NO CARRIER        an offered variant axis the provider never even READS. The cache engine
//                         (redis/valkey) is a first-class choice on the canvas, `ProjectCacheConfig`
//                         carries an `Engine` field for it, and not one of the five providers looks
//                         at it — the choice is dropped between the canvas and the plan.
//   B · MISSING BRANCH    where a template BRANCHES on a variant, every offered variant needs a
//                         branch. Azure's azure-db gates every resource on `is_postgres`, so the
//                         MySQL the canvas offers provisions nothing (#1382).
//
// What this deliberately does NOT flag: a template variable the provider doesn't set by default.
// `mergeProviderConfig` (packages/core/cloud/aws_provider.go) copies any `provider_config` JSONB key
// onto a same-named tofu variable, so every DECLARED variable is already reachable. An early version
// of this guard reported 14 "dead toggles" that were all working as designed — the escape hatch is
// the feature, and a guard that fights it would be turned off within a week.
//
// The defect is narrower than "the console can't set it": it is a choice the product presents as
// first-class and then discards.
//
// Passthrough is NOT a gap: a template that hands `engine` straight to the provider (AWS RDS,
// Alibaba RDS) supports every value its API does, so check B only fires where the template itself
// enumerates. That distinction is the whole reason this can run in CI without crying wolf.
//
// Both sides are DERIVED, never hand-listed — the offers from the frontend's own sources, the
// implementations from the templates and the tfvars builders. A hand-list would drift the same way
// the thing it is guarding drifted.
//
// Exclusions live in infra/offer-exclusions.yaml, one reasoned line each (Hetzner runs data services
// in-cluster; Azure has no Valkey product). An exclusion is a decision on the record, not a mute —
// the generated matrix prints them as documented exclusions.
//
// Run from apps/console (`pnpm -F console check:offer-parity`). `--matrix` writes the living board to
// docs/testing/offer-parity.md instead of just reporting.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "../..";
const TEMPLATES = `${ROOT}/infra/templates/project`;
const PROVIDERS = `${ROOT}/packages/core/cloud`;
const EXCLUSIONS = `${ROOT}/infra/offer-exclusions.yaml`;
const MATRIX_OUT = `${ROOT}/docs/testing/offer-parity.md`;
const NODE_REGISTRY = "components/design-project/canvas/graph/node-registry.ts";

const writeMatrix = process.argv.includes("--matrix");

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** Strip `#` and `//` line comments so a COMMENTED-OUT resource never counts as an implementation.
 * That distinction is load-bearing: azure-db's MySQL "implementation" is a commented placeholder. */
function stripComments(src) {
	return src
		.split("\n")
		.map((l) => l.replace(/(^|\s)(#|\/\/).*$/, ""))
		.join("\n");
}

/** Every .tf file under a directory, recursively, comments stripped. */
function readTf(dir) {
	if (!existsSync(dir)) return "";
	let out = "";
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".terraform") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) out += readTf(full);
		else if (e.name.endsWith(".tf")) out += `\n${stripComments(readFileSync(full, "utf8"))}`;
	}
	return out;
}

/** The clouds that ship a provisioning template. Hetzner has none by design (in-cluster charts). */
const CLOUDS = readdirSync(TEMPLATES, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

const tf = Object.fromEntries(CLOUDS.map((c) => [c, readTf(`${TEMPLATES}/${c}`)]));
const goSrc = Object.fromEntries(
	CLOUDS.map((c) => {
		const p = `${PROVIDERS}/${c}_provider.go`;
		return [c, existsSync(p) ? stripComments(readFileSync(p, "utf8")) : ""];
	}),
);

/** tfvars keys a cloud's provider actually emits.
 *
 * Two forms, and missing either one turns this guard into a false-alarm generator: the bracket
 * assignment (`tfvars["create_cloud_sql"] = …`) and the map literal the builder returns
 * (`"create_rds": len(config.Databases) > 0`). Collecting quoted keys broadly is the conservative
 * direction — it can only make the guard quieter, never noisier. */
const emitted = Object.fromEntries(
	CLOUDS.map((c) => [
		c,
		new Set([
			...[...goSrc[c].matchAll(/tfvars\["([a-z0-9_]+)"\]/g)].map((m) => m[1]),
			...[...goSrc[c].matchAll(/"([a-z0-9_]+)":/g)].map((m) => m[1]),
		]),
	]),
);

// ── the offer side: derived from the frontend, never hand-listed ─────────────────────

/** Variant axes the canvas offers, read out of NODE_REGISTRY (`database` → postgres|mysql, …). */
function offeredVariants() {
	const src = readFileSync(NODE_REGISTRY, "utf8");
	const body = src.slice(src.indexOf("export const NODE_REGISTRY"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const axes = {};
	for (let i = 0; i < kinds.length; i++) {
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		const v = seg.match(/variants:\s*\{/);
		if (!v) continue;
		const values = [...seg.slice(v.index).matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
		if (values.length) axes[kinds[i][1]] = values;
	}
	return axes;
}

const AXES = offeredVariants();

/** The per-cloud floor the canvas itself applies (`variantOptionsFor` → HETZNER_VARIANT_VALUES).
 *
 * Read rather than reimplemented, so this guard asks about exactly what the product offers. Without
 * it the matrix would carry a "documented exclusion" for Hetzner MySQL — an engine the canvas never
 * shows on Hetzner — which is worse than useless: it implies we considered offering it. */
function cloudFloor() {
	const src = readFileSync(NODE_REGISTRY, "utf8");
	// The floor names the engine lists; the lists themselves live with the Hetzner chart mapper that
	// owns that truth (HETZNER_DB_ENGINES / HETZNER_CACHE_ENGINES), so both files are read.
	const sources = src + readFileSync("lib/cloud-providers/hetzner-services.ts", "utf8");
	const floors = {};
	const block = src.match(/HETZNER_VARIANT_VALUES[^=]*=\s*\{([\s\S]*?)\n\};/);
	if (!block) return floors;
	for (const m of block[1].matchAll(/(\w+):\s*new Set<string>\((\w+)\)/g)) {
		const decl = sources.match(new RegExp(`${m[2]}\\s*=\\s*\\[([^\\]]+)\\]`));
		if (decl) {
			floors.hetzner ??= {};
			floors.hetzner[m[1]] = new Set([...decl[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
		}
	}
	return floors;
}

const FLOOR = cloudFloor();

/** Is this variant offered at all on this cloud? */
function offeredOn(cloud, kind, variant) {
	const allowed = FLOOR[cloud]?.[kind];
	return allowed ? allowed.has(variant) : true;
}

// ── exclusions ──────────────────────────────────────────────────────────────────────

/** Minimal reader for the flat `- offer: … cloud: … reason: …` list (no YAML dep in this package). */
function readExclusions() {
	if (!existsSync(EXCLUSIONS)) return [];
	const out = [];
	let cur = null;
	let section = "exclusions";
	for (const raw of readFileSync(EXCLUSIONS, "utf8").split("\n")) {
		// Only FULL-LINE comments are stripped. An inline strip would eat the `#` of `issue: "#1420"`
		// and silently drop every tracking link — the matrix would print a bare 🚫 with nowhere to go.
		if (/^\s*#/.test(raw)) continue;
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		const head = line.match(/^(exclusions|baseline):\s*$/);
		if (head) {
			if (cur) { out.push(cur); cur = null; }
			section = head[1];
			continue;
		}
		const start = line.match(/^\s*-\s+(\w+):\s*(.+)$/);
		if (start) {
			if (cur) out.push(cur);
			cur = { section, [start[1]]: start[2].trim().replace(/^["']|["']$/g, "") };
			continue;
		}
		const kv = line.match(/^\s+(\w+):\s*(.+)$/);
		if (kv && cur) cur[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	if (cur) out.push(cur);
	return out;
}

const allEntries = readExclusions();
const exclusions = allEntries.filter((e) => e.section === "exclusions");
const baseline = allEntries.filter((e) => e.section === "baseline");

const excluded = (offer, cloud) =>
	exclusions.find((e) => e.offer === offer && (e.cloud === cloud || e.cloud === "*"));
const baselined = (offer, cloud) =>
	baseline.find((e) => e.offer === offer && (e.cloud === cloud || e.cloud === "*"));

// ── check B · missing branch ────────────────────────────────────────────────────────
// Where a template ENUMERATES the values of a variant it branches on, that enumeration is the
// supported set. A passthrough template (AWS RDS, Alibaba RDS — `engine = var.engine`) enumerates
// nothing and supports whatever its API does, so it is correctly never flagged.

/** The variant values a cloud's template enumerates for THIS axis, or null when it passes through.
 *
 * An enumeration counts as being "about" an axis only if its values intersect that axis's vocabulary.
 * Without that test the database's `is_postgres` branch leaks onto the cache axis and the guard
 * cheerfully reports that "the azure template enumerates postgres/mysql for cache" — which is how the
 * first draft of this read. Intersecting is also why no kind→module mapping is needed: the values
 * identify the axis, so the scan can stay whole-template and stupid. */
function enumeratedValues(cloud, axisValues) {
	const src = tf[cloud];
	const axis = new Set(axisValues.map((v) => v.toLowerCase()));
	const onAxis = (set) => new Set([...set].map((h) => h.toLowerCase()).filter((v) => axis.has(v)));

	// BRANCHED — the values the template actually builds something for: an equality branch or a
	// lookup map. This is the only evidence that counts as an implementation.
	const branched = new Set();
	for (const m of src.matchAll(/var\.(?:\w*engine\w*)\s*==\s*"([A-Za-z0-9_]+)"/g)) branched.add(m[1]);
	for (const m of src.matchAll(/engine_map\s*=\s*\{([^}]+)\}/g)) {
		for (const v of m[1].matchAll(/(\w+)\s*=/g)) branched.add(v[1]);
	}

	// CLAIMED — the values a `validation { contains([…]) }` block accepts. Deliberately NOT treated as
	// implementation: azure-db validates `contains(["postgres", "mysql"], var.engine)` and then gates
	// every single resource on `is_postgres`. The variable's own validation advertises support the
	// module does not have, which is precisely how #1382 read as fine to anyone skimming the template.
	const claimed = new Set();
	for (const m of src.matchAll(/contains\(\[([^\]]+)\],\s*var\.\w*engine\w*\)/g)) {
		for (const v of m[1].matchAll(/"([A-Za-z0-9_]+)"/g)) claimed.add(v[1]);
	}

	const b = onAxis(branched);
	return b.size > 0 ? { supported: b, claimed: onAxis(claimed) } : null;
}

// ── check C · no carrier ────────────────────────────────────────────────────────────
// The axis has to reach tofu at all. If no emitted tfvar is derived from the engine family, the
// user's choice is dropped between the canvas and the plan.

/** Does the provider READ the engine the user chose for this kind, anywhere?
 *
 * Not "does it emit a tfvar whose name contains 'engine'" — AWS carries the DB engine inside the
 * `rds_config` object, so a name-shaped test calls a working path broken. Not a windowed scan around
 * `config.Databases` either: the providers touch that collection twice (once in the map literal for
 * `create_*`, once in the detail block), so a naive split lands on the gap between them and reports
 * every cloud as broken. Reading the field is the honest minimum — a provider that never looks at the
 * choice cannot be carrying it.
 *
 * The receiver names are the discriminator: every provider does `db := config.Databases[0]` /
 * `cache := config.Caches[0]`, so `db.Engine…` and `cache.Engine…` are unambiguous per axis. */
const CARRIER_READS = {
	database: /resolveDBEngine|db\.EngineFamily|db\.Engine\b/,
	cache: /resolveCacheEngine|cache\.EngineFamily|cache\.Engine\b/,
};

function hasCarrier(cloud, kind) {
	const probe = CARRIER_READS[kind];
	if (!probe) return true;
	return probe.test(goSrc[cloud]);
}

// ── run ─────────────────────────────────────────────────────────────────────────────

const findings = [];
const knownDebt = [];
const cells = []; // for the matrix

for (const [kind, variants] of Object.entries(AXES)) {
	for (const cloud of CLOUDS) {
		const carrier = hasCarrier(cloud, kind);
		const enumerated = enumeratedValues(cloud, variants);
		for (const variant of variants) {
			const offer = `${kind}:${variant}`;
			const exc = excluded(offer, cloud);
			let state = "ok";
			let detail = "";
			if (!offeredOn(cloud, kind, variant)) {
				// Not offered on this cloud at all — the canvas floor already hides it. Not a gap, and
				// not an exclusion either: there is nothing to exclude from.
				cells.push({ kind, variant, cloud, state: "not-offered", detail: "" });
				continue;
			}
			if (exc) {
				state = "excluded";
				detail = exc.reason ?? "";
			} else if (!carrier) {
				state = "no-carrier";
				detail = `the ${kind} engine never reaches tfvars on ${cloud} — the choice is dropped between the canvas and the plan.`;
			} else if (enumerated && !enumerated.supported.has(variant.toLowerCase())) {
				state = "missing-branch";
				const advertised = enumerated.claimed.has(variant.toLowerCase())
					? ` The variable's own validation accepts "${variant}", which is why this reads as supported to anyone skimming the template.`
					: "";
				detail =
					`the ${cloud} template branches to ${[...enumerated.supported].join("/")} for ${kind} — ` +
					`${variant} has no branch, so selecting it provisions nothing.${advertised}`;
			}
			const known = state !== "ok" && state !== "excluded" ? baselined(offer, cloud) : null;
			cells.push({ kind, variant, cloud, state, detail, known });
			if (state !== "ok" && state !== "excluded") {
				(known ? knownDebt : findings).push({ shape: state, cloud, offer, detail, known });
			}
		}
	}
}

// ── matrix ──────────────────────────────────────────────────────────────────────────

const GLYPH = {
	ok: "🟡",
	excluded: "—",
	"missing-branch": "🚫",
	"no-carrier": "🚫",
	"not-offered": "·",
};

if (writeMatrix) {
	const axes = Object.entries(AXES);
	let md = `<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- GENERATED by apps/console/scripts/check-offer-parity.mjs --matrix — do not edit by hand. -->

# Offer parity — what the canvas offers vs what each cloud can build

Every row is something a user can **choose**. Every cell is whether that cloud can honor it. The rule
this enforces is already in \`CLAUDE.md\`: a per-cloud change covers all clouds in the same pass, and a
cloud that cannot is an **explicit documented exclusion, never a silent gap**.

Deliberately finer-grained than [\`provisioning-e2e-parity.md\`](./provisioning-e2e-parity.md), whose
single "All kinds (11)" column is the granularity that let Azure MySQL hide: the kind was present, the
*variant* was not.

Legend: 🟡 implemented, not yet proven on a real apply · ✅ real-apply proof in the e2e ledger ·
🚫 offered but unbuildable (tracking issue in the cell) · — documented exclusion · · not offered on
this cloud (the canvas floor already hides it)

**A cell never goes ✅ from this generator.** It only knows what the code says; only the main-gated
nightly can promote a cell, and it does so in the e2e parity board.

`;
	for (const [kind, variants] of axes) {
		md += `\n## ${kind} engines\n\n| Offer | ${CLOUDS.join(" | ")} |\n|---|${CLOUDS.map(() => ":---:").join("|")}|\n`;
		for (const variant of variants) {
			const row = CLOUDS.map((c) => {
				const cell = cells.find((x) => x.kind === kind && x.variant === variant && x.cloud === c);
				// A 🚫 carries its tracking issue: a matrix that says "broken" without saying "and here
				// is where that is being handled" just becomes a wall of red people stop reading.
				return cell.known?.issue ? `${GLYPH[cell.state]} ${cell.known.issue}` : GLYPH[cell.state];
			});
			md += `| \`${variant}\` | ${row.join(" | ")} |\n`;
		}
	}


	if (exclusions.length) {
		md += `\n## Documented exclusions\n\n| Offer | Cloud | Reason |\n|---|---|---|\n`;
		for (const e of exclusions) md += `| \`${e.offer}\` | ${e.cloud} | ${e.reason ?? ""} |\n`;
	}

	md += `\n---\n\nRegenerate with \`pnpm -F console check:offer-parity -- --matrix\`. CI runs the guard on every PR.\n`;
	writeFileSync(MATRIX_OUT, md);
	console.log(`✓ wrote ${MATRIX_OUT}`);
}

// ── report ──────────────────────────────────────────────────────────────────────────

// The ratchet: a baseline entry whose finding is GONE means the gap was fixed, so the entry has to
// go with it. Without this the baseline rots into a permanent amnesty and the guard quietly stops
// meaning anything — the failure mode of every "known issues" list ever written.
const stale = baseline.filter(
	(b) => !knownDebt.some((f) => f.offer === b.offer && (b.cloud === "*" || f.cloud === b.cloud)),
);

if (knownDebt.length) {
	console.log(`  ${knownDebt.length} known gap(s) on the baseline (tracked, not failing):`);
	for (const f of knownDebt) {
		console.log(`    · ${f.cloud} ${f.offer}${f.known?.issue ? `  → ${f.known.issue}` : ""}`);
	}
}

if (stale.length) {
	console.error(`\n✗ offer parity — ${stale.length} baseline entr(y|ies) no longer reproduce:\n`);
	for (const b of stale) console.error(`  ${b.cloud} · ${b.offer}${b.issue ? `  (${b.issue})` : ""}`);
	console.error(`
Fixed — thank you. Now delete these from the \`baseline:\` section of infra/offer-exclusions.yaml so the
list keeps meaning what it says. The baseline ratchets down; it never grows on its own.
`);
	process.exit(1);
}

if (findings.length === 0) {
	console.log(
		`✓ offer parity — ${cells.length} (offer × cloud) cells, ${exclusions.length} documented exclusion(s), ` +
			`${baseline.length} on the baseline, no NEW silent gaps.`,
	);
	process.exit(0);
}

console.error(`\n✗ offer parity — ${findings.length} NEW offer(s) the product presents but a cloud cannot build:\n`);
for (const f of findings) {
	console.error(`  [${f.shape}] ${f.cloud} · ${f.offer}`);
	console.error(`      ${f.detail}`);
}
console.error(`
Each of these is the state the cloud-parity rule forbids: offered, unbuildable, and silent.
Do one of three things — never a fourth:
  · fix it, so the offer builds;
  · record an EXCLUSION in infra/offer-exclusions.yaml, if the cloud genuinely cannot ever honor it;
  · add it to the BASELINE there with its tracking issue, if it is real work that is already boarded.
`);
process.exit(1);
