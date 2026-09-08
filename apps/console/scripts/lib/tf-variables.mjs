// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Reading a tofu template's ROOT variables as a DECLARED SURFACE: every knob the template says it
// accepts, with the type, the default and the prose a person needs to set it.
//
// `tf-wiring.mjs` already answers "is this name declared, and does a resource read it" — the two
// questions a CARRIER guard asks about one key it already knows. It deliberately keeps nothing else:
// no default, no description, no `sensitive`, and `rootVariableNames()` hands back bare strings. That
// is the whole surface a generic settings UI needs, so this reader collects it, reusing tf-wiring's
// HCL primitives rather than opening a second parser on the same grammar — two readers of one file
// format drift, and the one that drifts quietly is the one nothing pins.
//
// What it deliberately does NOT do:
//
//   · It does not decide whether a variable is REACHABLE. That is a fact about the Go provider
//     (`lib/go-passthrough.mjs`), not about the template, and a declared knob no passthrough carries
//     is exactly the state `gen-template-knobs.mjs` exists to make visible.
//   · It does not read a submodule. A ROOT tfvar is a promise only the root module makes — OpenTofu
//     DROPS a tfvars value for a variable the root never declared — so a module's same-named
//     variable is not evidence of anything. `readTfVariables` is handed the ROOT directory's files
//     and nothing below it; the caller keeps that boundary, the same one `readTfWiring`'s `rootDir`
//     argument exists to hold.
//   · It does not evaluate an expression. A `default` that is not a literal (an interpolation, a
//     `local.`, a function call) is reported as `unparsedDefault` and left OUT of `default`, because
//     a raw expression string handed to a UI as if it were a value is a value that is WRONG, and
//     wrong quietly — `default = local.region` would render to a user as the literal text
//     "local.region" in a field they then save.
//
// ROOT VARIABLES ARE NOT ONLY IN `variables.tf`. Every cloud declares some elsewhere — aws in
// `cost_guards.tf`, `registry-pull.tf`, `secrets-xacct.tf`, `helm-repo-pull.tf` and
// `connector-providers.tf`; the other four at least in `connector-providers.tf`. Reading only
// `variables.tf` would leave those knobs out of the manifest while `tf-wiring` still counts them as
// declared, so the two readers would disagree about the same template. Hand this every `.tf` file in
// the ROOT directory.

import { bracedSpanAt, objectAttributesIn, typeExpressionOf } from "./tf-wiring.mjs";

/** 1-indexed line number of an offset, so a manifest entry can point at a file and line. */
function lineAt(src, offset) {
	return src.slice(0, offset).split("\n").length;
}

/**
 * The coarse KIND of a tofu type expression — the one thing a generic control needs to pick a widget.
 *
 * `list(object({…}))` is a LIST: what a caller passes is a list, and the object shape below it is
 * carried separately in `objectAttributes`. An absent `type` is `any` in tofu, and so is an explicit
 * `any` — both mean the template makes no statement about what it accepts, which a UI must render as
 * "free-form", never as a typed control that would refuse a legal value.
 */
export function kindOf(typeExpr) {
	const t = (typeExpr ?? "").trim();
	if (!t) return "any";
	if (/^string\b/.test(t)) return "string";
	if (/^number\b/.test(t)) return "number";
	if (/^bool\b/.test(t)) return "bool";
	if (/^(list|set|tuple)\s*\(/.test(t)) return "list";
	if (/^map\s*\(/.test(t)) return "map";
	if (/^object\s*\(/.test(t)) return "object";
	return "any";
}

/** The `<attr> = …` expression of a variable body, brace/paren/bracket-matched, or null.
 *
 * The same walk `typeExpressionOf` does, for the attributes it does not read. It cannot be a
 * line-oriented match: `default` is routinely a multi-line list or object, and stopping at the first
 * newline would report `[` as the default of every list-valued knob. */
function attributeExpressionOf(body, attr) {
	const m = body.match(new RegExp(`(^|\\n)\\s*${attr}\\s*=\\s*`));
	if (!m) return null;
	let i = m.index + m[0].length;
	const start = i;
	let depth = 0;
	let inString = false;
	for (; i < body.length; i++) {
		const ch = body[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "\n" && depth <= 0) break;
		if (depth < 0) break;
	}
	return body.slice(start, i).trim();
}

/**
 * Parse an HCL LITERAL expression into a JSON value, or return `undefined` when it is not one.
 *
 * `undefined` is the load-bearing return: a `default` this cannot read must be absent from the
 * manifest rather than present as its own source text. The alternative — passing the raw expression
 * through — produces a manifest entry that looks exactly like a parsed one and is wrong, which is
 * the failure mode this whole file exists under (a reader whose broken branch is indistinguishable
 * from its working one).
 */
export function parseHclLiteral(expr) {
	const src = (expr ?? "").trim();
	if (!src) return undefined;
	let i = 0;

	/** Skip whitespace, `,` separators and `#`/`//` comments between literal elements. */
	const ws = () => {
		for (;;) {
			while (i < src.length && /[\s,]/.test(src[i])) i++;
			if (src.startsWith("#", i) || src.startsWith("//", i)) {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			return;
		}
	};

	/** One literal value at the cursor, or the FAIL sentinel when the text is an expression. */
	const FAIL = Symbol("not-a-literal");
	const value = () => {
		ws();
		if (i >= src.length) return FAIL;
		const ch = src[i];
		if (ch === '"') {
			i++;
			let out = "";
			while (i < src.length && src[i] !== '"') {
				if (src[i] === "\\") {
					const n = src[i + 1];
					out += n === "n" ? "\n" : n === "t" ? "\t" : n;
					i += 2;
					continue;
				}
				// `"${var.x}"` is an interpolation, not a literal — a template that defaults a knob to
				// another value must not be reported as defaulting it to the text `${var.x}`.
				if (src.startsWith("${", i)) return FAIL;
				out += src[i++];
			}
			if (src[i] !== '"') return FAIL;
			i++;
			return out;
		}
		if (ch === "[") {
			i++;
			const out = [];
			for (;;) {
				ws();
				if (src[i] === "]") {
					i++;
					return out;
				}
				if (i >= src.length) return FAIL;
				const v = value();
				if (v === FAIL) return FAIL;
				out.push(v);
			}
		}
		if (ch === "{") {
			i++;
			const out = {};
			for (;;) {
				ws();
				if (src[i] === "}") {
					i++;
					return out;
				}
				if (i >= src.length) return FAIL;
				let key;
				if (src[i] === '"') {
					key = value();
					if (key === FAIL || typeof key !== "string") return FAIL;
				} else {
					const k = src.slice(i).match(/^[A-Za-z_][\w-]*/);
					if (!k) return FAIL;
					key = k[0];
					i += k[0].length;
				}
				ws();
				if (src[i] !== "=" && src[i] !== ":") return FAIL;
				i++;
				const v = value();
				if (v === FAIL) return FAIL;
				out[key] = v;
			}
		}
		const word = src.slice(i).match(/^(true|false|null)\b/);
		if (word) {
			i += word[0].length;
			return word[1] === "null" ? null : word[1] === "true";
		}
		const num = src.slice(i).match(/^-?\d+(\.\d+)?/);
		if (num) {
			i += num[0].length;
			return Number(num[0]);
		}
		return FAIL;
	};

	const v = value();
	if (v === FAIL) return undefined;
	ws();
	// Trailing text means the expression continues past the literal (`[1] : x`, a ternary, a
	// concatenation) — the literal read is a PREFIX of something else, so it is not the value.
	if (i < src.length) return undefined;
	return v;
}

/**
 * The OUTERMOST object type's attributes, with the type and default each declares.
 *
 * `objectAttributesIn` (tf-wiring) is a flat sweep at any depth, which is right for the question it
 * answers — "does this cloud's tree know this name at all". It is the wrong shape here: a knob a user
 * sets on ONE ENTRY of `sqs_queues` is an attribute of that variable's outermost object, and a nested
 * object's attribute is a level deeper than anything a `provider_config` key can reach. Collecting
 * both flat would offer a user a key the merge cannot land.
 *
 * `optional(bool, true)` is unwrapped: the attribute is optional and its default is `true`. An
 * attribute declared without `optional(` is REQUIRED — the caller must supply it, so a generic
 * control that omitted it would produce a plan tofu refuses.
 *
 * @returns {Map<string, {typeExpr: string, kind: string, required: boolean, default?: unknown}>}
 */
export function objectAttributeTypesIn(typeExpr) {
	const out = new Map();
	const at = typeExpr.indexOf("object(");
	if (at === -1) return out;
	const span = bracedSpanAt(typeExpr, at);
	if (!span) return out;
	const body = typeExpr.slice(span.start + 1, span.end - 1);
	let depth = 0;
	let nameStart = 0;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "=" && depth === 0) {
			const name = body.slice(nameStart, i).trim();
			if (!/^[A-Za-z_]\w*$/.test(name)) continue;
			// The attribute's type runs to the next top-level separator — a newline or a comma, since
			// both spellings appear across the five templates.
			let j = i + 1;
			let d = 0;
			for (; j < body.length; j++) {
				const c = body[j];
				if (c === "(" || c === "{" || c === "[") d++;
				else if (c === ")" || c === "}" || c === "]") d--;
				else if ((c === "\n" || c === ",") && d <= 0) break;
			}
			const expr = body.slice(i + 1, j).trim();
			const opt = expr.match(/^optional\s*\(([\s\S]*)\)$/);
			const inner = opt ? opt[1] : expr;
			// `optional(list(string), [])` — split on the LAST top-level comma, because the type half
			// routinely holds commas of its own (`object({a = string, b = number})`).
			let cut = -1;
			let d2 = 0;
			for (let k = 0; k < inner.length; k++) {
				const c = inner[k];
				if (c === "(" || c === "{" || c === "[") d2++;
				else if (c === ")" || c === "}" || c === "]") d2--;
				else if (c === "," && d2 === 0) cut = k;
			}
			const attrType = (opt && cut >= 0 ? inner.slice(0, cut) : inner).trim();
			const entry = { typeExpr: attrType, kind: kindOf(attrType), required: !opt };
			if (opt && cut >= 0) {
				const parsed = parseHclLiteral(inner.slice(cut + 1));
				if (parsed !== undefined) entry.default = parsed;
			}
			out.set(name, entry);
			i = j;
			nameStart = j + 1;
		} else if (ch === "\n" && depth === 0) nameStart = i + 1;
	}
	return out;
}

/**
 * Every ROOT variable the handed files declare.
 *
 * @param {{path: string, text: string}[]} files the ROOT template directory's `.tf` files, comments
 *   already stripped by the caller (as `readTfFiles` in the guards does) — a COMMENTED-OUT
 *   declaration must never count as one.
 * @returns {{name: string, typeExpr: string, kind: string, default?: unknown, unparsedDefault: string|null,
 *   required: boolean, description: string, sensitive: boolean, path: string, line: number,
 *   objectAttributes: string[]}[]} one entry per declaration, in file/declaration order.
 */
export function readTfVariables(files) {
	const out = [];
	const seen = new Set();
	for (const file of files) {
		const src = file.text;
		let cursor = 0;
		for (const m of src.matchAll(/(^|\n)\s*variable\s+"([^"]+)"\s*\{/g)) {
			// A `variable` match inside a block already consumed is nested text, not a declaration.
			if (m.index < cursor) continue;
			const span = bracedSpanAt(src, m.index);
			if (!span) continue;
			cursor = span.end;
			const name = m[2];
			// Two declarations of one name is a template that will not `tofu validate`. Keep the FIRST
			// and say so at the call site's tripwire rather than silently keeping the last, which is
			// whichever file the directory listing happened to hand over second.
			if (seen.has(name)) continue;
			seen.add(name);
			const body = src.slice(span.start, span.end);
			const typeExpr = typeExpressionOf(body).trim();
			const defaultExpr = attributeExpressionOf(body, "default");
			const parsedDefault = defaultExpr === null ? undefined : parseHclLiteral(defaultExpr);
			const descExpr = attributeExpressionOf(body, "description");
			const sensitiveExpr = attributeExpressionOf(body, "sensitive");
			const entry = {
				name,
				typeExpr,
				kind: kindOf(typeExpr),
				// `required` is "no `default` attribute at all". `default = null` is a DEFAULT — tofu
				// accepts the variable unset and hands the module null — so a knob defaulted to null is
				// optional, and calling it required would make a UI demand a value tofu does not.
				required: defaultExpr === null,
				unparsedDefault: defaultExpr !== null && parsedDefault === undefined ? defaultExpr : null,
				description: typeof parseHclLiteral(descExpr) === "string" ? parseHclLiteral(descExpr) : "",
				sensitive: parseHclLiteral(sensitiveExpr) === true,
				path: file.path,
				// The offset of the `variable` KEYWORD, not of the match: the leading `(^|\n)` group
				// prefers `^` at offset 0, so a file whose first byte is a newline would report line 1.
				line: lineAt(src, m.index + m[0].indexOf("variable")),
				objectAttributes: [...objectAttributesIn(typeExpr)].sort(),
			};
			if (parsedDefault !== undefined) entry.default = parsedDefault;
			out.push(entry);
		}
	}
	return out;
}

/**
 * The tripwire, the same one `tf-wiring.mjs` and `go-tfvars-trace.mjs` carry: a reader that parsed
 * nothing declares nothing, and "declares nothing" is indistinguishable from "this cloud has no
 * knobs" to everything downstream — including a floor check, which would then be measuring zero
 * against zero.
 *
 * Throws rather than returning a flag: a caller cannot forget to check a throw.
 */
export function assertParsed(cloud, variables) {
	if (variables.length === 0) {
		throw new Error(
			`tf-variables parsed 0 root variables for ${cloud} — the reader is broken, not the template. ` +
				"A declaration reader that reads nothing produces an empty manifest and passes every check built on it.",
		);
	}
}

/**
 * Pin the reader against a fixture, in BOTH directions, every run.
 *
 * `assertParsed` catches a reader that stopped. It cannot catch one that reads the WRONG thing, and
 * that failure is silent in the direction that matters: a reader which calls every variable optional
 * with an empty description produces a manifest that parses, renders, and lies. So the fixture
 * carries one of each shape that actually appears in the five templates — every kind, a required
 * variable, a defaulted one, a `default = null`, a `sensitive` one, a multi-line list default, an
 * object default, a `list(object({…}))` whose attributes must be collected, and a default that is an
 * EXPRESSION rather than a literal (which must be absent, not stringified).
 */
export function selfCheck() {
	const files = [
		{
			path: "fx/variables.tf",
			text: `
variable "project_name" {
  description = "Project name."
  type        = string
}

variable "region" {
  description = "Where it runs."
  type        = string
  default     = "fsn1"
}

variable "node_count" {
  type    = number
  default = 3
}

variable "enable_thing" {
  type    = bool
  default = false
}

variable "cidrs" {
  type = list(string)
  default = [
    "10.0.0.0/16",
    "10.1.0.0/16",
  ]
}

variable "tags" {
  type    = map(string)
  default = { owner = "team", tier = "gold" }
}

variable "shaped" {
  description = "A list of objects."
  type = list(object({
    name     = string
    enabled  = optional(bool, true)
  }))
  default = []
}

variable "opaque" {
  type = list(any)
}

variable "untyped" {}

variable "token" {
  type      = string
  sensitive = true
  default   = null
}

variable "derived" {
  type    = string
  default = "\${var.region}-suffix"
}
`,
		},
		{
			path: "fx/connector-providers.tf",
			text: `
variable "connector_endpoint" {
  description = "Declared OUTSIDE variables.tf, which is where a fifth of the real ones live."
  type        = string
  default     = ""
}
`,
		},
	];

	/** Abort with the reason the reader is untrustworthy — never a flag the caller can ignore. */
	const fail = (msg) => {
		throw new Error(`tf-variables self-check failed: ${msg}. The reader is wrong; do not trust this run.`);
	};

	const vars = readTfVariables(files);
	const by = new Map(vars.map((v) => [v.name, v]));
	if (vars.length !== 12) fail(`expected 12 variables across the fixture, saw ${vars.length}`);
	if (!by.has("connector_endpoint")) fail("a root variable declared outside variables.tf was not seen");

	// Required vs defaulted — the direction that matters is a DEFAULTED knob read as required, which
	// makes a UI demand a value the template already has.
	if (!by.get("project_name").required) fail("`project_name` has no default and did not read as required");
	if (by.get("region").required) fail("`region` has a default and read as required");
	if (by.get("token").required) fail("`token` has `default = null`, which IS a default, and read as required");
	if (by.get("token").default !== null) fail("`token`'s `default = null` must survive as null, not as absent");

	// Kinds, one per rung.
	const kinds = { project_name: "string", node_count: "number", enable_thing: "bool", cidrs: "list", tags: "map", shaped: "list", opaque: "list", untyped: "any" };
	for (const [n, k] of Object.entries(kinds)) if (by.get(n).kind !== k) fail(`\`${n}\` should be kind ${k}, read as ${by.get(n).kind}`);

	// Defaults, parsed as VALUES.
	if (by.get("region").default !== "fsn1") fail("`region`'s string default was not parsed");
	if (by.get("node_count").default !== 3) fail("`node_count`'s number default was not parsed");
	if (by.get("enable_thing").default !== false) fail("`enable_thing`'s bool default was not parsed");
	if (JSON.stringify(by.get("cidrs").default) !== '["10.0.0.0/16","10.1.0.0/16"]') fail("`cidrs`' multi-line list default was not parsed");
	if (JSON.stringify(by.get("tags").default) !== '{"owner":"team","tier":"gold"}') fail("`tags`' object default was not parsed");
	if (JSON.stringify(by.get("shaped").default) !== "[]") fail("`shaped`'s empty-list default was not parsed");
	if ("default" in by.get("project_name")) fail("a variable with no `default` must carry no `default` key");

	// An expression default is NOT a value. Present-as-its-own-source-text is the wrong answer, and
	// it is wrong in a way a reader downstream cannot detect.
	if ("default" in by.get("derived")) fail("`derived` defaults to an interpolation and must not report a parsed default");
	if (by.get("derived").unparsedDefault === null) fail("`derived`'s unparsed default must be REPORTED, not dropped silently");

	if (by.get("region").description !== "Where it runs.") fail("`region`'s description was not read");
	if (by.get("node_count").description !== "") fail("a variable with no description must report an empty one, not undefined");
	if (!by.get("token").sensitive) fail("`token` is `sensitive = true` and did not read as sensitive");
	if (by.get("region").sensitive) fail("`region` is not sensitive and read as sensitive");

	// The object shape below a `list(object({…}))` is what a per-item knob is named in.
	if (JSON.stringify(by.get("shaped").objectAttributes) !== '["enabled","name"]') {
		fail(`\`shaped\`'s object attributes should be [enabled, name], read as ${JSON.stringify(by.get("shaped").objectAttributes)}`);
	}
	if (by.get("opaque").objectAttributes.length !== 0) fail("`list(any)` declares no attributes and must report none");

	// The ITEM half: a component modelled as one entry of a list/map variable is configured by the
	// OUTERMOST object's attributes, and a generic control needs each one's type and whether it is
	// required. `optional(bool, true)` is one attribute with a default, not a required `optional`.
	const attrs = objectAttributeTypesIn(by.get("shaped").typeExpr);
	if (attrs.size !== 2) fail(`expected 2 attributes on \`shaped\`, saw ${[...attrs.keys()].join(",")}`);
	if (!attrs.get("name").required) fail("`name = string` has no `optional(` and must read as required");
	if (attrs.get("name").kind !== "string") fail("`name`'s attribute kind was not read");
	if (attrs.get("enabled").required) fail("`enabled = optional(bool, true)` is optional and read as required");
	if (attrs.get("enabled").kind !== "bool") fail("`optional(bool, true)` must unwrap to kind bool, not to `optional`");
	if (attrs.get("enabled").default !== true) fail("`optional(bool, true)`'s default was not read");
	if (objectAttributeTypesIn(by.get("opaque").typeExpr).size !== 0) fail("`list(any)` declares no attributes and must report none");

	if (by.get("project_name").path !== "fx/variables.tf") fail("a declaration must carry the file it was read from");
	if (by.get("project_name").line !== 2) fail(`\`project_name\` is declared on line 2, read as ${by.get("project_name").line}`);
}

// `node scripts/lib/tf-variables.mjs --self-check` — the neighbouring readers each carry one, and it
// runs the same fixture the guards run on import, so a reader broken by an edit says so before any
// generator writes a manifest from it.
if (process.argv[1]?.endsWith("tf-variables.mjs") && process.argv.includes("--self-check")) {
	selfCheck();
	console.log("tf-variables self-check passed.");
}
