// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading a tofu template as WIRING: which names it declares, and which of those a resource or
// module argument actually reads.
//
// Nothing in this repo walked that edge before. `tfvars_completeness_test.go` reads the DECLARATION
// side (a variable with no default is required) and stops there; `check-offer-parity.mjs` reads the
// Go side and stops there. The hop between them — a variable that is declared and then read by
// nothing — is invisible to both, and it is a real defect shape: GCP's `cloud_storage_buckets`
// declares `uniform_access`, the console's provider fills it in, and the only resource that could
// honor it hardcodes `uniform_bucket_level_access = true`. The switch is carried the whole way and
// then dropped one line before it would have meant something.
//
// This is a deliberately small HCL reader, the same bargain `requiredTemplateVars` takes: a text
// scan whose failure mode is LOUD. It parses nothing it does not need and it counts what it parsed,
// so "the reader broke" can never present as "the templates are clean" — see `assertParsed`.
//
// Three things it must get right, because each one is a way to be silently wrong:
//
//   1. A declaration inside an `object({ … })` type is a declaration. Most of what a provider emits
//      is not a top-level variable at all — it is an attribute of one entry in a list-of-objects
//      (`bucket_configuration[*].block_public_acls`). Reading only `variable "x"` would score every
//      one of those as missing.
//   2. `any` / `list(any)` declares NO fields. Alibaba's `oss_buckets` is `list(any)`, so the
//      template makes no statement at all about which keys it accepts. That is UNMEASURABLE, and it
//      must never read as "declared" (which would hide a gap) nor as "missing" (which would invent
//      one). It is reported as its own state.
//   3. A read is a read from a RESOURCE or MODULE argument. A name that appears only inside its own
//      `variable` block (in a `validation` condition, say), only in an `output`, or only in a
//      `check` block is not something the plan builds from. `check` is the one that actually bit:
//      the first version of this file kept every block it did not explicitly carve out, so a
//      variable whose last surviving reference was a `check` assertion scored as honored. This repo
//      has been burnt by exactly that reading before — `tofu check` NEVER blocks an apply, so a
//      value that reaches only an assertion reaches nothing a user gets.
//   4. A ROOT tfvar is declared by the ROOT template, not by anything in the tree. A submodule that
//      happens to declare a variable of the same name (`sku` in modules/acr AND modules/service-bus)
//      is not evidence that the root accepts one — OpenTofu DROPS a tfvars value for a variable the
//      root never declared. The module hop stays on the READ half, where it belongs.

import { dirname, join, normalize } from "node:path";

/** Block types whose body is a CONSUMER — the places an argument can read a value and have it
 * reach the plan.
 *
 * Everything else is carved out, and the omissions are each deliberate: `variable` (a name used only
 * to validate itself builds nothing), `output` (reporting a value is not building from it), `check`
 * (an assertion never blocks an apply, so a value that reaches only a `check` reaches no
 * infrastructure), `terraform` (settings, which cannot take a variable), and `moved` (a state
 * refactor, which builds nothing new). */
const CONSUMER_BLOCKS = new Set(["resource", "module", "locals", "data", "provider", "import"]);

/** The `{ … }` block starting at or after `from`, brace-matched, WITH its braces. Returns the span
 * so the caller can carve the body out of the file and keep the rest. */
function bracedSpanAt(src, from) {
	const open = src.indexOf("{", from);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === "{") depth++;
		else if (src[i] === "}" && --depth === 0) return { start: open, end: i + 1 };
	}
	return null;
}

/** 1-indexed line number of an offset, so a finding can point at a file and line. */
function lineAt(src, offset) {
	return src.slice(0, offset).split("\n").length;
}

/** The `type = …` expression of a variable body, or "" when it declares none.
 *
 * Brace/paren-matched from the `=`, because the expression that matters most here nests several
 * levels deep (`list(object({ … optional(list(object({ … }))) … }))`) and a line-oriented read of it
 * stops at the first newline, which is where the interesting attributes start. */
function typeExpressionOf(body) {
	const m = body.match(/(^|\n)\s*type\s*=\s*/);
	if (!m) return "";
	let i = m.index + m[0].length;
	let depth = 0;
	const start = i;
	for (; i < body.length; i++) {
		const ch = body[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "\n" && depth <= 0) break;
		if (depth < 0) break;
	}
	return body.slice(start, i);
}

/** Attribute names an `object({ … })` type declares, at any nesting depth.
 *
 * `optional(bool, true)` is a VALUE, not an assignment, so only the `name =` form counts — which is
 * also why this cannot be a bare `\w+` sweep of the type expression. Over-collecting here (a nested
 * object's own attributes land in the same flat set) can only make this guard quieter, never
 * noisier, which is the direction the rest of the file already chose. */
function objectAttributesIn(typeExpr) {
	const out = new Set();
	for (const m of typeExpr.matchAll(/(^|[\n,{(])\s*([A-Za-z_]\w*)\s*=/g)) out.add(m[2]);
	return out;
}

/** Does this type expression declare a SHAPE (i.e. any fields at all)?
 *
 * `list(any)` is the shape that matters: it type-checks against anything, so the template is silent
 * about which keys it accepts. Treating that as "declared" would let a provider emit a key nothing
 * consumes and still read green. */
const declaresShape = (typeExpr) => /\bobject\s*\(/.test(typeExpr);

/**
 * Index one cloud's templates: what is declared, what is read, and how a root variable is threaded
 * into a module.
 *
 * Flat for the ATTRIBUTE half by design — a cloud's root variable and its module's variable are two
 * declarations of the same shape (`cloud_storage_buckets` → `buckets`), and which file an attribute
 * of that shape is named in is not the question this guard asks.
 *
 * Not flat for the ROOT-VARIABLE half, which is why `rootDir` is required. A root tfvar is a promise
 * only the root template can make: OpenTofu silently drops a tfvars value whose variable the root
 * module does not declare. A cloud-wide "is this name declared anywhere" answer lets an unrelated
 * submodule vouch for it — `sku` is declared by modules/acr and modules/service-bus, so a provider
 * emitting a ROOT `sku` would have read as declared while tofu threw the value away.
 *
 * @param {{path: string, text: string}[]} files a cloud's .tf files, comments already stripped
 * @param {string} rootDir the cloud's ROOT template directory — the only place a root tfvar counts
 *   as declared. Everything below it is a submodule, reachable only by being threaded into.
 */
export function readTfWiring(files, rootDir) {
	if (typeof rootDir !== "string" || !rootDir) {
		throw new Error("readTfWiring needs the cloud's ROOT template directory — without it a root tfvar cannot be told from a submodule's.");
	}
	const ROOT_DIR = normalize(rootDir);
	/** @type {Map<string, {path: string, line: number, typeExpr: string, shaped: boolean}>} */
	const variables = new Map();
	// The SAME declarations keyed by directory. Not derived from `variables` afterwards, because a
	// root variable and the module variable it feeds routinely share a name (`bucket_configuration`
	// is declared in aws/variables.tf AND in aws/modules/s3/variables.tf) — a flat name→declaration
	// map keeps one of the two, and which one depends on directory read order. Losing the module
	// declaration silently truncates every carrier chain to its first link.
	/** @type {Map<string, Map<string, object>>} */
	const byDir = new Map();
	const attributes = new Map();
	/** rootVarName → [{dir, arg}] — where a module block hands that variable on. */
	const threads = new Map();
	const varReads = new Set();
	const attrReads = new Set();
	// The same reads, kept per DIRECTORY. A cloud-wide read set answers "is this name consumed
	// somewhere in this cloud", and for a name like `versioning` or `enabled` that is not the
	// question — an unrelated module reading its own `versioning` would vouch for a bucket module
	// that stopped. Scoping the answer to the chain that actually carries the value is what makes a
	// planted gap reproduce instead of being rescued by a stranger.
	const readsByDir = new Map();
	/** The read sets for one directory, created on first use. */
	const bucketFor = (dir) => {
		if (!readsByDir.has(dir)) readsByDir.set(dir, { vars: new Set(), attrs: new Set() });
		return readsByDir.get(dir);
	};

	for (const file of files) {
		const src = file.text;
		// ONLY the bodies of CONSUMER_BLOCKS. Built by keeping what belongs rather than by carving
		// out what does not: the carve-out form leaves every block nobody thought to name — a
		// `check` block, most of all — silently counting as a place a value can be read.
		let consumer = "";

		let cursor = 0;
		for (const m of src.matchAll(/(^|\n)\s*(\w+)(\s+"[^"]*")*\s*\{/g)) {
			// A match inside a block already consumed is a NESTED block (`validation {`, `lifecycle {`),
			// not a top-level one. Its enclosing block has already decided whether it counts.
			if (m.index < cursor) continue;
			const kind = m[2];
			const span = bracedSpanAt(src, m.index);
			if (!span) continue;
			cursor = span.end;
			if (kind === "variable") {
				const name = m[3]?.trim().replace(/^"|"$/g, "");
				const body = src.slice(span.start, span.end);
				const typeExpr = typeExpressionOf(body);
				if (name) {
					const decl = {
						path: file.path,
						line: lineAt(src, m.index),
						typeExpr,
						shaped: declaresShape(typeExpr),
					};
					variables.set(name, decl);
					const dir = normalize(dirname(file.path));
					if (!byDir.has(dir)) byDir.set(dir, new Map());
					byDir.get(dir).set(name, decl);
					for (const attr of objectAttributesIn(typeExpr)) {
						if (!attributes.has(attr)) attributes.set(attr, { path: file.path, line: lineAt(src, m.index), owner: name });
					}
				}
				continue;
			}
			if (CONSUMER_BLOCKS.has(kind)) consumer += `${src.slice(m.index, span.end)}\n`;
		}

		const here = bucketFor(normalize(dirname(file.path)));
		/** Record a `var.<n>` read, cloud-wide and for this file's directory. */
		const addVar = (n) => {
			varReads.add(n);
			here.vars.add(n);
		};
		/** Record an attribute read (`.<n>`, `lookup(x, "<n>")`, `x["<n>"]`), cloud-wide and per-directory. */
		const addAttr = (n) => {
			attrReads.add(n);
			here.attrs.add(n);
		};
		for (const m of consumer.matchAll(/\bvar\.([A-Za-z_]\w*)/g)) addVar(m[1]);
		for (const m of consumer.matchAll(/\.([A-Za-z_]\w*)/g)) addAttr(m[1]);
		for (const m of consumer.matchAll(/\blookup\(\s*[^,()]+,\s*"([A-Za-z_]\w*)"/g)) addAttr(m[1]);
		for (const m of consumer.matchAll(/\[\s*"([A-Za-z_]\w*)"\s*\]/g)) addAttr(m[1]);

		// Module threading: `module "x" { source = "./modules/y"  arg = var.root }`.
		for (const m of consumer.matchAll(/\bmodule\s+"[^"]*"\s*\{/g)) {
			const span = bracedSpanAt(consumer, m.index);
			if (!span) continue;
			const body = consumer.slice(span.start, span.end);
			const src2 = body.match(/\n\s*source\s*=\s*"([^"]+)"/);
			if (!src2 || !/^\.{1,2}\//.test(src2[1])) continue; // an external module is an opaque box
			const dir = normalize(join(dirname(file.path), src2[1]));
			for (const a of body.matchAll(/\n\s*([A-Za-z_]\w*)\s*=\s*([^\n]*)/g)) {
				if (a[1] === "source") continue;
				for (const r of a[2].matchAll(/\bvar\.([A-Za-z_]\w*)/g)) {
					if (!threads.has(r[1])) threads.set(r[1], []);
					threads.get(r[1]).push({ dir, arg: a[1] });
				}
			}
		}
	}

	/**
	 * Every declaration that carries `root`'s shape: the root variable itself, plus the module
	 * variables it is handed to. Used only to answer "does ANYTHING on this path declare fields" —
	 * an all-`any` chain is unmeasurable, and saying so is the whole point.
	 *
	 * The chain STARTS at the root directory, always. `root` is a name the provider emits as a
	 * tfvar, and a tfvar is a promise the root template makes; starting from a cloud-wide name
	 * lookup would begin the walk at whichever same-named submodule variable happened to be indexed
	 * last, which is both non-deterministic and the wrong module.
	 */
	function carriersOf(root) {
		const out = [];
		const seen = new Set();
		const queue = [{ name: root, dir: ROOT_DIR }];
		while (queue.length) {
			const cur = queue.shift();
			const key = `${cur.dir}:${cur.name}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const decl = byDir.get(cur.dir)?.get(cur.name);
			if (decl) out.push({ name: cur.name, ...decl });
			for (const t of threads.get(cur.name) ?? []) queue.push({ name: t.arg, dir: t.dir });
		}
		return out;
	}

	// EVERY member below is consumed by check-offer-parity.mjs. That is a rule, not an observation.
	// This object shipped with three that were not — `hasVariable`, `isVarRead`, `declarationOf` —
	// and `hasVariable` was `variables.has(name)`: the tree-scoped "is it declared anywhere" answer
	// that the ROOT-vs-submodule fix existed to stop anyone from asking. An unused member cannot be
	// wrong today, which is exactly why it is dangerous: nothing reds when it drifts, and it sits
	// there reading like the obvious thing to reach for. The two loose members that remain
	// (`isDeclared`, `isRead`) are loose ON PURPOSE and are marked so, because their one caller asks
	// them an evidence question, never a verdict question.
	return {
		/**
		 * Is this name declared as a variable of the ROOT template?
		 *
		 * The only honest question to ask of a ROOT tfvar. OpenTofu drops a tfvars value whose
		 * variable the root module does not declare, so a submodule declaring the same name buys the
		 * value nothing — the switch never reaches the plan at all.
		 */
		hasRootVariable: (name) => byDir.get(ROOT_DIR)?.has(name) ?? false,
		/** Every ROOT variable name this cloud declares.
		 *
		 * `hasRootVariable` answers the question one name at a time, which is all the carrier guards
		 * ever need — they start from a field and ask whether it landed. check-template-parity.mjs
		 * asks the inverse: what does this cloud declare that another does not? That cannot be
		 * spelled as a series of has-checks without already knowing the answer, so the names are
		 * exposed rather than the caller re-parsing variables.tf and drifting from this reader. */
		rootVariableNames: () => [...(byDir.get(ROOT_DIR)?.keys() ?? [])],
		/** Is this name declared anywhere — a variable, or an attribute of an object type?
		 *
		 * DELIBERATELY LOOSE, and never a verdict: use `hasRootVariable` (a root tfvar) or
		 * `shapeIsDeclared` (an attribute of an object) to decide whether a value survives. This
		 * answers "does this cloud's tree know this name at all", which is an EVIDENCE question —
		 * `optionEvidence` uses it to decide whether an option is worth accusing anyone about. */
		isDeclared: (name) => variables.has(name) || attributes.has(name),
		/** Is this name read by a resource/module/locals/data argument, anywhere in this cloud?
		 *
		 * Loose in the same way and for the same one caller: cloud-wide, so an unrelated module's
		 * read counts. Scope a real verdict with `isReadOnChain`. */
		isRead: (name) => varReads.has(name) || attrReads.has(name),
		/**
		 * Is `key` read ON THE CHAIN that carries `root` — the directory `root` is declared in, and
		 * every module directory it is threaded into?
		 *
		 * The scoped question, and the one that matters. `varsOnly` is for a ROOT tfvar, which can
		 * only ever be consumed as `var.<name>`; an attribute of an object needs the looser sweep,
		 * because it is reached as `each.value.<name>`, `try(x.<name>, …)` or `lookup(x, "<name>")`.
		 */
		isReadOnChain(root, key, varsOnly = false) {
			const dirs = new Set(carriersOf(root).map((c) => normalize(dirname(c.path))));
			for (const dir of dirs) {
				const reads = readsByDir.get(dir);
				if (!reads) continue;
				if (reads.vars.has(key)) return true;
				if (!varsOnly && reads.attrs.has(key)) return true;
			}
			return false;
		},
		carriersOf,
		/**
		 * Does the chain carrying `root` declare a shape at all?
		 *
		 * `null` when `root` is not declared here (a different gap — the provider emits a tfvar the
		 * template never heard of); `false` when every carrier is `any`/`list(any)`, which is the
		 * UNMEASURABLE state.
		 */
		shapeIsDeclared(root) {
			const carriers = carriersOf(root);
			if (!carriers.length) return null;
			return carriers.some((c) => c.shaped);
		},
		counts: {
			variables: variables.size,
			rootVariables: byDir.get(ROOT_DIR)?.size ?? 0,
			attributes: attributes.size,
			reads: varReads.size + attrReads.size,
		},
	};
}

/**
 * The tripwire, copied in shape from `tfvars_completeness_test.go`: a reader that parsed nothing
 * reports no gaps, and "no gaps" is indistinguishable from "clean" to everyone downstream.
 *
 * Throws rather than returning a flag on purpose — the caller cannot forget to check a throw.
 */
export function assertParsed(cloud, wiring) {
	if (wiring.counts.variables === 0) {
		throw new Error(
			`tf-wiring parsed 0 variables for ${cloud} — the reader is broken, not the template. ` +
				`A wiring probe that reads nothing finds no gaps and reports success.`,
		);
	}
	// A rootDir that does not match where the files actually live leaves every ROOT tfvar reading as
	// undeclared. That is loud rather than silent — a wall of false gaps — but a wall of false gaps
	// is answered by baselining them, which would bake the misconfiguration in. Say what it is.
	if (wiring.counts.rootVariables === 0) {
		throw new Error(
			`tf-wiring parsed 0 ROOT variables for ${cloud} — the root template directory handed to ` +
				`readTfWiring does not match the paths of the files handed with it, so every root tfvar ` +
				`would read as undeclared.`,
		);
	}
}

/**
 * Pin the reader against a fixture, in BOTH directions, every run.
 *
 * `assertParsed` catches a reader that stopped reading. It cannot catch one that reads the wrong
 * thing — and that failure is silent in the direction that matters, because a reader which thinks
 * every name is read finds no gaps and passes. `TestRequiredTemplateVars` exists for exactly this
 * reason next to the tofu-side reader in packages/core/cloud; this is the same idea where it can run
 * without a test framework, so CI cannot skip it and a local run cannot forget it.
 *
 * The fixture is the set of shapes that have actually bitten: a root variable threaded into a
 * module, a `list(object({…}))` that declares attributes, a `list(any)` that declares none, a read
 * through `each.value`, a name that appears ONLY in its own declaration, a name whose last
 * surviving reference is a `check` assertion, and a name declared ONLY by a submodule.
 */
export function selfCheck() {
	const files = [
		{
			path: "fx/variables.tf",
			text: `
variable "shaped_list" {
  type = list(object({
    name       = string
    is_read    = optional(bool, false)
    never_read = optional(bool, true)
  }))
  default = []
}

variable "opaque_list" {
  type = list(any)
}

variable "plain_toggle" {}

variable "checked_only" {}
`,
		},
		{
			path: "fx/main.tf",
			text: `
module "child" {
  source      = "./modules/child"
  entries     = var.shaped_list
  opaque      = var.opaque_list
}

resource "fake_thing" "t" {
  count = var.plain_toggle ? 1 : 0
}

check "assertion_is_not_wiring" {
  assert {
    condition     = !var.checked_only || var.plain_toggle
    error_message = "checked_only needs plain_toggle."
  }
}

output "echoed" {
  value = var.checked_only
}
`,
		},
		{
			path: "fx/modules/child/variables.tf",
			text: `
variable "entries" {
  type = list(object({
    name    = string
    is_read = optional(bool, false)
  }))
}

variable "opaque" {
  type = list(any)
}

variable "submodule_only" {}
`,
		},
		{
			path: "fx/modules/child/main.tf",
			text: `
resource "fake_child" "c" {
  for_each = { for e in var.entries : e.name => e }
  enabled  = each.value.is_read
  loose    = try(each.value.opaque_key, null)
  sized    = var.submodule_only
}
`,
		},
	];

	const w = readTfWiring(files, "fx");
	/** Abort the run with the reason the reader is untrustworthy — never a flag the caller can ignore. */
	const fail = (msg) => {
		throw new Error(`tf-wiring self-check failed: ${msg}. The reader is wrong; do not trust this run.`);
	};

	if (w.counts.variables !== 7) fail(`expected 7 variables across the fixture, saw ${w.counts.variables}`);
	if (w.counts.rootVariables !== 4) fail(`expected 4 ROOT variables in fx/, saw ${w.counts.rootVariables}`);
	if (!w.isDeclared("is_read")) fail("`is_read` is declared in an object type and was not seen");
	if (!w.isDeclared("never_read")) fail("`never_read` is declared in an object type and was not seen");
	if (w.isDeclared("opaque_key")) fail("`opaque_key` is declared nowhere and was reported as declared");

	// A ROOT tfvar is the root template's promise. A submodule declaring the name is not that promise:
	// tofu drops a tfvars value the root never declared, so crediting the submodule hides the drop.
	// Both directions, asked with the two members that survive: the LOOSE one must see it (or the
	// fixture proves nothing about scope, only about parsing), and the ROOT one must not.
	if (!w.isDeclared("submodule_only")) fail("`submodule_only` is declared in the child module and was not seen at all");
	if (w.hasRootVariable("submodule_only")) fail("`submodule_only` is declared only by a SUBMODULE and was reported as a root variable");
	if (!w.hasRootVariable("plain_toggle")) fail("`plain_toggle` is declared by the root template and was not reported as a root variable");
	if (w.shapeIsDeclared("submodule_only") !== null) fail("a name the ROOT does not declare must report null, whatever a submodule declares");

	// The direction that matters: a name declared and read by NOTHING must not read as read.
	if (w.isReadOnChain("shaped_list", "never_read")) fail("`never_read` is read by nothing and was reported as read");
	if (!w.isReadOnChain("shaped_list", "is_read")) fail("`is_read` is read via each.value in the child module and was not seen");
	if (!w.isReadOnChain("opaque_list", "opaque_key")) fail("`opaque_key` is read via try() in the child module and was not seen");
	if (!w.isReadOnChain("plain_toggle", "plain_toggle", true)) fail("`plain_toggle` is read as var.plain_toggle and was not seen");

	// A `check` assertion and an `output` build nothing. `tofu check` never blocks an apply, so a
	// variable whose only surviving reference is an assertion is a switch that reaches no resource.
	if (w.isReadOnChain("checked_only", "checked_only", true)) {
		fail("`checked_only` is referenced only by a `check` block and an `output` and was reported as read");
	}
	if (w.isRead("checked_only")) fail("`checked_only` is referenced only by a `check` block and an `output` and was reported as read cloud-wide");

	// Shape: `list(object({…}))` declares fields on the chain, `list(any)` declares none.
	if (w.shapeIsDeclared("shaped_list") !== true) fail("`shaped_list` declares an object type and did not read as shaped");
	if (w.shapeIsDeclared("opaque_list") !== false) fail("`opaque_list` is list(any) on both ends and must be UNMEASURABLE, not declared");
	if (w.shapeIsDeclared("nonexistent") !== null) fail("an undeclared root must report null, not a shape verdict");

	// The chain has to reach the module, or every scoped read answer is decided by the root alone.
	if (w.carriersOf("shaped_list").length !== 2) fail("the module thread was not followed — carriers should be root + child");
}
