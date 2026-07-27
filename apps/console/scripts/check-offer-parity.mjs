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
const CONFIG_SCHEMA_SRC = "components/design-project/canvas/inspector/config-schema.ts";
const CATALOG = `${ROOT}/packages/core/catalog/catalog.json`;

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

/** Every .tf file under a directory, recursively, comments stripped, WITH its path.
 *
 * The day-2 scan needs the path the day-1 checks do not: `modules/redis/` and `modules/valkey/`
 * declare the same shape, and only where a declaration LIVES says which variant it backs. */
function readTfFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".terraform") continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...readTfFiles(full));
		else if (e.name.endsWith(".tf")) out.push({ path: full, text: stripComments(readFileSync(full, "utf8")) });
	}
	return out;
}

/** The clouds that ship a provisioning template. Hetzner has none by design (in-cluster charts). */
const CLOUDS = readdirSync(TEMPLATES, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

const tfFiles = Object.fromEntries(CLOUDS.map((c) => [c, readTfFiles(`${TEMPLATES}/${c}`)]));
const tf = Object.fromEntries(CLOUDS.map((c) => [c, tfFiles[c].map((f) => `\n${f.text}`).join("")]));
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

/** The per-cloud floor the canvas itself applies, read from the SAME source the canvas reads.
 *
 * This first parsed a `HETZNER_VARIANT_VALUES` constant out of node-registry.ts. #1420 deleted that
 * constant — the floor now derives from the catalog for every cloud — and the guard silently kept
 * passing while measuring the wrong thing: it went on believing Valkey was offered on Azure and
 * Alibaba after the canvas had stopped offering it.
 *
 * Reading `catalog.json` removes the class of failure rather than the instance. It is the SSOT both
 * the canvas floor and the cross-cloud converter derive from, it is plain JSON rather than TypeScript
 * to pattern-match, and a guard that reads a DIFFERENT source than the thing it guards is exactly how
 * the drift it exists to catch gets in.
 */
function cloudFloor() {
	const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
	const floors = {};
	for (const [cloud, provider] of Object.entries(catalog.database ?? {})) {
		floors[cloud] ??= {};
		floors[cloud].database = new Set((provider.engines ?? []).map((e) => e.family));
	}
	for (const [cloud, provider] of Object.entries(catalog.cache ?? {})) {
		floors[cloud] ??= {};
		floors[cloud].cache = new Set((provider.engines ?? []).map((e) => e.value));
	}
	return floors;
}

const FLOOR = cloudFloor();

/** Is this variant offered at all on this cloud?
 *
 * An EMPTY floor means the catalog has no slice for this cloud/kind — treated as "offered", matching
 * `variantOptionsFor`, which shows everything rather than an empty picker (#918). A missing slice is
 * not evidence that nothing is offered. */
function offeredOn(cloud, kind, variant) {
	const allowed = FLOOR[cloud]?.[kind];
	if (!allowed || allowed.size === 0) return true;
	return allowed.has(variant);
}

// ── the offer side, part 2: OPTION-level offers (`database:<engine>:iam_auth`) ───────
//
// A variant axis is not the only thing the canvas offers. `iam_auth` is a plain SWITCH in
// config-schema.ts with no `visibleWhen`, so the canvas presents keyless database auth on EVERY cloud
// for BOTH engines — and until #1500 several of those cells could not honor it. The guard could not
// see any of that: its whole vocabulary was `variants:` blocks, so shipping MySQL keyless broken was
// structurally un-catchable (#1508).
//
// Options are DERIVED, like everything else here: every unconditional `type: "switch"` field in
// CONFIG_SCHEMA. A field carrying `visibleWhen`/`requiresProvider` is already gated by the canvas, so
// it makes no cross-cloud promise and is skipped.
//
// TWO LIMITS, stated because a guard that looks more complete than it is, is worse than no guard:
//
//  1. Only kinds that ALSO have a variant axis are covered, because the offer key is
//     `<kind>:<variant>:<option>`. Unconditional switches on variant-less kinds — `bucket:versioning`,
//     `registry:immutable_tags`, `dns:waf_enabled`, `nosql:point_in_time_recovery`,
//     `network:provision_network`, `secret:generate`, `service:probe_enabled` — are NOT measured here.
//     Several of those are provider-carried on some clouds and not others, so the same class of gap
//     can still hide there. Extending to a `<kind>:<option>` key is the follow-on.
//  2. Only `type: "switch"` is read. An enum-shaped option (a `select` whose values are not a
//     `variants:` axis) makes the same cross-cloud promise and is equally invisible.

/** Unconditional switch fields per kind — the options the canvas offers on every cloud. */
function offeredOptions() {
	const src = readFileSync(CONFIG_SCHEMA_SRC, "utf8");
	const body = src.slice(src.indexOf("CONFIG_SCHEMA"));
	const kinds = [...body.matchAll(/\n\t(\w+): \{/g)];
	const out = {};
	for (let i = 0; i < kinds.length; i++) {
		const seg = body.slice(kinds[i].index, kinds[i + 1]?.index ?? body.length);
		for (const f of seg.matchAll(/\{\s*key:\s*"(\w+)",\s*type:\s*"switch"([\s\S]{0,400}?)\n\t*\}/g)) {
			if (/visibleWhen|requiresProvider/.test(f[2])) continue; // already gated by the canvas
			(out[kinds[i][1]] ??= []).push(f[1]);
		}
	}
	return out;
}

const OPTIONS = offeredOptions();

/** snake_case option key → the Go struct field a provider would read (`iam_auth` → `IamAuth`). */
const goFieldFor = (key) =>
	key
		.split("_")
		.map((s) => s.charAt(0).toUpperCase() + s.slice(1))
		.join("");

/** Which clouds' providers demonstrably READ this option (i.e. carry it into tfvars)? */
function optionCarriers(key) {
	const probe = new RegExp(`\\.${goFieldFor(key)}\\b`);
	return new Set(CLOUDS.filter((c) => probe.test(goSrc[c])));
}

// Which option cells are ADJUDICATED — i.e. failing the build rather than merely reported.
//
// This is deliberately a short list, and it is NOT the offer vocabulary (that is derived above). It is
// the adjudication queue. Seven of the derived options are provider-carried today, and turning them
// all on at once would dump ~10 unclassified cells into offer-exclusions.yaml — where each entry is
// supposed to be a DECISION ("can never be honored" vs "real debt, here is the issue"), not a guess.
// A file full of guesses is the "wall of red people stop reading" this guard's own comments warn
// about. So options graduate one at a time, with their per-cloud decisions made deliberately.
//
// Everything carried-but-unadjudicated is still REPORTED below, so nothing is hidden and the follow-on
// is visible in the output rather than living only in someone's head.
const ADJUDICATED = new Set(["database:iam_auth"]);

/** Does the template gate this option per ENGINE, and if so which engines does it cover?
 *
 * Carriage is cloud-level (`db.IamAuth` is read once), but honoring can be per-engine — which is
 * exactly how gcp shipped Postgres keyless working and MySQL keyless silently dead until #1505.
 * Evidence-based and conservative, like `enumeratedValues`: only lines mentioning the option token
 * count, and only when at least one of them is engine-specific. A template that references the option
 * uniformly is treated as covering every engine (passthrough is not a gap). */
function optionEngineCoverage(cloud, key, variants) {
	const lines = tf[cloud].split("\n").filter((l) => l.includes(key));
	if (!lines.length) return null;
	const seen = new Set();
	let engineSpecific = false;
	for (const l of lines) {
		for (const v of variants) {
			const rx = new RegExp(`==\\s*"${v}"|_${v}\\b|\\b${v}_`, "i");
			if (rx.test(l)) {
				seen.add(v);
				engineSpecific = true;
			}
		}
	}
	// Also credit an engine named in an option-scoped local/variable elsewhere in the template
	// (`database_flags_mysql`, `enable_mysql_entra`) — the gcp/azure shapes.
	return engineSpecific ? seen : null;
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

// ── day-2 posture · gate coverage (#1494) ───────────────────────────────────────────
// Everything above is a DAY-1 question: could this offer ever be built. #1440 added the day-2 half
// — after the first apply, does changing a tunable CONVERGE in place or force-replace the data? —
// as `AnalyzeDay2` in test/e2e/t2_day2_offer.go, which reads a real `tofu plan -json`.
//
// This generator cannot answer that question, and pretending otherwise would be the worst outcome.
// Whether an argument forces replacement lives in the PROVIDER SCHEMA, not in template text; only a
// real plan resolves it. So what is derived here is the honest half — GATE COVERAGE:
//
//   which resource backs this offer, and would `AnalyzeDay2` actually catch a hazard on it?
//
// A hazard is only caught if the backing type is in `day2StatefulTypes`. A data-bearing type MISSING
// from that map is worse than an unguarded offer: the gate returns Safe, so the offer looks proven.
// That is a real defect this found — Azure's template moved to `azurerm_managed_redis` (the retired
// `azurerm_redis_cache` cannot be created any more) while the map still listed only the old types.
//
// Where the backing type is inside an EXTERNAL registry module (all of AWS: cloudposse/rds-cluster,
// cloudposse/elasticache-redis, terraform-aws-modules/elasticache//serverless-cache) the type is not
// in this repo's text at all. That is reported as `?` — not-evaluable — the same honesty
// packages/core/verify applies to a control the plan cannot show. It is a known limit, not debt: the
// real-apply harness (#1495) is what resolves it.

const DAY2_GATE_SRC = `${ROOT}/test/e2e/t2_day2_offer.go`;

/** The resource types `AnalyzeDay2` treats as data-bearing, read from the Go map itself.
 *
 * Deliberately PARSED rather than restated here. A second copy of the list in JS would drift from
 * the gate exactly the way the gate drifted from the templates — which is the bug this surfaces. */
function gatedTypes() {
	if (!existsSync(DAY2_GATE_SRC)) return null;
	const src = readFileSync(DAY2_GATE_SRC, "utf8");
	const map = src.match(/var day2StatefulTypes = map\[string\]bool\{([\s\S]*?)\n\}/);
	if (!map) return null;
	return new Set([...map[1].matchAll(/"([a-z0-9_]+)":\s*true/g)].map((m) => m[1]));
}

const GATED = gatedTypes();

/** Tokens that make a resource type (or module source) data-bearing FOR AN AXIS.
 *
 * A detector, not a source of truth — its only job is to notice a candidate the gate may not know
 * about, so a miss is what costs. Whole-token matching keeps the neighbours out: `cosmosdb` and
 * `dynamodb` are single tokens, so neither trips `db`, and `google_firestore_database` never reads
 * as a relational offer. Anything this over-collects surfaces as a cell to resolve, never as silence. */
const DAY2_AXIS_TOKENS = {
	database: /(?:^|_)(?:db|rds|sql|postgres|postgresql|mysql)(?:_|$)/,
	cache: /(?:^|_)(?:cache|redis|valkey|memorystore|kvstore|elasticache)(?:_|$)/,
};

/** Companion resources that sit ON a data service without holding its data — users, grants, logical
 * databases, firewall rules, admin bindings, subnet/parameter groups. Replacing one of these loses
 * nothing, so they are not the offer's backing resource. A type the GATE already claims is never
 * filtered by this: `day2StatefulTypes` outranks the heuristic. */
const DAY2_SIDECAR =
	/_(?:user|user_group|user_group_association|database|account|account_privilege|privilege|firewall_rule|rule|administrator|backup_policy|subnet_group|parameter_group|group|policy|association|role|secret|version|alias|configuration|endpoint|link)$/;

/** Is this resource type the data-bearing backing of THIS axis?
 *
 * The axis test always applies — being in the gate says a type holds data, never WHICH axis it is on.
 * An early version let gate membership skip it, and `alicloud_kvstore_instance` (Redis) duly turned up
 * as a candidate backing for `database:postgres`. Gate membership overrides only the sidecar
 * heuristic, which it outranks by construction: the gate is the authority on what holds data. */
const isDay2Backing = (type, kind) =>
	DAY2_AXIS_TOKENS[kind].test(type) && (GATED?.has(type) || !DAY2_SIDECAR.test(type));

/** Which variant a declaration names, by its own text and the path it lives at.
 *
 * `google_memorystore_instance` is GCP's Valkey resource but says "memorystore", and AWS's serverless
 * cache says neither — so a name test alone cannot finish the job. It does not have to: an
 * unattributed candidate is resolved by elimination below, which is also what correctly reads a
 * single passthrough resource (one `alicloud_db_instance` for both engines) as serving every variant. */
const VARIANT_ALIASES = {
	postgres: ["postgres", "postgresql", "pgsql"],
	mysql: ["mysql", "mariadb"],
	redis: ["redis"],
	valkey: ["valkey", "memorystore"],
};

function namedVariant(text, variants) {
	const hay = text.toLowerCase();
	const hits = variants.filter((v) => (VARIANT_ALIASES[v] ?? [v]).some((a) => hay.includes(a)));
	return hits.length === 1 ? hits[0] : null;
}

/** Every data-bearing declaration on a cloud's axis: in-repo resources, and the external modules
 * that hide one. Each carries the variant it names (or null → resolved by elimination). */
function day2Candidates(cloud, kind, variants) {
	const found = [];
	for (const file of tfFiles[cloud]) {
		for (const m of file.text.matchAll(/resource\s+"([a-z0-9_]+)"\s+"([A-Za-z0-9_-]+)"/g)) {
			if (!isDay2Backing(m[1], kind)) continue;
			found.push({ form: "resource", ref: m[1], variant: namedVariant(`${m[1]} ${file.path}`, variants) });
		}
		// An EXTERNAL module source (registry / git — not a `./` path) is an opaque box: the types it
		// creates are not in this repo, so the gate's coverage of them cannot be read from here.
		for (const m of file.text.matchAll(/module\s+"([A-Za-z0-9_-]+)"\s*\{([\s\S]*?)\n\}/g)) {
			const src = m[2].match(/\n\s*source\s*=\s*"([^"]+)"/);
			if (!src || /^\.{1,2}\//.test(src[1])) continue;
			if (!DAY2_AXIS_TOKENS[kind].test(src[1].replace(/[^a-z0-9]+/gi, "_"))) continue;
			found.push({
				form: "module",
				ref: src[1],
				variant: namedVariant(`${m[1]} ${src[1]} ${file.path}`, variants),
			});
		}
	}
	// Dedupe — the same module/resource can be declared in more than one stack file.
	const seen = new Map();
	for (const f of found) {
		const key = `${f.form}:${f.ref}:${f.variant ?? ""}`;
		if (!seen.has(key)) seen.set(key, f);
	}
	return [...seen.values()];
}

/** Resolve backing declarations onto the variants a cloud actually offers.
 *
 * Two passes: the ones that name a variant claim it, then what is left is matched by elimination —
 * a lone unattributed candidate against a lone unclaimed variant is that variant's; a lone
 * unattributed candidate against SEVERAL unclaimed variants is a passthrough serving all of them,
 * which is the same "passthrough is not a gap" reading check B already takes. */
function day2Backings(cloud, kind, variants) {
	const offeredHere = variants.filter((v) => offeredOn(cloud, kind, v));
	const cands = day2Candidates(cloud, kind, variants);
	const backing = {};
	for (const c of cands) if (c.variant && offeredHere.includes(c.variant)) backing[c.variant] ??= c;

	// Exactly ONE unattributed declaration serves every variant still unclaimed — that is a passthrough
	// (one `alicloud_db_instance` for both engines), the same reading check B takes. SEVERAL
	// unattributed declarations are not resolvable from here: pairing them off by order would be a
	// coin flip printed as a fact, so they are left unassigned and the cell says so.
	const looseCands = cands.filter((c) => !c.variant);
	const unclaimed = offeredHere.filter((v) => !backing[v]);
	if (looseCands.length === 1) for (const v of unclaimed) backing[v] = looseCands[0];
	else if (looseCands.length > 1) for (const v of unclaimed) backing[v] = { form: "ambiguous", ref: null, cands: looseCands };
	return backing;
}

// Only offered cells get a day-2 row — an excluded or unoffered offer has no day 2 to have — so
// these three are the whole vocabulary.
const DAY2_STATE = { guarded: "🟡", blind: "🚫", "not-evaluable": "?" };

// ── run ─────────────────────────────────────────────────────────────────────────────

const findings = [];
const knownDebt = [];
const cells = []; // for the matrix
const day2Cells = [];

for (const [kind, variants] of Object.entries(AXES)) {
	for (const cloud of CLOUDS) {
		const carrier = hasCarrier(cloud, kind);
		const enumerated = enumeratedValues(cloud, variants);
		const backings = day2Backings(cloud, kind, variants);
		for (const variant of variants) {
			const offer = `${kind}:${variant}`;
			const exc = excluded(offer, cloud);
			let state = "ok";
			let detail = "";
			// A cloud that offers exactly ONE engine on this axis has no choice to drop, so the
			// carrier check does not apply to it: the defect this guard names is "a CHOICE the product
			// presents and then discards". Azure and Alibaba offer only Redis, so their provider not
			// reading `cache.Engine` is not a silent gap — there is nothing for the user to pick.
			// Without this they would sit on the baseline forever for no reachable reason, and a list
			// with permanent residents stops being read.
			const offeredHere = variants.filter((v) => offeredOn(cloud, kind, v));
			const singleChoice = offeredHere.length <= 1;

			if (!offeredOn(cloud, kind, variant)) {
				// Not offered on this cloud at all — the canvas floor already hides it. Not a gap, and
				// not an exclusion either: there is nothing to exclude from.
				cells.push({ kind, variant, cloud, state: "not-offered", detail: "" });
				continue;
			}
			if (exc) {
				state = "excluded";
				detail = exc.reason ?? "";
			} else if (!carrier && !singleChoice) {
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

			// ── day-2 · gate coverage for this same cell ───────────────────────────────────
			// Only cells the product actually offers get a day-2 row: an excluded or unoffered
			// offer has no day-2 to have.
			if (state === "excluded") continue;
			const back = backings[variant];
			let d2 = "not-evaluable";
			let ref = "—";
			let note = "no data-bearing declaration found in the template — only a real plan can show one.";
			if (back?.form === "resource") {
				ref = back.ref;
				d2 = GATED?.has(back.ref) ? "guarded" : "blind";
				note = d2 === "guarded"
					? "replace/delete of this resource is a data-loss hazard the day-2 gate catches."
					: `\`${back.ref}\` is data-bearing but is NOT in \`day2StatefulTypes\` — the day-2 gate would call replacing it Safe.`;
			} else if (back?.form === "module") {
				ref = back.ref;
				note = "the backing type is inside an external module — not visible in template text; the real-apply harness resolves it.";
			} else if (back?.form === "ambiguous") {
				note =
					`${back.cands.length} data-bearing declarations on this axis (${back.cands.map((c) => `\`${c.ref}\``).join(", ")}) ` +
					`and none names a variant — which one backs this offer is not decidable from template text.`;
			}
			// A variant switch that crosses backing resources is a delete + create, not an in-place
			// change — the shape `AnalyzeDay2` catches via its delete half (aws redis↔valkey is a
			// module swap; gcp swaps google_redis_instance for google_memorystore_instance).
			const others = Object.entries(backings).filter(([v, b]) => v !== variant && b?.ref !== back?.ref);
			if (back && others.length) {
				note += ` Switching to ${others.map(([v]) => `\`${v}\``).join("/")} crosses backing resources — a delete + create, not an in-place change.`;
			}
			day2Cells.push({ kind, variant, cloud, offer, state: d2, ref, note });
			if (d2 === "blind") {
				findings.push({ shape: "day2-blind", cloud, offer, detail: note, known: null });
			}
		}
	}
}

// ── option-level pass (`<kind>:<variant>:<option>`) ──────────────────────────────────
//
// One cell per (kind × variant × option × cloud). Carriage is measured cloud-level; engine coverage
// is measured per variant, because the two fail independently — alibaba drops `iam_auth` entirely,
// while gcp carried it and still had no MySQL branch until #1505.

const optionCells = [];
const unadjudicated = [];

for (const [kind, keys] of Object.entries(OPTIONS)) {
	const variants = AXES[kind];
	if (!variants) continue; // no variant axis → no `<kind>:<variant>:<option>` cell to name
	for (const key of keys) {
		const carriers = optionCarriers(key);
		// No provider reads it → the guard cannot see whether this option is a tfvars-carried capability
		// at all (it may be console-only or template-default). Saying nothing is the honest result;
		// claiming a gap on zero evidence is how a guard earns its way onto the ignore list.
		if (carriers.size === 0) continue;
		const offerBase = `${kind}:${key}`;
		if (!ADJUDICATED.has(offerBase)) {
			const missing = CLOUDS.filter((c) => !carriers.has(c) && variants.some((v) => offeredOn(c, kind, v)));
			if (missing.length) unadjudicated.push({ offer: offerBase, missing });
			continue;
		}
		for (const cloud of CLOUDS) {
			const coverage = carriers.has(cloud) ? optionEngineCoverage(cloud, key, variants) : null;
			for (const variant of variants) {
				if (!offeredOn(cloud, kind, variant)) {
					optionCells.push({ kind, variant, key, cloud, state: "not-offered", detail: "" });
					continue;
				}
				const offer = `${kind}:${variant}:${key}`;
				const exc = excluded(offer, cloud);
				let state = "ok";
				let detail = "";
				if (exc) {
					state = "excluded";
					detail = exc.reason ?? "";
				} else if (!carriers.has(cloud)) {
					state = "no-carrier";
					detail =
						`the canvas offers \`${key}\` on every cloud, but the ${cloud} provider never reads ` +
						`\`${goFieldFor(key)}\` — the switch is dropped between the canvas and the plan, so a user ` +
						`turns it on and nothing happens.`;
				} else if (coverage && !coverage.has(variant)) {
					state = "missing-branch";
					detail =
						`the ${cloud} template gates \`${key}\` per engine (${[...coverage].join("/")}) and ${variant} ` +
						`has no branch — carried into tfvars, then honored for the other engine only.`;
				}
				const known = state !== "ok" && state !== "excluded" ? baselined(offer, cloud) : null;
				optionCells.push({ kind, variant, key, cloud, state, detail, known });
				if (state !== "ok" && state !== "excluded") {
					(known ? knownDebt : findings).push({ shape: state, cloud, offer, detail, known });
				}
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

	// ── option-level offers · a grid per option ────────────────────────────────────────
	// A grid rather than a row list: an option is offered per (engine × cloud) exactly like a variant,
	// and the thing worth seeing at a glance is which CELLS honor it — that is the shape that hid
	// MySQL keyless.
	if (optionCells.length) {
		md += `\n## Option-level offers — a switch the canvas shows on every cloud\n
Not every offer is an engine choice. \`iam_auth\` is a plain switch in the inspector with no
per-cloud gate, so the canvas presents keyless database auth on **every** cloud for **both** engines.
The variant grids above cannot see that, which is why shipping MySQL keyless broken was
un-catchable until #1508.

A cell here is 🚫 when the cloud's provider never reads the option (the switch is dropped between the
canvas and the plan), or when the template gates it per engine and this engine has no branch.\n`;
		for (const key of [...new Set(optionCells.map((c) => c.key))]) {
			const kind = optionCells.find((c) => c.key === key).kind;
			md += `\n### \`${kind}\` · \`${key}\`\n\n| Offer | ${CLOUDS.join(" | ")} |\n|---|${CLOUDS.map(() => ":---:").join("|")}|\n`;
			for (const variant of AXES[kind]) {
				const row = CLOUDS.map((c) => {
					const cell = optionCells.find((x) => x.key === key && x.variant === variant && x.cloud === c);
					if (!cell) return GLYPH["not-offered"];
					return cell.known?.issue ? `${GLYPH[cell.state]} ${cell.known.issue}` : GLYPH[cell.state];
				});
				md += `| \`${variant}\` | ${row.join(" | ")} |\n`;
			}
		}
	}

	// ── day-2 · one row per (offer × cloud) ────────────────────────────────────────────
	// A row rather than a second grid, on purpose. The day-2 signal is not one glyph: it is WHICH
	// resource backs the offer, WHICH external module hides it, and whether switching variant crosses
	// resources. A 4×6 day-2 grid would render as near-uniform 🟡 with one `?` column — a whole matrix
	// to say one thing — and would have nowhere to put the part that is actually worth reading. This
	// is the same shape the documented-exclusions table below already uses for the same reason.
	if (day2Cells.length) {
		md += `\n## Day-2 posture — would a hazard be caught?

Day 1 asks *could this ever be built*. Day 2 asks *what happens when you change it afterwards*: does a
new engine version or size CONVERGE in place, or force-replace the data? That question is answered from
a real \`tofu plan -json\` by \`AnalyzeDay2\` ([\`test/e2e/t2_day2_offer.go\`](../../test/e2e/t2_day2_offer.go))
— it cannot be answered from template text, because whether an argument forces replacement lives in the
provider schema.

What IS derivable here, and all this table claims, is **gate coverage**: the resource backing each offer,
and whether \`day2StatefulTypes\` knows it — because a data-bearing type the gate does not know is worse
than an unguarded one. The gate returns *Safe*, so the offer looks proven when nothing checked it.

One row per offer this cloud actually offers (an excluded offer has no day 2 to have). Legend:
🟡 backing resource is in the repo **and** guarded — a hazard would be caught, awaiting a real-apply
proof · 🚫 data-bearing but **not** in \`day2StatefulTypes\` — the gate would pass it vacuously ·
? not evaluable from template text (the type is inside an external module; only a real plan shows it)

As with day 1, **no cell goes ✅ from here.** The proof is a real apply recorded in
[\`demos/proofs/provisioning-e2e-log.md\`](../../demos/proofs/provisioning-e2e-log.md) and promoted in
[\`provisioning-e2e-parity.md\`](./provisioning-e2e-parity.md).

| Offer | Cloud | Backing resource | Day-2 | Note |
|---|---|---|:---:|---|
`;
		for (const c of day2Cells) {
			const ref = c.ref === "—" ? "—" : `\`${c.ref}\``;
			md += `| \`${c.offer}\` | ${c.cloud} | ${ref} | ${DAY2_STATE[c.state]} | ${c.note} |\n`;
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

// The gate the day-2 rows are measured against has to EXIST. If t2_day2_offer.go moves or its map is
// renamed, every cell would quietly read `blind` (a wall of false failures) or the parse would return
// an empty set. Say so instead of reporting nonsense.
if (!GATED) {
	console.error(
		`\n✗ offer parity — could not read \`day2StatefulTypes\` from ${DAY2_GATE_SRC}.\n` +
			`  The day-2 rows measure gate coverage against that map; without it they mean nothing.\n` +
			`  If the gate moved, update DAY2_GATE_SRC in this script.\n`,
	);
	process.exit(1);
}

const day2Summary = day2Cells.reduce((acc, c) => ({ ...acc, [c.state]: (acc[c.state] ?? 0) + 1 }), {});

// Options that ARE provider-carried on some clouds and not others, but have not been adjudicated yet.
// Reported, never silent: these are the next cells to graduate into ADJUDICATED, and leaving them
// invisible would recreate exactly the blind spot #1508 closed. Not fatal — nobody has decided them.
if (unadjudicated.length) {
	console.log(`  ${unadjudicated.length} carried option(s) not yet adjudicated (reported, not failing):`);
	for (const u of unadjudicated) {
		console.log(`    · ${u.offer} — carried on some clouds, not on: ${u.missing.join(", ")}`);
	}
	console.log(
		`    Graduate one at a time via ADJUDICATED in this script, deciding each cloud deliberately.`,
	);
}

if (findings.length === 0) {
	console.log(
		`✓ offer parity — ${cells.length} (offer × cloud) cells + ${optionCells.length} option cell(s), ` +
			`${exclusions.length} documented exclusion(s), ${baseline.length} on the baseline, no NEW silent gaps.`,
	);
	console.log(
		`✓ day-2 gate coverage — ${day2Cells.length} offered cell(s): ` +
			`${day2Summary.guarded ?? 0} guarded, ${day2Summary["not-evaluable"] ?? 0} not evaluable from ` +
			`template text (external modules), 0 unguarded data-bearing types.`,
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
if (findings.some((f) => f.shape === "day2-blind")) {
	console.error(`A [day2-blind] finding has exactly ONE fix, and it is a one-line one: add the resource type to
\`day2StatefulTypes\` in test/e2e/t2_day2_offer.go. It is not baseline material — an unguarded
data-bearing type does not report a gap, it reports SAFE, so nothing would ever come back to collect it.
`);
}
process.exit(1);
