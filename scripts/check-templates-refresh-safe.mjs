#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CI guard: project templates must survive `tofu plan -refresh-only` (#3351).
 *
 * WHAT BREAKS. Refresh-only refreshes what is IN STATE; it never plans a create. A resource whose
 * `count` is 1 in the config but which has no instance in state is therefore an EMPTY TUPLE, and
 * any `[0]` index into it aborts the whole plan in seconds:
 *
 *     Error: Invalid index … azurerm_user_assigned_identity.aks is empty tuple
 *
 * Measured on OpenTofu 1.9.0 — the engine the runner applies with — and on 1.12.3:
 *
 *   | predicate | in state | mode         | result                                              |
 *   |-----------|----------|--------------|-----------------------------------------------------|
 *   | false     | no       | refresh-only | clean: an untaken conditional arm is never evaluated |
 *   | true      | no       | refresh-only | **Invalid index — the whole plan aborts**           |
 *   | true      | no       | normal plan  | clean: it plans the create                          |
 *   | true      | no       | refresh-only | clean with `one(x[*].attr)`                         |
 *   | true      | no       | refresh-only | clean with `try(x[0].attr, …)`                      |
 *
 * So this is invisible to provisioning and to every e2e that applies and checks in one run. It
 * bites exactly one population: environments whose template has advanced past their last apply —
 * which is the population drift detection exists to serve. Drift detection was dead on a
 * production environment for five weeks, failing in 13 seconds with nothing else reported.
 *
 * WHAT THIS ASKS — the cheapest sound question. For every RESOURCE or DATA SOURCE counted 0-or-1, is there an
 * unprotected `[0]` index into it in the same module directory? No HCL evaluation, no attempt to
 * know which environments are behind: `one(x[*].attr)` is correct wherever `x[0].attr` was, so
 * over-reporting costs a safer expression and nothing else.
 *
 * WHAT IT DOES NOT COVER, each for a measured reason:
 *
 *   - **`module.x[0]` references.** `one(module.x[*].out)` is NOT a safe mechanical rewrite: a
 *     splat depends on the module as a WHOLE rather than on one instance, and on aws that turns
 *     `local.eso_secret_arns` / `local.secrets_kms_key_arns` — which `module.eks` itself consumes
 *     — into a dependency CYCLE that `tofu validate` rejects. The other candidate,
 *     `try(module.x[0].out, null)`, keeps the edge but silently swallows a typo'd module output
 *     (measured: `tofu validate` reports Success on `try(module.m[0].nonexistent, null)`). Module
 *     references need per-site judgement, not a codemod. They are COUNTED and PRINTED on success
 *     rather than passed over, so this guard cannot be read as covering them.
 *   - a resource counted by anything but a 0-or-1 conditional (`count = var.vswitch_count`) —
 *     there `[0]` is a real index and `one()` would be wrong, erroring on the second instance.
 *   - `try(…)`-wrapped references, and the template's own `length(x) > 0 ? x[0]… : …` idiom: both
 *     measured refresh-safe above.
 *   - `depends_on`, and `moved`/`removed`/`import` blocks: not value expressions. The last three
 *     accept "a single static variable reference" only, so `one()` there is a hard error.
 *
 * Usage:
 *   node scripts/check-templates-refresh-safe.mjs [root]     # default infra/templates/project
 *   node scripts/check-templates-refresh-safe.mjs --self-test
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A `count` expression that can only ever be 0 or 1. */
const ZERO_OR_ONE = /\?\s*1\s*:\s*0|\?\s*0\s*:\s*1/;

/** Every directory under `root` holding .tf files — a template or one of its modules. */
function moduleDirs(dir, out = []) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	if (entries.some((e) => e.isFile() && e.name.endsWith(".tf"))) out.push(dir);
	for (const e of entries) {
		if (e.isDirectory() && !e.name.startsWith("."))
			moduleDirs(path.join(dir, e.name), out);
	}
	return out;
}

/**
 * Blank out `#`/`//` comments and heredoc bodies, preserving line and column positions.
 *
 * Block HEADERS are read from this form, not from the string-stripped one below:
 * `resource "type" "name"` is nothing but quoted strings, and masking those first is how the
 * first draft of this guard reported "0 counted blocks" over a tree full of them. The
 * examined-counts line printed on success is what caught that.
 */
function stripComments(src) {
	let inBlockComment = false;
	const lines = src.split("\n").map((line) => {
		let quoted = false;
		let escaped = false;
		let out = "";
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					out += "  ";
					i++;
					inBlockComment = false;
				} else out += " ";
				continue;
			}
			if (quoted) {
				out += ch;
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') quoted = false;
				continue;
			}
			if (ch === '"') {
				quoted = true;
				out += ch;
				continue;
			}
			if (ch === "/" && next === "*") {
				out += "  ";
				i++;
				inBlockComment = true;
				continue;
			}
			if (ch === "#" || (ch === "/" && next === "/")) {
				out += " ".repeat(line.length - i);
				break;
			}
			out += ch;
		}
		return out.padEnd(line.length, " ");
	});
	let heredoc = null;
	return lines
		.map((line) => {
			if (heredoc) {
				if (new RegExp(`^\\s*${heredoc}\\s*$`).test(line)) heredoc = null;
				return " ".repeat(line.length);
			}
			const withoutStrings = line.replace(/"(?:[^"\\]|\\.)*"/g, (m) =>
				" ".repeat(m.length),
			);
			const open = withoutStrings.match(/<<-?\s*([A-Z][A-Z0-9_]*)/);
			if (open) heredoc = open[1];
			return line;
		})
		.join("\n");
}

/**
 * Additionally blank out quoted strings, for the pass that looks for REFERENCES.
 *
 * A reference inside a string is prose: `error_message = "… module.acr[0] would fail the apply"`
 * is a sentence about this very bug, and flagging it would send a reader to edit an error message.
 */
function stripNonCode(src) {
	const clean = stripComments(src);
	let out = "";
	let inString = false;
	let escaped = false;
	let interpolationDepth = 0;
	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i];
		const next = clean[i + 1];
		if (!inString) {
			if (ch === '"') {
				inString = true;
				out += " ";
			} else out += ch;
			continue;
		}
		if (interpolationDepth > 0) {
			out += ch;
			if (ch === "{") interpolationDepth++;
			else if (ch === "}") interpolationDepth--;
			continue;
		}
		if (escaped) {
			escaped = false;
			out += " ";
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			out += " ";
			continue;
		}
		if (ch === '"') {
			inString = false;
			out += " ";
			continue;
		}
		if (ch === "$" && next === "{") {
			out += "${";
			i++;
			interpolationDepth = 1;
			continue;
		}
		out += ch === "\n" ? "\n" : " ";
	}
	return out;
}

/** Return the closing brace for a block in position-preserving code, or -1. */
function closingBrace(code, opening) {
	let depth = 0;
	for (let i = opening; i < code.length; i++) {
		if (code[i] === "{") depth++;
		else if (code[i] === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Read a possibly multiline count expression from one balanced block body. */
function countExpression(block) {
	const match = /^\s*count\s*=\s*/m.exec(block);
	if (!match) return null;
	let value = "";
	let depth = 0;
	for (let i = match.index + match[0].length; i < block.length; i++) {
		const ch = block[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		if (ch === "\n" && depth === 0) break;
		value += ch;
	}
	return value.replace(/\s+/g, " ").trim();
}

/** True when the reference at `column` sits inside a `try(…)` call on this line. */
function isInsideTry(line, column) {
	const before = line.slice(0, column);
	let depth = 0;
	for (let i = before.length - 1; i >= 0; i--) {
		const ch = before[i];
		if (ch === ")") depth++;
		else if (ch === "(") {
			// Every ENCLOSING call, not just the innermost: the reference in
			// `try(length(trimspace(x[0].y)) > 0, false)` is three calls deep and still protected.
			// Stopping at the first `(` reported that line as a finding.
			if (depth === 0) {
				if (/\btry$/.test(before.slice(0, i))) return true;
			} else depth--;
		}
	}
	return false;
}

/**
 * True when the reference is protected by the template's own `length(<same address>)` idiom.
 *
 * With no instance in state the length is 0, the conditional takes its other arm, and an untaken
 * arm is never evaluated — measured. This shape must also NOT be rewritten: it is instance-scoped
 * where a splat is not (see the module note in the header).
 */
function isLengthGuarded(line, address) {
	return line.includes(`length(${address})`);
}

/**
 * True for `depends_on`, or a `moved`/`removed`/`import` block's `to`/`from` — not values.
 *
 * The backward walk stops at the first CLOSED list (`]`), not at the enclosing `}`. Without that
 * it read a `depends_on = [...]` nine lines above an ordinary argument as still open and skipped
 * the argument — which is how the first draft of this guard passed over `aks.tf`, one of the two
 * lines named in #3351. A fixture cannot catch that; re-running the guard over the real tree with
 * the fix reverted is what did.
 */
function isNonEvaluatedContext(lines, index) {
	for (let i = index; i >= 0 && i > index - 12; i--) {
		const line = lines[i];
		// A depends_on that OPENS and CLOSES on one line is already behind us — treating it as
		// still open silenced every argument for eleven lines after it, which is how the first
		// draft passed over `aks.tf`, one of the two lines #3351 names.
		if (/^\s*depends_on\s*=\s*\[/.test(line)) {
			// On the reference's OWN line it is inside the list. On an earlier line it only still
			// covers us if the list did not close there.
			return i === index || !line.includes("]");
		}
		if (
			/^\s*(to|from)\s*=/.test(line) &&
			lines
				.slice(Math.max(0, i - 8), i + 1)
				.some((l) => /^(moved|removed|import)\s*\{/.test(l))
		) {
			return true;
		}
		if (i !== index && /^\s*[\]}]/.test(line)) return false;
	}
	return false;
}

/** An address indexed with a literal `[0]`. */
const REFERENCE =
	/(?<![\w.])((?:module\.[a-z0-9_]+)|(?:data\.[a-z][a-z0-9_]*\.[a-z0-9_]+)|(?:[a-z][a-z0-9_]*\.[a-z0-9_]+))\[0\]/gi;

/**
 * Scan a template root for indexes into counted blocks.
 *
 * @returns {{findings: string[], modules: string[], multiCount: string[], files: number, dirs: number, counted: number}}
 */
function scanRoot(root) {
	const findings = [];
	const modules = [];
	const multiCount = [];
	let files = 0;
	let dirs = 0;
	let counted = 0;

	for (const dir of moduleDirs(root)) {
		dirs++;
		const tfFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".tf"));
		/** address → its `count` expression, for every counted block in this directory. */
		const countedBlocks = new Map();

		for (const file of tfFiles) {
			const raw = fs.readFileSync(path.join(dir, file), "utf8");
			const src = stripComments(raw);
			const code = stripNonCode(raw);
			const blocks =
				/^(resource|data|module)\s+"([^"]+)"(?:\s+"([^"]+)")?\s*\{/gm;
			let block;
			while ((block = blocks.exec(src))) {
				const [, kind, first, second] = block;
				const address =
					kind === "module"
						? `module.${first}`
						: kind === "data"
							? `data.${first}.${second}`
							: `${first}.${second}`;
				const opening = block.index + block[0].lastIndexOf("{");
				const closing = closingBrace(code, opening);
				if (closing < 0) continue;
				const count = countExpression(code.slice(opening + 1, closing));
				if (count !== null) {
					countedBlocks.set(address, count);
					counted++;
				}
			}
		}

		for (const file of tfFiles) {
			files++;
			const lines = stripNonCode(
				fs.readFileSync(path.join(dir, file), "utf8"),
			).split("\n");
			lines.forEach((line, i) => {
				REFERENCE.lastIndex = 0;
				let ref;
				while ((ref = REFERENCE.exec(line))) {
					const address = ref[1];
					if (!countedBlocks.has(address)) continue;
					const count = countedBlocks.get(address);
					const where = `${path.join(dir, file)}:${i + 1}`;
					if (isNonEvaluatedContext(lines, i)) continue;
					if (isInsideTry(line, ref.index)) continue;
					if (isLengthGuarded(line, address)) continue;
					if (!ZERO_OR_ONE.test(count)) {
						multiCount.push(`${where}: ${address} (count = ${count})`);
						continue;
					}
					if (address.startsWith("module.")) {
						modules.push(`${where}: ${address}[0]`);
						continue;
					}
					findings.push(`${where}: ${address}[0] — count = ${count}`);
				}
			});
		}
	}

	return { findings, modules, multiCount, files, dirs, counted };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
// Fixtures are strings here, written to a temp dir — hermetic, and independent of whatever the
// real templates happen to contain today. A guard whose only evidence is "it passes on the tree"
// cannot tell "found nothing" from "asks nothing".

const FIXTURE = `
resource "azurerm_user_assigned_identity" "aks" {
  count = local.encrypt ? 1 : 0
}

resource "azurerm_user_assigned_identity" "dns" {
  count = var.provision_aks ? 1 : 0
}

resource "alicloud_vswitch" "many" {
  count = var.vswitch_count
}

module "cluster" {
  source = "./mod"
  count  = var.provision ? 1 : 0
}

data "example_item" "url" {
  count = var.provision ? 1 : 0
}

resource "example_item" "multi" {
  count = (
    var.provision ? 1 : 0
  )
}

resource "example_item" "uncounted" {
  note = "the previous block's count must not leak here"
}

resource "consumer" "c" {
  identity   = local.encrypt ? azurerm_user_assigned_identity.aks[0].id : ""
  tried      = try(azurerm_user_assigned_identity.dns[0].id, "")
  nested     = try(length(trimspace(azurerm_user_assigned_identity.dns[0].id)) > 0, false)
  guarded    = length(azurerm_user_assigned_identity.dns) > 0 ? azurerm_user_assigned_identity.dns[0].id : ""
  vswitch    = alicloud_vswitch.many[0].id
  from_mod   = var.provision ? module.cluster[0].id : ""
  url         = "https://\${data.example_item.url[0].id}"
  comparison  = "compare A << B"
  after_text  = var.provision ? example_item.multi[0].id : ""
  uncounted   = example_item.uncounted[0].id
  described  = "azurerm_user_assigned_identity.aks[0].id is what used to break"
  # a comment naming azurerm_user_assigned_identity.aks[0].id is prose, not code
  depends_on = [azurerm_user_assigned_identity.aks[0]]
}

resource "heredoc_consumer" "c" {
  document = <<-DOC
    example_item.multi[0].id is prose inside a heredoc
  DOC
}

moved {
  from = azurerm_user_assigned_identity.aks[0]
  to   = azurerm_user_assigned_identity.dns[0]
}
`;

function selfTest() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refresh-safe-selftest-"));
	fs.writeFileSync(path.join(dir, "main.tf"), FIXTURE);
	const result = scanRoot(dir);

	let failures = 0;
	const check = (label, ok, detail = "") => {
		if (ok) console.log(`  ✓ ${label}`);
		else {
			failures++;
			console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
		}
	};

	check(
		"flags all three unprotected conditional indexes and no prose/uncounted reference",
		result.findings.length === 3 &&
			result.findings.some((f) =>
				f.includes("azurerm_user_assigned_identity.aks[0]"),
			) &&
			result.findings.some((f) => f.includes("data.example_item.url[0]")) &&
			result.findings.some((f) => f.includes("example_item.multi[0]")),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	check(
		"preserves interpolation code after https:// inside a quoted string",
		result.findings.some((f) => f.includes("data.example_item.url[0]")),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	check(
		"a << token inside a string does not hide the remainder of the file",
		result.findings.some((f) => f.includes("example_item.multi[0]")),
		`findings: ${JSON.stringify(result.findings)}`,
	);
	check(
		"reports the module reference separately rather than as a finding",
		result.modules.length === 1 &&
			result.modules[0].includes("module.cluster[0]"),
		`modules: ${JSON.stringify(result.modules)}`,
	);
	check(
		"reports a non-boolean count as not covered",
		result.multiCount.length === 1 &&
			result.multiCount[0].includes("alicloud_vswitch.many"),
		`multiCount: ${JSON.stringify(result.multiCount)}`,
	);
	check(
		"counts what it examined",
		result.files === 1 && result.counted === 6,
		`${result.files} file(s), ${result.counted} counted block(s)`,
	);

	fs.mkdirSync(path.join(dir, ".terraform", "vendor"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".terraform", "vendor", "main.tf"), FIXTURE);
	const withoutVendor = scanRoot(dir);
	check(
		"does not recurse into .terraform vendor trees",
		withoutVendor.files === 1,
		`${withoutVendor.files} file(s) examined`,
	);

	// The anti-probe. Every assertion above is about what the detector REJECTS; without this one
	// they would all still hold for a detector that flags the first line of every file.
	const fixed = FIXTURE.replace(
		'local.encrypt ? azurerm_user_assigned_identity.aks[0].id : ""',
		'local.encrypt ? one(azurerm_user_assigned_identity.aks[*].id) : ""',
	)
		.replace("data.example_item.url[0].id", "one(data.example_item.url[*].id)")
		.replace("example_item.multi[0].id", "one(example_item.multi[*].id)");
	fs.writeFileSync(path.join(dir, "main.tf"), fixed);
	const after = scanRoot(dir);
	check(
		"the same fixture reports nothing once the index is written as one()",
		after.findings.length === 0,
		`findings: ${JSON.stringify(after.findings)}`,
	);

	fs.rmSync(dir, { recursive: true, force: true });
	if (failures > 0) {
		console.error(
			`\ncheck-templates-refresh-safe self-test: ${failures} failure(s)`,
		);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const root = process.argv[2] ?? "infra/templates/project";
	const { findings, modules, multiCount, files, dirs, counted } =
		scanRoot(root);
	const examined = `examined ${files} .tf file(s) in ${dirs} module dir(s); ${counted} counted block(s)`;

	if (findings.length > 0) {
		console.error(
			`❌ refresh-safety violation — ${findings.length} unprotected index(es) into a counted resource or data source:`,
		);
		console.error("");
		for (const f of findings) console.error(`  ${f}`);
		console.error("");
		console.error(
			"`tofu plan -refresh-only` never plans a create, so a counted resource with no",
		);
		console.error(
			"instance in state is an EMPTY TUPLE and `[0]` aborts the whole plan — drift",
		);
		console.error(
			"detection dies for every environment whose template has advanced past its",
		);
		console.error(
			"last apply (#3351). Write `one(<address>[*].<attr>)`: identical where the",
		);
		console.error(
			"instance exists, null instead of a fatal error where it does not.",
		);
		console.error("");
		console.error(examined);
		process.exit(1);
	}

	console.log(
		`✓ no unprotected index into a counted RESOURCE or DATA SOURCE — ${examined}.`,
	);
	console.log(
		"  NOT COVERED, deliberately — the header records the measurement behind each:",
	);
	console.log(
		`    ${modules.length} module reference(s): one() on a module splat closed a dependency cycle on aws, and try() hides a typo'd module output. Per-site judgement, not a codemod.`,
	);
	console.log(
		`    ${multiCount.length} reference(s) into a resource counted by something other than a 0-or-1 conditional, where [0] is a real index:`,
	);
	for (const m of multiCount) console.log(`      ${m}`);
}
