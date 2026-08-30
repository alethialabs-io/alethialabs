// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A variable's DEFAULT is a decision. This checks that no operator stack has left a dangerous one
// where a fresh checkout will find it.
//
// THE SHAPE (#3108). `infra/.gitignore` carries `**/terraform.tfvars`, so every stack's real inputs
// were gitignored. On any fresh checkout — a new machine, a worktree, CI, a new contributor — a
// bare `tofu apply` runs entirely on variable defaults, and nothing says so. That is not merely
// untidy, because a default is not a neutral value:
//
//   · Where a resource's `count`/`for_each` is gated on a variable defaulting to empty, the
//     default means DESTROY. `infra/aws-oidc/e2e-dns.tf` would have destroyed a Route53 zone whose
//     NS set is delegated at Cloudflare — a replacement resolves for nobody until re-delegated by
//     hand.
//   · Where an empty default STEERS a conditional instead of gating a resource, it silently
//     narrows or widens. `infra/gcp-e2e` has already done this once: `e2e_github_environment`
//     defaulted to `""`, the OIDC trust narrowed to ref-only, scheduled runs survived and every
//     `workflow_dispatch` from `dev` died at federation. And the sharpest one is an INVERSION:
//     `azure-e2e/bootstrap` reads `default_action = length(var.state_network_allowed_cidrs) > 0 ?
//     "Deny" : "Allow"`, so the unset value is the PERMISSIVE one.
//
// Twice is a class, not an accident, which is why this is a check rather than a note.
//
// THE RULE, in one sentence: a variable whose default is empty (`""`, `[]`, `{}`, `false`, `null`),
// which steers whether something exists or which branch is taken, and which no COMMITTED
// `terraform.tfvars` supplies, is a finding.
//
// THE SECOND DIRECTION (#3292). The rule above only looks DOWN — at a default that is absent. A
// default can be dangerous by being *present and open*, and #3292 found three: `ssh_allowed_cidrs`
// in `infra/cp-hetzner`, `infra/status` and `infra/sandbox` all default to `["0.0.0.0/0", "::/0"]`,
// and each is read straight into the `source_ips` of a port-22 firewall rule. Two of those three
// stacks are applied by CI with `tofu apply -auto-approve` on push to `main` and nothing supplies a
// narrower value, so the open default is not a placeholder — it IS the production configuration.
// The empty-default rule could never see them: `["0.0.0.0/0", "::/0"]` is not empty, and it does
// not steer a conditional, it is simply the value that gets applied.
//
// So the second rule, also in one sentence: a variable whose NAME says it carries an access-control
// allowlist, whose default contains a CIDR with a prefix length of `0` (the whole address space),
// and which no COMMITTED `terraform.tfvars` supplies, is a finding.
//
// WHY SCOPE BY NAME AND NOT BY USE. The sound-looking alternative — follow the variable to the
// resource attribute it lands in and decide whether that attribute is a security control — needs
// per-provider knowledge of which attribute names are access control (`source_ips`, `cidr_blocks`,
// `authorized_networks`, `security_rules`, `master_authorized_networks_config`, …) and it needs the
// HCL evaluation this file has already refused. The name is the cheaper question and it is the one
// the maintainer already answers when declaring the variable: a list of CIDRs called
// `*_allowed_cidrs` / `*_authorized_networks` / `*_ip_ranges` is an allowlist, and `0.0.0.0/0` in
// it means "everyone". The shape is deliberately two alternatives (see ACCESS_CONTROL_NAME):
//
//   · a PLURAL address-list suffix — `_cidrs`, `_cidr_blocks`, `_ip_ranges`, `_networks`,
//     `_ranges`, `_source_ips`. Plural on purpose: a LIST of CIDRs is an allowlist, whereas the
//     singular `vpc_cidr` / `pod_cidr` / `service_cidr` names an address space you are ALLOCATING,
//     where a prefix is a sizing decision and not a permission. Matching those would have been
//     noise on a different axis.
//   · an access-control WORD anywhere in the name — `allow`/`allowed`/`allowlist`,
//     `authorized`/`authorised`, `whitelist`, `ingress`, `public_access`, `trusted`. This catches
//     `aks_authorized_ip_ranges` and `cluster_endpoint_public_access_cidrs`, and it over-matches
//     harmlessly onto booleans like `allow_long_names`, whose default can never contain a CIDR.
//
// It over-reports rather than under-reports, exactly like the rule above, and an over-report is
// answered the same three ways: commit the input, declare the variable REQUIRED, or record the
// reason in the baseline.
//
// WHAT THIS DOES NOT COVER, said out loud so the silence is not mistaken for a clean sweep:
//   · A permissive value HARDCODED in a resource rather than defaulted in a variable.
//     `infra/status/main.tf:35,41` opens 80 and 443 to the world that way, which is what a status
//     page is for. Deciding that case needs the per-attribute knowledge rejected above.
//   · Everything under `infra/templates/**`. Those are the runner's PROJECT templates, not operator
//     stacks; they carry no `versions.tf`, so `findStacks` never reaches them, and their defaults
//     (`cluster_endpoint_public_access_cidrs`, `gke_master_authorized_cidr_blocks`) are overridden
//     per project by the runner. A separate question, and not this one.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not evaluate HCL. An expression evaluator would have to
// resolve `merge()`, string interpolation and `for` comprehensions to decide whether a particular
// gate goes empty — and it would then have MISSED the azure case above, where the map is never
// empty and a KEY disappears. So this asks the cheaper, sounder question: does an empty default
// reach a decision point at all? It over-reports rather than under-reports, and an over-report is
// answered by committing the input, by declaring the variable required, or by a baseline entry that
// states the reason. A safety guard that errs the other way is the one that reports green.
//
// It also does not decide whether a committed value is CORRECT. `aws-oidc/terraform.tfvars` fixed
// three wrong defaults only because a maintainer read a plan against the live account line by line.
// Nothing here can do that.
//
// Usage:
//   node scripts/check-tfvars-safety.mjs              # the check (pnpm check:tfvars-safety)
//   node scripts/check-tfvars-safety.mjs --self-test  # fixtures, hermetic

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "infra/tfvars-safety-baseline.json";

/** Values that make a gate false / a conditional take its "unset" branch. */
const EMPTY_DEFAULTS = new Set(['""', "[]", "{}", "false", "null"]);

/** The two finding kinds. A baseline entry without a `kind` means the original one, `empty-default`. */
const EMPTY = "empty-default";
const PERMISSIVE = "permissive-default";
const KINDS = new Set([EMPTY, PERMISSIVE]);

/**
 * A variable NAME that says its value is an access-control allowlist.
 *
 * Two alternatives, and the header says why at length: a PLURAL address-list suffix (a list of
 * CIDRs is an allowlist; the singular `vpc_cidr` is an allocation), or an access-control word
 * anywhere in the name (catches `aks_authorized_ip_ranges`, `cluster_endpoint_public_access_cidrs`).
 * British and American spellings both, because a stack written either way is the same hazard.
 */
const ACCESS_CONTROL_NAME =
	/(_(cidrs|cidr_blocks|ip_ranges|ip_blocks|networks|ranges|source_ips)$)|((^|_)(allow|allowed|allowlist|authorized|authorised|whitelist|ingress|public_access|trusted)(_|$))/;

export const isAccessControlName = (name) => ACCESS_CONTROL_NAME.test(name);

/**
 * CIDR tokens in an expression whose prefix length is `0` — i.e. the ENTIRE address space.
 *
 * Prefix-length-0 rather than a literal match on the two strings #3292 names, because `0.0.0.0/0`
 * and `::/0` are only the canonical spellings: `10.0.0.0/0` and `2001:db8::/0` are the same
 * permission written differently, and a check that recognised only the tidy spelling would report
 * green on the untidy one. Costs nothing — the prefix is already captured.
 */
export function openCidrTokens(expr) {
	const out = [];
	for (const m of expr.matchAll(/([0-9A-Fa-f.:]+)\/(\d{1,3})\b/g)) {
		if (Number(m[2]) === 0) out.push(m[0]);
	}
	return out;
}

/**
 * Strip `#`, `//` and block comments from HCL, preserving every byte position.
 *
 * Position-preserving because findings carry line numbers, and because a comment that merely
 * VANISHED would shift them. Quoted strings and heredocs are skipped, so a `#` inside a string —
 * `"https://host/#frag"`, or a heredoc holding an IAM policy — does not eat the rest of the line.
 * Matching a comment is the substring-versus-shape trap: without this, a commented-out
 * `# count = var.x ? 1 : 0` reads exactly like a live gate.
 */
export function stripComments(src) {
	const out = [...src];
	const blank = (i) => {
		if (out[i] !== "\n") out[i] = " ";
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '"') {
			i += 1;
			while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
			i += 1;
			continue;
		}
		if (c === "<" && src.startsWith("<<", i)) {
			const m = /^<<[-~]?\s*"?([A-Za-z_][A-Za-z0-9_]*)"?/.exec(src.slice(i));
			if (m) {
				// BLANKED, not skipped. A heredoc is a string literal: an IAM policy or a cloud-init
				// script inside one can contain anything, including a line that reads exactly like a
				// live `count = …` gate. Skipping it left that text in the stream and the reader
				// found three gates in a stack that has one.
				// `<<-EOT` indents its terminator, so the closing line is `  EOT`, not `EOT`. Looking
				// for a bare "\nEOT" found nothing and blanked the rest of the FILE — which reported
				// zero gates in a stack that has one. Silence again, from the opposite direction.
				const close = new RegExp(`\\n[ \\t]*${m[1]}[ \\t]*(\\n|$)`).exec(src.slice(i));
				const stop = close ? i + close.index + close[0].length : src.length;
				while (i < stop) blank(i++);
				continue;
			}
		}
		if (c === "#" || (c === "/" && src[i + 1] === "/")) {
			while (i < src.length && src[i] !== "\n") blank(i++);
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			while (i < stop) blank(i++);
			continue;
		}
		i += 1;
	}
	return out.join("");
}

/** Read a bracket-balanced expression starting at `from`, stopping at the first unbalanced newline. */
function readExpression(src, from) {
	let depth = 0;
	let i = from;
	for (; i < src.length; i += 1) {
		const c = src[i];
		if (c === '"') {
			i += 1;
			while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth += 1;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) break;
			depth -= 1;
		} else if (c === "\n" && depth === 0) break;
	}
	return src.slice(from, i);
}

/** Every `variable "x" { … }` in a stack, with its default expression (or `undefined` when required). */
function readVariables(files) {
	const vars = new Map();
	for (const { rel, text } of files) {
		const re = /variable\s+"([^"]+)"\s*\{/g;
		let m;
		while ((m = re.exec(text)) !== null) {
			const name = m[1];
			const body = readBlock(text, m.index + m[0].length - 1);
			const d = /(^|\n)\s*default\s*=\s*/.exec(body);
			const def = d ? readExpression(body, d.index + d[0].length).trim() : undefined;
			vars.set(name, { name, rel, default: def, line: lineOf(text, m.index) });
		}
	}
	return vars;
}

/** Every `locals { … }` assignment, so one level of `local.x` indirection can be followed. */
function readLocals(files) {
	const locals = new Map();
	for (const { text } of files) {
		const re = /(^|\n)locals\s*\{/g;
		let m;
		while ((m = re.exec(text)) !== null) {
			const body = readBlock(text, m.index + m[0].length - 1);
			const assign = /(^|\n)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*/g;
			let a;
			while ((a = assign.exec(body)) !== null) {
				locals.set(a[2], readExpression(body, a.index + a[0].length));
			}
		}
	}
	return locals;
}

/** Read a `{ … }` block whose opening brace is at `open`. */
function readBlock(src, open) {
	let depth = 0;
	for (let i = open; i < src.length; i += 1) {
		const c = src[i];
		if (c === '"') {
			i += 1;
			while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
			continue;
		}
		if (c === "{") depth += 1;
		else if (c === "}") {
			depth -= 1;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	return src.slice(open + 1);
}

function lineOf(text, index) {
	return text.slice(0, index).split("\n").length;
}

const varRefs = (expr) => [...expr.matchAll(/\bvar\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
const localRefs = (expr) => [...expr.matchAll(/\blocal\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

/**
 * The two ways an empty default changes what a stack applies.
 *
 * GATE — the variable reaches a `count`/`for_each`, directly or through one level of `locals`. The
 * default decides whether the resource EXISTS.
 *
 * STEER — the variable is tested by one of four shapes that select a branch: `length(var.x) …`,
 * `var.x == ""` / `!= ""`, `contains(var.x, …)`, or `var.x ?`. The default decides WHICH value is
 * applied — a trust policy without its condition, a firewall defaulting to Allow, a `check` that
 * passes because its input is empty.
 *
 * Both are reported, because both have already shipped.
 */
function findSteeringSites(files, locals) {
	const sites = [];
	const unresolved = [];
	for (const { rel, text } of files) {
		const gate = /(^|\n)[^\S\n]*(count|for_each)\s*=\s*/g;
		let m;
		while ((m = gate.exec(text)) !== null) {
			const expr = readExpression(text, m.index + m[0].length);
			const line = lineOf(text, m.index + m[0].length);
			const names = new Set(varRefs(expr));
			for (const l of localRefs(expr)) {
				const body = locals.get(l);
				if (body === undefined) {
					unresolved.push({ rel, line, what: `local.${l} (no locals assignment found in this stack)` });
					continue;
				}
				for (const n of varRefs(body)) names.add(n);
				// One level only, and deliberately so — but say so rather than resolving in silence.
				for (const l2 of localRefs(body)) unresolved.push({ rel, line, what: `local.${l} → local.${l2} (only ONE level of locals is followed)` });
			}
			for (const name of names) sites.push({ kind: "gate", rel, line, name, expr: expr.trim().replace(/\s+/g, " ").slice(0, 90) });
		}

		const steers = [
			/length\(\s*var\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*[<>=!]/g,
			/var\.([A-Za-z_][A-Za-z0-9_]*)\s*[!=]=\s*""/g,
			/contains\(\s*var\.([A-Za-z_][A-Za-z0-9_]*)\s*,/g,
			/var\.([A-Za-z_][A-Za-z0-9_]*)\s*\?/g,
		];
		for (const re of steers) {
			let s;
			while ((s = re.exec(text)) !== null) {
				sites.push({ kind: "steer", rel, line: lineOf(text, s.index), name: s[1], expr: s[0].replace(/\s+/g, " ") });
			}
		}
	}
	return { sites, unresolved };
}

/** Variables a COMMITTED terraform.tfvars supplies. An untracked file is not on a fresh checkout. */
function suppliedByTrackedTfvars(root, stackDir, trackedFiles) {
	const rel = path.posix.join(stackDir, "terraform.tfvars");
	if (!trackedFiles.has(rel)) return new Set();
	const text = stripComments(readFileSync(path.join(root, rel), "utf8"));
	return new Set([...text.matchAll(/(^|\n)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/g)].map((m) => m[2]));
}

/** Every operator stack: a directory under infra/ carrying a versions.tf. */
function findStacks(root) {
	const found = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (!e.isDirectory() || e.name === ".terraform" || e.name === "node_modules") continue;
			const full = path.join(dir, e.name);
			if (existsSync(path.join(full, "versions.tf"))) found.push(path.relative(root, full).split(path.sep).join("/"));
			walk(full);
		}
	};
	walk(path.join(root, "infra"));
	return found.sort();
}

function readStackFiles(root, stack) {
	const dir = path.join(root, stack);
	return readdirSync(dir)
		.filter((f) => f.endsWith(".tf") && statSync(path.join(dir, f)).isFile())
		.sort()
		.map((f) => ({ rel: `${stack}/${f}`, text: stripComments(readFileSync(path.join(dir, f), "utf8")) }));
}

function loadBaseline(root) {
	const p = path.join(root, BASELINE);
	// A MISSING baseline is not an empty one. Returning [] here would make a deleted or mis-pathed
	// file read as "no exceptions recorded", every known finding would come back as new — and worse,
	// on a tree with nothing to find it would print the clean-sweep line having read no record at
	// all. "I could not look" is not "nothing is wrong", the same rule the run() guards below apply.
	if (!existsSync(p)) {
		console.error(`✗ check-tfvars-safety: ${BASELINE} is missing. It is the entire record of which dangerous defaults have been reviewed; without it this check cannot tell a new finding from a known one. Refusing to run.`);
		process.exit(1);
	}
	const raw = JSON.parse(readFileSync(p, "utf8"));
	const list = raw?.known;
	if (!Array.isArray(list)) throw new Error(`${BASELINE}: no "known" array`);
	for (const e of list) {
		if (!e.stack || !e.variable || !e.reason) throw new Error(`${BASELINE}: every entry needs stack, variable and reason — got ${JSON.stringify(e)}`);
		if (e.kind !== undefined && !KINDS.has(e.kind)) throw new Error(`${BASELINE}: kind must be one of ${[...KINDS].join(", ")} (or absent, meaning ${EMPTY}) — got ${JSON.stringify(e.kind)}`);
	}
	return list;
}

/** The acknowledgement key: (stack, variable, kind). NUL-joined so no name can forge a boundary. */
const ackKey = (stack, name, kind) => `${stack}\u0000${name}\u0000${kind}`;

/** A baseline entry's kind, defaulting to the original one so pre-#3292 entries keep their meaning. */
const kindOf = (entry) => entry.kind ?? EMPTY;

/**
 * Baselined on the exact (stack, variable, kind) triple — never a substring, so `admin` does not
 * cover `admin_extra` and `zon` does not cover `zone`.
 *
 * The pair, not the file:line, because a line number drifts on any edit above it and the DECISION
 * being recorded belongs to the variable. Baselining a variable therefore baselines every site in
 * that stack which reads it, which is what a reason like "the whole email-routing block is
 * deliberately dormant" actually means.
 *
 * KIND is part of the key because the two rules record two different decisions about the same
 * variable. "This list is deliberately empty" and "this list is deliberately open" are opposite
 * statements, and an entry making one must not silently absolve the other — otherwise narrowing a
 * default from `0.0.0.0/0` to `[]` would leave the old entry quietly covering the new finding
 * instead of going stale and failing.
 */
const isKnown = (baseline, stack, name, kind) => baseline.some((e) => e.stack === stack && e.variable === name && kindOf(e) === kind);

export function analyseStack({ stack, files, tracked, baseline = [], root = ROOT }) {
	const vars = readVariables(files);
	const locals = readLocals(files);
	const { sites, unresolved } = findSteeringSites(files, locals);
	const supplied = suppliedByTrackedTfvars(root, stack, tracked);

	const findings = [];
	const acknowledged = new Set();
	const seen = new Map();
	for (const site of sites) {
		const v = vars.get(site.name);
		if (!v) continue; // a var declared in another module; not this stack's decision
		if (v.default === undefined) continue; // REQUIRED — a bare apply fails loudly, which is the fix
		if (!EMPTY_DEFAULTS.has(v.default.replace(/\s+/g, ""))) continue;
		if (supplied.has(site.name)) continue;
		if (isKnown(baseline, stack, site.name, EMPTY)) {
			acknowledged.add(ackKey(stack, site.name, EMPTY));
			continue;
		}
		// One finding per (file, line, variable). `count = var.zone != "" ? 1 : 0` matches BOTH the
		// gate reader and the `var.x == ""` steering shape; it is one decision, reported once, and
		// the gate is the stronger description of it.
		const key = `${site.rel}:${site.line}:${site.name}`;
		const prior = seen.get(key);
		if (prior) {
			if (site.kind === "gate" && prior.kind !== "gate") Object.assign(prior, { kind: "gate", expr: site.expr });
			continue;
		}
		const finding = { stack, ...site, default: v.default, declaredAt: `${v.rel}:${v.line}` };
		seen.set(key, finding);
		findings.push(finding);
	}

	// THE SECOND DIRECTION (#3292). Note what this loop does NOT do: it never asks whether the
	// variable reaches a steering site. An open allowlist is not dangerous because it steers a
	// decision — it IS the decision, sitting in the `source_ips` of a firewall rule, and requiring
	// it to also gate a `count` would have skipped all three real cases.
	const permissive = [];
	let accessControlVars = 0;
	for (const v of vars.values()) {
		if (!isAccessControlName(v.name)) continue;
		accessControlVars += 1;
		if (v.default === undefined) continue; // REQUIRED — a bare apply fails loudly, which is the fix
		const open = openCidrTokens(v.default);
		if (open.length === 0) continue;
		if (supplied.has(v.name)) continue;
		if (isKnown(baseline, stack, v.name, PERMISSIVE)) {
			acknowledged.add(ackKey(stack, v.name, PERMISSIVE));
			continue;
		}
		permissive.push({
			stack,
			kind: PERMISSIVE,
			name: v.name,
			rel: v.rel,
			line: v.line,
			default: v.default.replace(/\s+/g, " ").slice(0, 90),
			open: [...new Set(open)],
		});
	}

	return {
		findings,
		permissive,
		unresolved,
		acknowledged,
		counts: { variables: vars.size, locals: locals.size, sites: sites.length, supplied: supplied.size, accessControlVars },
	};
}

function trackedSet(root) {
	const out = execFileSync("git", ["-C", root, "ls-files", "infra"], { encoding: "utf8" });
	return new Set(out.split("\n").filter(Boolean));
}

function run(root) {
	const stacks = findStacks(root);
	const baseline = loadBaseline(root);
	const tracked = trackedSet(root);
	let variables = 0;
	let sites = 0;
	let accessControlVars = 0;
	const findings = [];
	const permissive = [];
	const unresolved = [];
	const acknowledged = new Set();
	for (const stack of stacks) {
		const r = analyseStack({ stack, files: readStackFiles(root, stack), tracked, baseline });
		findings.push(...r.findings);
		permissive.push(...r.permissive);
		unresolved.push(...r.unresolved.map((u) => ({ stack, ...u })));
		for (const a of r.acknowledged) acknowledged.add(a);
		variables += r.counts.variables;
		sites += r.counts.sites;
		accessControlVars += r.counts.accessControlVars;
	}

	// A baseline that outlives what it describes is how a ratchet goes slack: the entry keeps
	// reading like a reviewed decision long after the decision was made, and the next person adding
	// the same defect finds it pre-forgiven. So a stale entry FAILS, and its removal rides in the
	// same PR as the fix — the same discipline scripts/ts-coverage-sweep.json states for itself.
	const stale = baseline.filter((e) => !acknowledged.has(ackKey(e.stack, e.variable, kindOf(e))));

	// "I examined nothing" must never read like "I found nothing wrong". Every one of these is a way
	// this check could go quietly inert: a moved directory layout, a stack file convention change,
	// an HCL dialect the reader stops recognising, a naming convention the name shape stops matching.
	if (stacks.length === 0) {
		console.error("✗ check-tfvars-safety: found ZERO stacks under infra/ — the layout moved, or versions.tf is no longer the marker. Refusing to report green.");
		process.exit(1);
	}
	if (sites === 0) {
		console.error(`✗ check-tfvars-safety: ${stacks.length} stack(s) but ZERO count/for_each/conditional sites. The HCL reader is broken, not the infrastructure.`);
		process.exit(1);
	}
	// The permissive half is scoped by variable NAME, so it goes inert the moment the repo renames
	// its allowlists — silently, and while still printing a green line about defaults it never
	// looked at. A rename is exactly the change that would do it, so say so instead.
	if (accessControlVars === 0) {
		console.error(
			`✗ check-tfvars-safety: ${stacks.length} stack(s) but ZERO variables matching the access-control NAME shape (${ACCESS_CONTROL_NAME}). Either every allowlist variable was removed, or the repo renamed them and the permissive-default half of this check now examines nothing. Refusing to report green.`,
		);
		process.exit(1);
	}

	if (stale.length > 0) {
		console.error(`✗ check-tfvars-safety: ${stale.length} baseline entr(ies) no longer describe anything real — remove them in the PR that fixed them:`);
		for (const e of stale) console.error(`    ${e.stack}  var.${e.variable}  [${kindOf(e)}]  — recorded reason: ${e.reason}`);
		console.error("");
	}

	if (unresolved.length > 0) {
		console.error(`✗ check-tfvars-safety: ${unresolved.length} expression(s) this check could not resolve. "I could not look" is not "nothing is wrong":`);
		for (const u of unresolved) console.error(`    ${u.rel}:${u.line} — ${u.what}`);
	}

	if (findings.length > 0) {
		console.error(`✗ check-tfvars-safety: ${findings.length} empty default(s) reach a decision no committed input overrides:\n`);
		let last = "";
		for (const f of findings) {
			if (f.stack !== last) {
				console.error(`  ${f.stack}`);
				last = f.stack;
			}
			const what = f.kind === "gate" ? "GATE — decides whether the resource EXISTS" : "STEER — decides which branch is applied";
			console.error(`    ${f.rel}:${f.line}  var.${f.name} = ${f.default}`);
			console.error(`      ${what}:  ${f.expr}`);
			console.error(`      declared ${f.declaredAt}`);
		}
		console.error("\n  Fix by committing the input (see infra/aws-oidc/terraform.tfvars and its .gitignore");
		console.error("  negation), or by declaring the variable REQUIRED with no default so a bare apply fails");
		console.error(`  loudly, or — where the empty default is deliberate or not yet audited — by an entry in`);
		console.error(`  ${BASELINE} that says WHICH, and why.`);
	}

	if (permissive.length > 0) {
		console.error(`✗ check-tfvars-safety: ${permissive.length} access-control variable(s) default to the WHOLE address space, with no committed input narrowing them:\n`);
		let last = "";
		for (const f of permissive) {
			if (f.stack !== last) {
				console.error(`  ${f.stack}`);
				last = f.stack;
			}
			console.error(`    ${f.rel}:${f.line}  var.${f.name} = ${f.default}`);
			console.error(`      OPEN — the default IS the applied allowlist:  ${f.open.join(", ")} (prefix length 0 = every address)`);
		}
		console.error("\n  Fix by narrowing the default, or by committing the real value (see infra/aws-oidc/terraform.tfvars");
		console.error("  and its .gitignore negation), or by declaring the variable REQUIRED so a bare apply fails loudly.");
		console.error(`  Where the open default is deliberate — or is known debt nobody has been able to narrow yet — an`);
		console.error(`  entry in ${BASELINE} with "kind": "${PERMISSIVE}" says WHICH, and why.`);
		console.error("  Do NOT guess a CIDR for a stack CI applies unattended: the wrong guess locks CI out of the box.");
	}

	if (findings.length > 0 || permissive.length > 0 || unresolved.length > 0 || stale.length > 0) process.exit(1);
	console.log(
		`✓ check-tfvars-safety: ${stacks.length} stack(s), ${variables} variable(s), ${sites} steering site(s), ${accessControlVars} access-control variable(s) — every empty default that reaches a decision, and every access-control default that is open to the whole internet, is either supplied by a committed terraform.tfvars, declared REQUIRED, or carried in ${BASELINE} with a reason (${acknowledged.size} baselined).`,
	);
}

// ── --self-test ───────────────────────────────────────────────────────────────────────────────────
//
// Fixture stacks on disk, not hand-built objects: the reader's job is to read HCL, so it is given
// HCL. Each case is a way this check could be wrong in the direction that matters — reporting green.
function selfTest() {
	let pass = 0;
	let fail = 0;
	const ok = (m) => {
		pass += 1;
		console.log(`  ✓ ${m}`);
	};
	const bad = (m) => {
		fail += 1;
		console.log(`  ✗ ${m}`);
	};
	const dir = mkdtempSync(path.join(tmpdir(), "tfvars-safety-"));
	const stack = (name, files) => {
		const d = path.join(dir, "infra", name);
		mkdirSync(d, { recursive: true });
		for (const [f, t] of Object.entries(files)) writeFileSync(path.join(d, f), t);
		return `infra/${name}`;
	};
	const analyse = (s, { tracked = [], baseline = [] } = {}) =>
		analyseStack({ stack: s, files: readStackFiles(dir, s), tracked: new Set(tracked), baseline, root: dir });
	const names = (r) => r.findings.map((f) => f.name).sort().join(",");

	console.log("check-tfvars-safety --self-test\n");
	console.log(" the reader");

	const direct = stack("direct", {
		"versions.tf": "terraform { required_version = \">= 1.10\" }\n",
		"variables.tf": 'variable "zone" {\n  type    = string\n  default = ""\n}\n',
		"main.tf": 'resource "aws_route53_zone" "z" {\n  count = var.zone != "" ? 1 : 0\n}\n',
	});
	let r = analyse(direct);
	if (names(r) === "zone") ok("a count gated on an empty-defaulted variable is found");
	else bad(`a direct gate should be found, got [${names(r)}]`);

	const viaLocal = stack("via-local", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "env" {\n  type    = string\n  default = ""\n}\n',
		"main.tf":
			'locals {\n  subjects = merge(\n    { ref = "a" },\n    var.env != "" ? { env = "b" } : {},\n  )\n}\n\nresource "x" "y" {\n  for_each = local.subjects\n}\n',
	});
	r = analyse(viaLocal);
	if (r.findings.some((f) => f.name === "env" && f.kind === "gate")) ok("a gate reached through ONE level of locals is found — the map is never empty and a KEY disappears");
	else bad(`the local-indirect gate should be found, got [${names(r)}]`);

	const steer = stack("steer", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "cidrs" {\n  type    = list(string)\n  default = []\n}\n',
		"main.tf": 'resource "s" "a" {\n  default_action = length(var.cidrs) > 0 ? "Deny" : "Allow"\n}\n',
	});
	r = analyse(steer);
	if (names(r) === "cidrs") ok("an empty default that STEERS a branch is found, even though it gates nothing");
	else bad(`the steering case should be found, got [${names(r)}]`);

	const commented = stack("commented", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "zone" {\n  default = ""\n}\n',
		"main.tf": 'resource "r" "a" {\n  # count = var.zone != "" ? 1 : 0\n  // for_each = toset(var.zone)\n}\n',
	});
	r = analyse(commented);
	if (r.findings.length === 0) ok("a COMMENTED-OUT gate is not a gate");
	else bad(`a commented gate should not be found, got [${names(r)}]`);

	const heredoc = stack("heredoc", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "zone" {\n  default = ""\n}\n',
		"main.tf": 'resource "r" "a" {\n  policy = <<-EOT\n    # count = var.zone != "" ? 1 : 0\n  EOT\n  count = var.zone != "" ? 1 : 0\n}\n',
	});
	r = analyse(heredoc);
	if (r.findings.length === 1) ok("a `#` inside a heredoc does not blank the real gate below it");
	else bad(`heredoc case: expected exactly 1 finding, got ${r.findings.length}`);

	console.log("\n the verdicts");

	const required = stack("required", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "emails" {\n  type = list(string)\n}\n',
		"main.tf": 'resource "r" "a" {\n  for_each = toset(var.emails)\n}\n',
	});
	if (analyse(required).findings.length === 0) ok("a REQUIRED variable (no default) is the fix, not a finding");
	else bad("a required variable should not be a finding");

	const nonEmpty = stack("non-empty", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "cap" {\n  default = 2\n}\nvariable "on" {\n  default = true\n}\nvariable "streams" {\n  default = { a = 1 }\n}\n',
		"main.tf": 'resource "r" "a" {\n  count = var.cap\n}\nresource "r" "b" {\n  count = var.on ? 1 : 0\n}\nresource "r" "c" {\n  for_each = var.streams\n}\n',
	});
	if (analyse(nonEmpty).findings.length === 0) ok("a non-empty default (2, true, a populated map) is not a finding");
	else bad(`non-empty defaults should not be findings, got [${names(analyse(nonEmpty))}]`);

	// Both directions on the supply half, and vary the RIGHT axis: same variable under a different
	// stack, a different variable under the same stack, and the name with material appended.
	const supplied = stack("supplied", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "zone" {\n  default = ""\n}\nvariable "zone_extra" {\n  default = ""\n}\n',
		"main.tf": 'resource "r" "a" {\n  count = var.zone != "" ? 1 : 0\n}\nresource "r" "b" {\n  count = var.zone_extra != "" ? 1 : 0\n}\n',
		"terraform.tfvars": 'zone = "live.example.com"\n',
	});
	r = analyse(supplied, { tracked: ["infra/supplied/terraform.tfvars"] });
	if (names(r) === "zone_extra") ok("a COMMITTED tfvars resolves the variable it sets, and only that one");
	else bad(`supplied case: expected only zone_extra, got [${names(r)}]`);
	r = analyse(supplied, { tracked: [] });
	if (names(r) === "zone,zone_extra") ok("an UNTRACKED tfvars resolves nothing — it is not there on a fresh checkout");
	else bad(`untracked tfvars should resolve nothing, got [${names(r)}]`);

	console.log("\n the baseline");
	r = analyse(direct, { baseline: [{ stack: direct, variable: "zone", reason: "deliberate" }] });
	if (r.findings.length === 0) ok("a baseline entry on the exact (stack, variable) pair acknowledges it");
	else bad("the exact baseline entry should acknowledge the finding");
	r = analyse(direct, { baseline: [{ stack: "infra/other", variable: "zone", reason: "wrong stack" }] });
	if (names(r) === "zone") ok("the same variable baselined in a DIFFERENT stack does not acknowledge it");
	else bad("a wrong-stack baseline entry must not apply");
	r = analyse(direct, { baseline: [{ stack: direct, variable: "zone_longer", reason: "wrong variable" }] });
	if (names(r) === "zone") ok("a LONGER variable name sharing the prefix does not acknowledge it");
	else bad("a prefix baseline entry must not apply");
	r = analyse(direct, { baseline: [{ stack: direct, variable: "zon", reason: "prefix" }] });
	if (names(r) === "zone") ok("a SHORTER variable name that is a prefix does not acknowledge it");
	else bad("a shorter-prefix baseline entry must not apply");

	// The stale half of the ratchet. `run()` fails when a baseline entry acknowledges nothing, and
	// `acknowledged` is the signal it uses — so a fixed stack must stop reporting its variable.
	r = analyse(direct, { baseline: [{ stack: direct, variable: "zone", reason: "deliberate" }] });
	if (r.acknowledged.has(ackKey(direct, "zone", EMPTY))) ok("a baseline entry that DOES describe a real finding is recorded as acknowledged");
	else bad("an active baseline entry should be acknowledged");
	r = analyse(required, { baseline: [{ stack: required, variable: "emails", reason: "already fixed" }] });
	if (r.acknowledged.size === 0) ok("a baseline entry for an already-fixed variable acknowledges NOTHING — run() reports it stale");
	else bad("a stale baseline entry must not read as acknowledged");

	console.log("\n unresolvable is not clean");
	const twoLevels = stack("two-levels", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "env" {\n  default = ""\n}\n',
		"main.tf": 'locals {\n  a = local.b\n  b = var.env\n}\n\nresource "r" "x" {\n  for_each = local.a\n}\n',
	});
	if (analyse(twoLevels).unresolved.length > 0) ok("a two-level locals chain is reported UNRESOLVED rather than passed over");
	else bad("two-level locals should be reported unresolved");

	const missingLocal = stack("missing-local", {
		"versions.tf": "terraform {}\n",
		"main.tf": 'resource "r" "x" {\n  for_each = local.nowhere\n}\n',
	});
	if (analyse(missingLocal).unresolved.length > 0) ok("a local with no assignment in the stack is reported UNRESOLVED");
	else bad("a missing local should be reported unresolved");

	// ── the second direction (#3292): a default that is PRESENT and OPEN ──────────────────────────
	//
	// The axis to vary here is the DEFAULT's permissiveness and the NAME's shape, independently —
	// getting one right while the other silently matches everything (or nothing) is how this half
	// would report green over an open box.
	console.log("\n permissive defaults (#3292)");
	const opens = (r) => r.permissive.map((f) => f.name).sort().join(",");

	const openSsh = stack("open-ssh", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "ssh_allowed_cidrs" {\n  type    = list(string)\n  default = ["0.0.0.0/0", "::/0"]\n}\n',
		"main.tf": 'resource "hcloud_firewall" "f" {\n  rule {\n    port       = "22"\n    source_ips = var.ssh_allowed_cidrs\n  }\n}\n',
	});
	let p = analyse(openSsh);
	if (opens(p) === "ssh_allowed_cidrs") ok("an access-control default of 0.0.0.0/0 is found — with no gate, no conditional, nothing to steer");
	else bad(`the real #3292 shape should be found, got [${opens(p)}]`);
	if (p.findings.length === 0) ok("...and it is NOT also reported as an empty default — the two rules do not double-count");
	else bad("an open default must not report as an empty-default finding");

	const v6Only = stack("v6-only", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "api_allowed_cidrs" {\n  default = ["::/0"]\n}\n',
	});
	if (opens(analyse(v6Only)) === "api_allowed_cidrs") ok("::/0 alone is open — the IPv6 half is not a rounding error");
	else bad("::/0 should be found on its own");

	// Prefix length 0, not a literal string match: `10.0.0.0/0` is the same permission spelled
	// untidily, and a check that only knew the tidy spelling would report green on it.
	const untidy = stack("untidy", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "db_allowed_cidrs" {\n  default = ["10.0.0.0/0"]\n}\n',
	});
	if (opens(analyse(untidy)) === "db_allowed_cidrs") ok("a NON-canonical whole-space CIDR (10.0.0.0/0) is open too — the check reads the prefix, not the spelling");
	else bad("10.0.0.0/0 should be found");

	const narrowed = stack("narrowed", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "ssh_allowed_cidrs" {\n  default = ["203.0.113.4/32", "2001:db8::/32"]\n}\nvariable "vpc_allowed_cidr_blocks" {\n  default = ["10.0.0.0/8"]\n}\n',
	});
	if (analyse(narrowed).permissive.length === 0) ok("a NARROWED default (/32, /8) is not a finding — otherwise the fix could never be recognised");
	else bad(`narrowed defaults should not be findings, got [${opens(analyse(narrowed))}]`);

	// The name half, both directions. `vpc_cidr` is an ALLOCATION, not an allowlist; a `/0` there is
	// nonsense rather than a permission, and matching it would be noise on a different axis.
	const notAccessControl = stack("not-access-control", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "vpc_cidr" {\n  default = "0.0.0.0/0"\n}\nvariable "pod_cidr" {\n  default = "0.0.0.0/0"\n}\nvariable "example_doc" {\n  default = "e.g. 0.0.0.0/0"\n}\n',
	});
	if (analyse(notAccessControl).permissive.length === 0) ok("a SINGULAR allocation variable (vpc_cidr, pod_cidr) is not an allowlist, even holding 0.0.0.0/0");
	else bad(`allocation variables should not be findings, got [${opens(analyse(notAccessControl))}]`);
	if (analyse(notAccessControl).counts.accessControlVars === 0) ok("...and none of them counts toward the access-control name shape");
	else bad("allocation variables must not count as access-control variables");

	const nameShapes = stack("name-shapes", {
		"versions.tf": "terraform {}\n",
		"variables.tf":
			'variable "aks_authorized_ip_ranges" {\n  default = ["0.0.0.0/0"]\n}\nvariable "cloud_sql_authorized_networks" {\n  default = ["0.0.0.0/0"]\n}\nvariable "cluster_endpoint_public_access_cidrs" {\n  default = ["0.0.0.0/0"]\n}\nvariable "master_authorised_cidr_blocks" {\n  default = ["0.0.0.0/0"]\n}\n',
	});
	if (analyse(nameShapes).permissive.length === 4) ok("every real allowlist naming convention in this repo matches — _ip_ranges, _networks, public_access, and the British spelling");
	else bad(`expected all 4 naming conventions to match, got [${opens(analyse(nameShapes))}]`);

	const requiredOpen = stack("required-open", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "ssh_allowed_cidrs" {\n  type = list(string)\n}\n',
	});
	p = analyse(requiredOpen);
	if (p.permissive.length === 0) ok("a REQUIRED allowlist (no default) is the fix, not a finding");
	else bad("a required allowlist should not be a finding");
	if (p.counts.accessControlVars === 1) ok("...but it still COUNTS, so fixing the last one does not make this half read as inert");
	else bad(`a required allowlist should still count as an access-control variable, got ${p.counts.accessControlVars}`);

	const suppliedOpen = stack("supplied-open", {
		"versions.tf": "terraform {}\n",
		"variables.tf": 'variable "ssh_allowed_cidrs" {\n  default = ["0.0.0.0/0"]\n}\nvariable "web_allowed_cidrs" {\n  default = ["0.0.0.0/0"]\n}\n',
		"terraform.tfvars": 'ssh_allowed_cidrs = ["203.0.113.4/32"]\n',
	});
	if (opens(analyse(suppliedOpen, { tracked: ["infra/supplied-open/terraform.tfvars"] })) === "web_allowed_cidrs")
		ok("a COMMITTED tfvars narrows the variable it sets, and only that one");
	else bad(`supplied-open: expected only web_allowed_cidrs, got [${opens(analyse(suppliedOpen, { tracked: ["infra/supplied-open/terraform.tfvars"] }))}]`);
	if (opens(analyse(suppliedOpen)) === "ssh_allowed_cidrs,web_allowed_cidrs") ok("an UNTRACKED tfvars narrows nothing — infra/sandbox's real one is invisible on a fresh checkout");
	else bad(`untracked tfvars should narrow nothing, got [${opens(analyse(suppliedOpen))}]`);

	console.log("\n the baseline knows the two kinds apart");
	const permBase = [{ stack: openSsh, variable: "ssh_allowed_cidrs", kind: PERMISSIVE, reason: "recorded" }];
	p = analyse(openSsh, { baseline: permBase });
	if (p.permissive.length === 0 && p.acknowledged.has(ackKey(openSsh, "ssh_allowed_cidrs", PERMISSIVE)))
		ok("a permissive-default baseline entry acknowledges it, and is recorded as active");
	else bad("a permissive baseline entry should acknowledge the finding");
	p = analyse(openSsh, { baseline: [{ stack: openSsh, variable: "ssh_allowed_cidrs", reason: "wrong kind" }] });
	if (opens(p) === "ssh_allowed_cidrs") ok("an entry with NO kind means empty-default and does NOT absolve an open one — the two claims are opposites");
	else bad("a kindless baseline entry must not acknowledge a permissive finding");
	p = analyse(narrowed, { baseline: [{ stack: narrowed, variable: "ssh_allowed_cidrs", kind: PERMISSIVE, reason: "already narrowed" }] });
	if (p.acknowledged.size === 0) ok("a permissive entry for an already-narrowed default acknowledges NOTHING — run() reports it stale, so the list only shrinks");
	else bad("a stale permissive entry must not read as acknowledged");

	console.log("\n the layout markers");
	if (findStacks(dir).length === 18) ok("every fixture stack is discovered by its versions.tf");
	else bad(`expected 18 fixture stacks, found ${findStacks(dir).length}`);
	const noMarker = path.join(dir, "infra", "not-a-stack");
	mkdirSync(noMarker, { recursive: true });
	writeFileSync(path.join(noMarker, "main.tf"), 'resource "r" "a" {\n  count = 1\n}\n');
	if (!findStacks(dir).includes("infra/not-a-stack")) ok("a module directory with no versions.tf is not an operator stack");
	else bad("a directory without versions.tf should not be treated as a stack");

	rmSync(dir, { recursive: true, force: true });
	console.log("");
	if (fail === 0) {
		console.log(`check-tfvars-safety self-test: all ${pass} passed`);
		return 0;
	}
	console.log(`check-tfvars-safety self-test: ${fail} of ${pass + fail} FAILED`);
	return 1;
}

if (process.argv.includes("--self-test")) process.exit(selfTest());
else run(ROOT);
