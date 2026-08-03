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

/** The `{ … }` block starting at or after `from` in a function body, braces included. */
function blockAt(body, from) {
	const neutral = neutralize(body);
	const open = neutral.indexOf("{", from);
	if (open === -1) return "";
	let depth = 0;
	for (let i = open; i < neutral.length; i++) {
		if (neutral[i] === "{") depth++;
		else if (neutral[i] === "}" && --depth === 0) return body.slice(open, i + 1);
	}
	return "";
}

/**
 * The quoted tfvars keys a function body derives from `.<field>`.
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
 * the field and the line that names the key are never the same line.
 */
export function keysDerivedFrom(body, field) {
	const fieldRx = new RegExp(`\\.${field}\\b`);
	const tainted = new Set();
	const keys = new Set();

	const lines = body.split("\n");
	const offsets = [];
	let at = 0;
	for (const l of lines) {
		offsets.push(at);
		at += l.length + 1;
	}

	/** Does this text mention the field, or a local already known to carry it? */
	const carries = (text) => fieldRx.test(text) || [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(text));

	const harvestKeys = (text) => {
		for (const m of text.matchAll(KEY_IN_LITERAL)) keys.add(m[1]);
		for (const m of text.matchAll(KEY_BY_INDEX)) keys.add(m[1]);
	};

	// Three passes: a local can be tainted after the line that consumes it has already been seen
	// (`accessType := "private"` … `if … { accessType = "blob" }` … `"x": accessType`). Two would
	// do for every shape in the tree today; three is the cheap margin.
	for (let pass = 0; pass < 3; pass++) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!carries(line)) continue;

			harvestKeys(line);
			for (const m of line.matchAll(ASSIGN)) {
				if (/\[/.test(line.slice(0, m.index + m[0].length))) continue; // a map write, not a local
				tainted.add(m[2]);
			}
			// A branch ON the field carries the field into everything the branch decides.
			if (/(^|\s)if\s/.test(line) && line.includes("{")) {
				const block = blockAt(body, offsets[i]);
				harvestKeys(block);
				for (const m of block.matchAll(ASSIGN)) {
					if (/\w\[[^\]]*\]\s*$/.test(block.slice(0, m.index + m[0].length).split("\n").pop())) continue;
					tainted.add(m[2]);
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
 * Returns `{carried, sites}` where each site is `{fn, key, root}` — `root` is the tfvars variable
 * the key lives inside, or the key itself when it IS a top-level tfvar.
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
		for (const k of keysDerivedFrom(fn.body, goField)) {
			sites.push({ fn: fn.name, file: fn.file, key: k, root: isEntry ? k : root });
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

	const traced = traceField(pkg, "fixture", "PublicAccess");
	if (!traced.carried) fail("a field read by a reachable builder traced to nothing");
	const keys = new Map(traced.sites.map((s) => [s.key, s.root]));
	for (const want of ["direct", "via_local", "via_branch", "in_branch"]) {
		if (!keys.has(want)) fail(`\`${want}\` derives from the field and was not traced`);
	}
	if (keys.get("direct") !== "nested_list") fail("a builder's keys were not attributed to the root tfvar it fills");
	if (keys.has("unrelated")) fail("`unrelated` derives from a different field and was attributed to this one");

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
