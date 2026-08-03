// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Tracing a canvas switch through the Go tfvars builders: which tofu variable does
// `ProjectStorageBucketConfig.PublicAccess` actually become, on this cloud, and does it become one
// at all?
//
// `check-offer-parity.mjs` used to answer a weaker question — "does the string `.PublicAccess`
// appear in <cloud>_provider.go" — and that answer is wrong in both directions:
//
//   · FALSE NEGATIVE. Azure's secrets are built by `buildGCPSecrets`, which lives in
//     gcp_provider.go. A per-file grep says Azure drops `generate`; it does not, it reuses GCP's
//     builder. The Go package is one package, so the call graph is the honest unit, not the file.
//   · FALSE POSITIVE. GCP's `buildFirestoreDatabases` reads `PointInTimeRecovery` and returns a
//     list nobody assigns to a tfvar — the function is dead, and gcp_provider.go says so in a
//     comment. A grep counts that as carriage. Reachability from `ProviderTfvars` does not.
//
// So this walks: entry (`func (p *<cloud>Provider) ProviderTfvars`) → call graph → the function
// that reads the field → the quoted map key its value ends up under → the ROOT tfvar that key sits
// inside. That last hop is what lets the template side ask the right question: `versioning_enabled`
// is not a variable, it is an attribute of `bucket_configuration`.
//
// A TEXT parse, the same bargain `lib/go-source.mjs` documents: a Go program emitting JSON would put
// a compile step between a one-line edit and the guard meant to catch it. The safety comes from
// counting what was parsed and failing loudly on nothing (`assertParsed`), never from defaulting.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { neutralizeBracesInStrings, stripComments } from "./go-source.mjs";

/** Brace-matching input: string literals blanked, and the EMPTY TYPE braces blanked too.
 *
 * `map[string]interface{}` is the reason. Every builder in this package returns one, so a matcher
 * that starts at the first `{` after `func …` lands inside the return type, closes one character
 * later, and hands back an empty body — which reads exactly like "this provider carries nothing".
 * Both substitutions preserve LENGTH so offsets into the raw source stay valid. */
const neutralize = (src) =>
	neutralizeBracesInStrings(src).replace(/interface\{\}/g, "interface..").replace(/struct\{\}/g, "struct..");

/** Statements that BIND a name to an expression. Deliberately not `==`/`!=`/`<=`/`>=`. */
const ASSIGN = /(^|[\s,(])([A-Za-z_]\w*)\s*(?::=|=)(?!=)/g;

/** A quoted map key being written: `"fifo_queue":` in a literal, `cfg["fifo_queue"] =` by index. */
const KEY_IN_LITERAL = /"([a-z0-9_]+)"\s*:/g;
const KEY_BY_INDEX = /\w+\["([a-z0-9_]+)"\]\s*=/g;

/**
 * Read every non-test .go file in a directory into one package index: functions by key, and the
 * source they came from.
 *
 * Methods are keyed `<ReceiverType>.<Name>` and plain functions by bare name, because both forms
 * appear on the path this traces (`(*azureProvider).ProviderTfvars` calls `buildGCPSecrets`).
 */
export function readGoPackage(dir) {
	const pkg = { funcs: new Map(), byName: new Map(), dir };
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".go") || entry.name.endsWith("_test.go")) continue;
		const file = join(dir, entry.name);
		indexGoSource(pkg, file, readFileSync(file, "utf8"));
	}
	return pkg;
}

/** Index one Go file's top-level funcs into `pkg`. Split out from `readGoPackage` so `selfCheck`
 * can index a fixture without a file on disk — this is the step that broke first and silently. */
export function indexGoSource(pkg, file, text) {
	const raw = stripComments(text);
	const src = neutralize(raw);
	for (const m of src.matchAll(/\nfunc\s+(?:\(\s*\w+\s+\*?(\w+)\s*\)\s*)?(\w+)\s*\(/g)) {
		const recv = m[1] ?? null;
		const name = m[2];
		const body = bracedBody(src, m.index, raw);
		const key = recv ? `${recv}.${name}` : name;
		pkg.funcs.set(key, { name, recv, body, file });
		if (!pkg.byName.has(name)) pkg.byName.set(name, []);
		pkg.byName.get(name).push(key);
	}
	return pkg;
}

/** The brace-matched body of the declaration starting at `from`, taken from the RAW source so the
 * caller sees real string literals — the neutralized copy is only for finding the braces. */
function bracedBody(neutralized, from, raw) {
	const open = neutralized.indexOf("{", from);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < neutralized.length; i++) {
		if (neutralized[i] === "{") depth++;
		else if (neutralized[i] === "}" && --depth === 0) return raw.slice(open + 1, i);
	}
	return "";
}

/** Every function key reachable from `entry`, following calls by name.
 *
 * Reachability, not presence, is the question: a builder nothing calls emits nothing, however
 * plainly its body reads the field. */
export function reachableFrom(pkg, entry) {
	const seen = new Set();
	const queue = [entry];
	while (queue.length) {
		const key = queue.shift();
		if (seen.has(key) || !pkg.funcs.has(key)) continue;
		seen.add(key);
		const { body, recv } = pkg.funcs.get(key);
		for (const m of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
			for (const target of pkg.byName.get(m[1]) ?? []) {
				// A method call resolves within its own receiver type; a plain function is global.
				const t = pkg.funcs.get(target);
				if (t.recv && t.recv !== recv) continue;
				queue.push(target);
			}
		}
	}
	return seen;
}

/** The span of the `{ … }` block starting at or after `from` in an ALREADY-NEUTRALIZED body, braces
 * included. Neutralized once by the caller because the chain walk below asks this repeatedly. */
function blockSpanIn(neutral, from) {
	const open = neutral.indexOf("{", from);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < neutral.length; i++) {
		if (neutral[i] === "{") depth++;
		else if (neutral[i] === "}" && --depth === 0) return { start: open, end: i + 1 };
	}
	return null;
}

/**
 * Every block ONE `if` statement decides: its own body, and each `else if` / `else` body chained
 * after it.
 *
 * The `else` half is not a detail. A switch that chooses between two key SETS writes half its
 * evidence there, and a matcher that stops at the closing brace of the `if` never sees it. AWS's
 * `buildSecrets` is exactly that shape —
 *
 *     if s.Generate { entry["length"] = s.Length; entry["special"] = s.SpecialChars }
 *     else          { entry["manual"] = true }
 *
 * — so `manual` was invisible, and the cell was graded on the two keys that happened to sit on the
 * true side. Reading half the branch is the same failure the strength grading exists to prevent, one
 * level down: a verdict that looks measured and was taken on partial evidence.
 *
 * Both halves are the field's, because both are chosen BY the field — the `else` runs precisely when
 * the switch is off. They are not graded here: `keysDerivedFrom` grades each line on whether that
 * line names the field, exactly as it does inside the `if`.
 *
 * Seeing both halves deliberately does NOT upgrade the grade, and the temptation to make it is worth
 * naming, because completing the case analysis looks like proof and is not. `if x.Versioning {
 * entry["access_type"] = "blob" } else { entry["access_type"] = "private" }` is a two-sided branch
 * writing one key both ways, and it is the WRONG FEATURE — container access, not versioning. A rule
 * that read two-sidedness as `derived` would launder precisely the class this grading exists to
 * catch. So aws's `buildSecrets` reports `length`, `special` AND `manual`, all three `gated`: the
 * evidence is now complete, and what it establishes is still only that the switch decides which keys
 * appear. `entry["length"] = s.Length` names a DIFFERENT field — the sibling `length` option — which
 * is evidence about that offer, not about this one.
 */
function branchBlocksAt(body, from) {
	const neutral = neutralize(body);
	const blocks = [];
	let at = from;
	for (;;) {
		const span = blockSpanIn(neutral, at);
		if (!span) break;
		blocks.push(body.slice(span.start, span.end));
		// `}` followed by `else` / `else if` is the only thing that continues the chain; a `}` followed
		// by anything else ends the statement, and reading on would attribute a LATER block's keys to
		// this switch.
		const chain = neutral.slice(span.end).match(/^\s*else\b/);
		if (!chain) break;
		at = span.end + chain[0].length;
	}
	return blocks;
}

/**
 * The quoted tfvars keys a function body derives from `.<field>`, each with HOW STRONGLY it derives.
 *
 * A three-shape taint, because the providers write all three and missing any one of them scores a
 * working path as a gap:
 *
 *   1. straight through — `"uniform_access": !b.PublicAccess`
 *   2. through a local  — `blockPublic := !b.PublicAccess` … `"block_public_acls": blockPublic`
 *   3. through a branch — `if b.PublicAccess { accessType = "blob" }` … `"…": accessType`, and
 *      `if t.PointInTimeRecovery { entry["analytical_storage_enabled"] = true }`
 *
 * Shape 3 is why the `if` body has to be brace-matched rather than line-scanned: the line that names
 * the field and the line that names the key are never the same line. And it is the whole branch —
 * `else` and `else if` included (see `branchBlocksAt`) — because a switch that chooses between two
 * key SETS writes half of what it decides on the false side.
 *
 * TWO STRENGTHS, because shape 3's second form is materially weaker evidence than the other two and
 * scoring them the same is how a WRONG-FEATURE cell reads as fine:
 *
 *   · `derived` — the statement that writes the key references the field, or a local the field has
 *     tainted. The key's VALUE moves with the switch, so the key is about the switch. Both
 *     `"…": !b.PublicAccess` and `"…": accessType` (where `accessType` was set inside an
 *     `if b.PublicAccess` branch) are this.
 *   · `gated`   — the key is only WRITTEN inside a branch guarded by the field, and its own
 *     statement never names it: `if t.PointInTimeRecovery { entry["analytical_storage_enabled"] =
 *     true }`. All that establishes is *the switch decides whether some key appears*. It does not
 *     establish that the key MEANS the switch — and on azure that exact line files Cosmos DB
 *     Synapse Link analytical (column) storage under a point-in-time-recovery toggle. PITR on Cosmos
 *     is continuous backup; they are different products. No text reader can tell those apart, so the
 *     honest move is to GRADE the evidence rather than launder it into a pass.
 *
 * @returns {Map<string, "derived"|"gated">} key → the strongest evidence seen for it
 */
export function keysDerivedFrom(body, field) {
	const fieldRx = new RegExp(`\\.${field}\\b`);
	const tainted = new Set();
	/** @type {Map<string, "derived"|"gated">} */
	const keys = new Map();

	const lines = body.split("\n");
	const offsets = [];
	let at = 0;
	for (const l of lines) {
		offsets.push(at);
		at += l.length + 1;
	}

	/** Does this text mention the field, or a local already known to carry it? */
	const carries = (text) => fieldRx.test(text) || [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(text));

	/** File `key` at `level`, keeping the STRONGEST evidence seen for it: a key written both ways is
	 * genuinely carried on at least one path, and the strongest path is the one a user gets. */
	const record = (key, level) => {
		if (level === "derived" || !keys.has(key)) keys.set(key, level);
	};

	/** Harvest every quoted tfvars key written by `text`, filing each one at `level`. */
	const harvestKeys = (text, level) => {
		for (const m of text.matchAll(KEY_IN_LITERAL)) record(m[1], level);
		for (const m of text.matchAll(KEY_BY_INDEX)) record(m[1], level);
	};

	// Three passes: a local can be tainted after the line that consumes it has already been seen
	// (`accessType := "private"` … `if … { accessType = "blob" }` … `"x": accessType`). Two would
	// do for every shape in the tree today; three is the cheap margin.
	for (let pass = 0; pass < 3; pass++) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!carries(line)) continue;

			harvestKeys(line, "derived");
			for (const m of line.matchAll(ASSIGN)) {
				if (/\[/.test(line.slice(0, m.index + m[0].length))) continue; // a map write, not a local
				tainted.add(m[2]);
			}
			// A branch ON the field carries the field into everything the branch decides — but the
			// branch alone only decides WHETHER a key is written, so a key whose own statement never
			// names the field is `gated`, not `derived`. Graded per LINE rather than per block,
			// because one branch routinely holds both: `acl = "public-read"` taints a local that a
			// later line assigns to a key, and that line is `derived` on its own merits.
			//
			// EVERY block the statement decides, `else` included. The false side is chosen by the
			// switch just as the true side is, and a reader that stops at the first closing brace
			// grades the cell on whichever half it happened to see.
			if (/(^|\s)if\s/.test(line) && line.includes("{")) {
				for (const block of branchBlocksAt(body, offsets[i])) {
					for (const inner of block.split("\n")) harvestKeys(inner, carries(inner) ? "derived" : "gated");
					for (const m of block.matchAll(ASSIGN)) {
						if (/\w\[[^\]]*\]\s*$/.test(block.slice(0, m.index + m[0].length).split("\n").pop())) continue;
						tainted.add(m[2]);
					}
				}
			}
		}
	}
	return keys;
}

/**
 * Where a builder's RESULT lands in the tfvars map: `"gcs_buckets": buildGCSBuckets(…)`.
 *
 * Without this hop the template side cannot ask the right question. `versioning_enabled` is not a
 * tofu variable and never will be — it is an attribute of one entry of `bucket_configuration`, and
 * whether the template declares it is a question about that variable's object type.
 */
export function rootKeyForBuilder(pkg, reachable, builderName) {
	const direct = new RegExp(`"([a-z0-9_]+)"\\s*:\\s*(?:\\w+\\.)?${builderName}\\s*\\(`);
	const indexed = new RegExp(`\\w+\\["([a-z0-9_]+)"\\]\\s*=\\s*(?:\\w+\\.)?${builderName}\\s*\\(`);
	for (const key of reachable) {
		const body = pkg.funcs.get(key)?.body ?? "";
		const m = body.match(direct) ?? body.match(indexed);
		if (m) return m[1];
	}
	return null;
}

/**
 * Trace one canvas switch on one cloud: does the provider carry it into tfvars, and under what?
 *
 * Returns `{carried, sites, entryMissing}` where each site is `{fn, file, key, root, strength}` —
 * `root` is the tfvars variable the key lives inside, or the key itself when it IS a top-level
 * tfvar, and `strength` is `derived` or `gated` (see `keysDerivedFrom`).
 *
 * `carried` is deliberately LOOSE: it answers "is this kind provisioned through tofu at all", which
 * is an evidence question. It is not a verdict, and there is no `carriedStrongly` companion to
 * mistake for one — the ACCUSATION question ("does this switch demonstrably decide a value") cannot
 * be answered here, because it also depends on whether the template honors the key, which is the
 * caller's half. The caller weighs `site.strength` against its own wiring verdict; a second
 * summary flag on this end would answer half the question in a field named as if it answered all
 * of it.
 */
export function traceField(pkg, cloud, goField) {
	const entry = `${cloud}Provider.ProviderTfvars`;
	if (!pkg.funcs.has(entry)) {
		return { carried: false, sites: [], entryMissing: true };
	}
	const reachable = reachableFrom(pkg, entry);
	const sites = [];
	for (const key of reachable) {
		const fn = pkg.funcs.get(key);
		if (!new RegExp(`\\.${goField}\\b`).test(fn.body)) continue;
		const isEntry = key === entry;
		const root = isEntry ? null : rootKeyForBuilder(pkg, reachable, fn.name);
		for (const [k, strength] of keysDerivedFrom(fn.body, goField)) {
			sites.push({ fn: fn.name, file: fn.file, key: k, root: isEntry ? k : root, strength });
		}
	}
	return { carried: sites.length > 0, sites, entryMissing: false };
}

/** The tripwire. A package index with no functions traces nothing and reports every cloud clean. */
export function assertParsed(pkg) {
	if (pkg.funcs.size === 0) {
		throw new Error(
			`go-tfvars-trace parsed 0 functions from ${pkg.dir} — the reader is broken, not the providers. ` +
				`A tracer that reads nothing carries nothing and reports success.`,
		);
	}
	// Every cloud with a template must have an entry point. A renamed receiver would otherwise turn
	// that cloud's whole column into "carries nothing" — a wall of false gaps, or worse, a wall of
	// baseline entries someone adds to make it green.
	const entries = [...pkg.funcs.keys()].filter((k) => k.endsWith("Provider.ProviderTfvars"));
	if (entries.length === 0) {
		throw new Error(
			`go-tfvars-trace found no \`(*…Provider).ProviderTfvars\` in ${pkg.dir} — every trace starts ` +
				`there, so without one the tracer reports every switch on every cloud as dropped.`,
		);
	}
}

/**
 * Pin the key tracer against a fixture, in BOTH directions, every run.
 *
 * The tracer's dangerous failure is not "reads nothing" — `assertParsed` has that — it is "reads
 * almost nothing and looks fine". The very first version of this file matched the opening brace of
 * `map[string]interface{}` in a return type, gave every builder an empty body, and reported all five
 * clouds carrying all sixteen switches nowhere. It looked exactly like a codebase-wide gap. So the
 * fixture pins the three taint shapes the providers actually write, and pins that an unrelated key
 * in the same function does NOT get attributed to the field.
 */
export function selfCheck() {
	/** Abort the run with the reason the tracer is untrustworthy — never a flag the caller can ignore. */
	const fail = (msg) => {
		throw new Error(`go-tfvars-trace self-check failed: ${msg}. The tracer is wrong; do not trust this run.`);
	};

	// Real Go, indexed the real way — every builder here returns `map[string]interface{}`, which is
	// the construct that broke the brace matcher, so a regression there fails on the FIRST assertion
	// rather than presenting as a codebase full of gaps.
	const fixture = `package cloud

// A doc comment naming .PublicAccess must not count as a read.
func (p *fixtureProvider) ProviderTfvars(config *types.ProjectConfig) map[string]interface{} {
	return map[string]interface{}{
		"root_key":    config.Network.Toggle,
		"nested_list": buildEntries(config.Items),
	}
}

func buildEntries(items []types.Item) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(items))
	for _, b := range items {
		blocked := !b.PublicAccess
		access := "private"
		if b.PublicAccess {
			access = "blob"
		}
		entry := map[string]interface{}{
			"direct":     !b.PublicAccess,
			"via_local":  blocked,
			"via_branch": access,
			"unrelated":  b.Name,
		}
		if b.PublicAccess {
			entry["in_branch"] = true
		}
		if b.GatedOnly {
			entry["gated_only"] = true
		} else {
			entry["else_gated"] = true
		}
		out = append(out, entry)
	}
	return out
}

func neverCalled(items []types.Item) []map[string]interface{} {
	return []map[string]interface{}{{"dead_key": items[0].PublicAccess}}
}
`;

	const pkg = indexGoSource({ funcs: new Map(), byName: new Map(), dir: "<fixture>" }, "fixture.go", fixture);
	if (!pkg.funcs.get("fixtureProvider.ProviderTfvars")?.body.includes("root_key")) {
		fail("the entry function's body came back empty or truncated — brace matching landed in a return type");
	}
	if (!pkg.funcs.get("buildEntries")?.body.includes("via_branch")) {
		fail("a builder's body came back empty or truncated");
	}

	/** Does any traced site carry the field's own VALUE, rather than merely being guarded by it? The
	 * question `traceField` deliberately no longer answers for its callers — asked here, of the sites,
	 * so the fixture pins the fact and not a convenience field nobody consumed. */
	const anyDerived = (t) => t.sites.some((s) => s.strength === "derived");

	const traced = traceField(pkg, "fixture", "PublicAccess");
	if (!traced.carried) fail("a field read by a reachable builder traced to nothing");
	if (!anyDerived(traced)) fail("a field whose value is assigned straight to a key produced no `derived` site");
	const keys = new Map(traced.sites.map((s) => [s.key, s.root]));
	for (const want of ["direct", "via_local", "via_branch", "in_branch"]) {
		if (!keys.has(want)) fail(`\`${want}\` derives from the field and was not traced`);
	}
	if (keys.get("direct") !== "nested_list") fail("a builder's keys were not attributed to the root tfvar it fills");
	if (keys.has("unrelated")) fail("`unrelated` derives from a different field and was attributed to this one");

	// STRENGTH, in both directions. An `if <field>` guard establishes that the switch decides whether
	// a key appears; it does not establish that the key is ABOUT the switch. Grading these the same
	// is what scored azure's `analytical_storage_enabled` (Synapse Link column storage) as an
	// implementation of `point_in_time_recovery` (continuous backup) — the wrong feature, reading as
	// honored. If this assertion ever flips, that cell silently goes green again.
	const strength = new Map(traced.sites.map((s) => [s.key, s.strength]));
	for (const want of ["direct", "via_local", "via_branch"]) {
		if (strength.get(want) !== "derived") fail(`\`${want}\` carries the field's own value and did not read as \`derived\``);
	}
	if (strength.get("in_branch") !== "gated") {
		fail("`in_branch` is written only under an `if <field>` guard with a literal value and did not read as `gated`");
	}
	// A field carried ONLY by an if-guard must produce no `derived` site at all — that is the whole
	// distinction, and a single leaked `derived` would put the cell back on the honored side.
	const gatedOnly = traceField(pkg, "fixture", "GatedOnly");
	if (!gatedOnly.carried) fail("a field that gates a key write traced to nothing");
	if (anyDerived(gatedOnly)) fail("a field that ONLY gates a key write produced a `derived` site");

	// THE ELSE HALF. `else_gated` is written on the false side of `if b.GatedOnly` with a literal
	// value, so nothing but walking the else block can find it — this is the assertion that fails if
	// the chain walk is ever lost, and the shape is aws's `buildSecrets` (`if s.Generate { length,
	// special } else { manual }`), where the invisible half was a third of the evidence.
	const elseStrength = new Map(gatedOnly.sites.map((s) => [s.key, s.strength]));
	if (!elseStrength.has("else_gated")) fail("a key written in the `else` half of a branch on the field was not traced");
	if (elseStrength.get("else_gated") !== "gated") {
		fail("`else_gated` is a literal on the false side of the branch and did not read as `gated` — seeing both halves is not evidence about the key's MEANING");
	}
	// …and the else half belongs to ITS OWN switch. Attributing it to a neighbouring branch would be
	// a taint leak that reads as extra carriage for a field that decides nothing.
	if (keys.has("else_gated")) fail("`else_gated` is decided by a different field and was attributed to this one");

	// Reachability, both directions. `neverCalled` reads the field too and must NOT count — that is
	// the exact shape of GCP's dead `buildFirestoreDatabases`.
	if (keys.has("dead_key")) fail("an unreachable builder was counted as carriage");

	const root = traceField(pkg, "fixture", "Toggle");
	if (root.sites[0]?.root !== "root_key") fail("a key set directly in ProviderTfvars is its own root and was not");

	// A field nothing touches must trace to nothing — the direction that decides whether a clean run
	// means "carried" or "the tracer gave up".
	if (traceField(pkg, "fixture", "NotPresentAnywhere").carried) fail("an absent field traced to keys — the taint is leaking");
	// And a cloud with no provider at all must say so rather than reporting a clean carry.
	if (!traceField(pkg, "nosuch", "PublicAccess").entryMissing) fail("a missing ProviderTfvars was not reported as missing");
}
