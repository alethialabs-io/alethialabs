#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// check-hetzner-lb-location — the hcloud cloud-controller-manager must be given somewhere to put a
// Load Balancer.
//
// WHY THIS IS A GATE AND NOT A COMMENT. hcloud-cloud-controller-manager refuses to create a Load
// Balancer unless it can decide WHERE: `HCLOUD_LOAD_BALANCERS_LOCATION`,
// `HCLOUD_LOAD_BALANCERS_NETWORK_ZONE`, or a per-Service `load-balancer.hetzner.cloud/location`
// annotation. The hetzner template set none of the three, so every `type: LoadBalancer` Service sat
// Pending forever — and NOTHING SAID SO. The Service is simply pending; no controller logs an error
// a deploy would surface.
//
// That silence is why it went unnoticed long enough to become #2490: no Load Balancer → the
// ingress-nginx controller Service never goes healthy → its ArgoCD Application sits Progressing →
// ArgoCD never runs PostSync → the chart's `admission-patch` Job never injects the admission
// webhook's caBundle → every later Ingress is rejected `x509: certificate signed by unknown
// authority`. The symptom names none of its cause, and the whole chain re-arms the moment the
// location is dropped.
//
// ── WHY IT MATCHES A SHAPE AND NOT A SUBSTRING (#2549) ────────────────────────────────────────
//
// The first version of this file asked `block.includes(KEY)`. The PR that introduced it also added a
// comment INSIDE the CCM block naming both keys — so deleting the `set` blocks and keeping the
// comment left the guard finding both keys and exiting 0. The entire chain above could re-arm with
// CI green, which is the exact failure this guard exists to prevent, committed by the guard itself.
//
// It also printed a false success line: "the hcloud CCM sets LOCATION + NETWORK_ZONE", when
// NETWORK_ZONE appeared only in that prose.
//
// So: comments are stripped first, and what is matched is the rendered SHAPE of an actual setting —
// `name = "env.<KEY>.value"` — not the key's name appearing somewhere. Both halves are load-bearing
// and the self-test pins each.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CCM_FILE = "infra/templates/project/hetzner/cilium.tf";

/** The env keys the CCM will accept as "where do Load Balancers go". Either satisfies it. */
const LOCATION_KEYS = ["HCLOUD_LOAD_BALANCERS_LOCATION", "HCLOUD_LOAD_BALANCERS_NETWORK_ZONE"];

/**
 * Strip `#` and `//` line comments from HCL, IGNORING both inside quoted strings.
 *
 * The string-awareness is not decoration, and the note that used to sit here — "over-stripping can
 * only make this guard STRICTER, and strictness is the safe direction" — was wrong (#2549). It does
 * not merely make the guard stricter; it changes WHICH failure is reported. This function feeds
 * `extractCcmBlock`, which tracks quotes: stripping a `#` out of a value leaves the quote
 * unterminated, `inString` never closes, the block is never balanced, and `analyse` returns
 * `block: null` — the caller's HARD failure, reported as "a missing block means this check has
 * stopped looking at anything". So a CCM block that correctly sets the location reds CI with a
 * message telling the reader to restore a block that is right there. Measured on a value as
 * ordinary as `value = "--label=team #1"`.
 *
 * Under-stripping is still the failure that let prose satisfy the check, and it stays closed: a
 * comment outside a string is removed exactly as before.
 */
export function stripComments(hcl) {
	let out = "";
	let inString = false;
	for (let i = 0; i < hcl.length; i++) {
		const ch = hcl[i];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				// Copy the escaped character verbatim so an escaped quote cannot end the string.
				if (i + 1 < hcl.length) out += hcl[++i];
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		const isComment = ch === "#" || (ch === "/" && hcl[i + 1] === "/");
		if (isComment) {
			// Drop to the end of the line; the newline itself is kept so line numbers do not move.
			while (i < hcl.length && hcl[i] !== "\n") i++;
			if (i < hcl.length) out += "\n";
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * Extract the `data "helm_template" "hcloud_ccm" { … }` block by brace balance, ignoring braces
 * inside quoted strings.
 *
 * The string-awareness is not hypothetical: this template carries values like
 * `"{CHOWN,KILL,...}"`. Such a value outside the CCM block is harmless, but one INSIDE it would
 * truncate the block early — reporting either a false FAIL or, worse, a `null` block that reads as
 * "the CCM was removed", which is a misleading hard failure rather than an honest one.
 *
 * Returns null when the block is absent, which the caller treats as a HARD failure rather than a
 * pass — a missing block means this check has stopped looking at anything.
 */
export function extractCcmBlock(tf) {
	const start = tf.search(/data\s+"helm_template"\s+"hcloud_ccm"\s*\{/);
	if (start === -1) return null;
	const open = tf.indexOf("{", start);
	let depth = 0;
	let inString = false;
	for (let i = open; i < tf.length; i++) {
		const ch = tf[i];
		if (inString) {
			if (ch === "\\") i++; // skip the escaped character
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return tf.slice(open, i + 1);
		}
	}
	return null;
}

/**
 * Report which of the accepted location keys the CCM block actually SETS.
 * @returns {{found: string[], block: string|null}}
 */
/** Escape a literal for safe interpolation into a RegExp. */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every `set` block in the CCM whose name targets a container env var's `.value`, with the env key
 * and whether that block declares `type = "string"`.
 *
 * WHY THIS IS PART OF THE SAME GUARD. A Kubernetes container env `value` is a STRING, and helm's
 * `--set` TYPE-INFERS: `--set env.X.value=true` stores a boolean, the chart renders `value: true`,
 * and server-side apply refuses the whole object —
 *
 *   .spec…env[name="HCLOUD_LOAD_BALANCERS_USE_PRIVATE_IP"].value: expected string, got true
 *
 * The bootstrap manifest is ONE apply, so the CCM taking that object down takes Cilium with it: no
 * CNI, nodes NotReady forever, every Hetzner deploy dead. Measured on run 32873754809, four minutes
 * after a full cluster had been paid for.
 *
 * It belongs here because it is the same block and the same silence: HCL's `value = "true"` LOOKS
 * like a string, `tofu fmt` is happy, `tofu validate` is happy, and nothing says otherwise until an
 * apiserver rejects the object on a real cluster.
 *
 * Matched on the SHAPE of a setting, like the location rule above, and over COMMENT-STRIPPED text —
 * so the `type = "string"` that satisfies it cannot be one written in prose.
 * @returns {{key: string, typed: boolean}[]}
 */
export function envValueSettings(block) {
	const out = [];
	// STRING-AWARE, walking braces rather than `/set\s*\{([^{}]*)\}/g`.
	//
	// That character class excludes braces OUTRIGHT, so a `set { … }` whose VALUE contains one does
	// not match at all — it never enters `out`, and a skipped setting is indistinguishable from a
	// typed one. The failure direction is the bad one: an untyped `env.*.value` inside a
	// brace-bearing block passes the guard silently, which is the exact class this guard exists to
	// end.
	//
	// This file already demonstrates the shape that breaks it:
	//
	//	set {
	//	  name  = "securityContext.capabilities.ciliumAgent"
	//	  value = "{CHOWN,KILL,NET_ADMIN,…}"
	//	}
	//
	// Harmless today — those are `securityContext.*` and live in the cilium block rather than the
	// CCM block this runs against — but it is the same brace problem `extractCcmBlock` already
	// solves one level up, and solving it the same way keeps ONE answer to "where does this block
	// end" instead of two that can disagree.
	for (let i = 0; i < block.length; i++) {
		const at = block.indexOf("set", i);
		if (at === -1) break;
		// `set` must be a WORD, not the tail of an identifier like `offset` or `ruleset`.
		if (at > 0 && /[A-Za-z0-9_]/.test(block[at - 1])) {
			i = at + 2;
			continue;
		}
		const open = block.indexOf("{", at);
		if (open === -1) break;
		// Only a `set` immediately followed by its brace; anything else is a different construct.
		if (block.slice(at + 3, open).trim() !== "") {
			i = at + 2;
			continue;
		}
		let depth = 0;
		let inString = false;
		let end = -1;
		for (let j = open; j < block.length; j++) {
			const ch = block[j];
			if (inString) {
				if (ch === "\\") j++;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					end = j;
					break;
				}
			}
		}
		if (end === -1) break; // unbalanced: the caller's block extraction already reports that
		const body = block.slice(open + 1, end);
		const name = /name\s*=\s*"env\.([A-Za-z0-9_.-]+)\.value"/.exec(body);
		if (name) out.push({ key: name[1], typed: /type\s*=\s*"string"/.test(body) });
		i = end;
	}
	return out;
}

export function analyse(tf) {
	const block = extractCcmBlock(stripComments(tf));
	if (block === null) return { found: [], block: null, untyped: [] };
	const found = LOCATION_KEYS.filter((k) =>
		// The rendered shape of a real setting, not the key appearing somewhere. The key is ESCAPED
		// before interpolation: today's two are letters and underscores, but a future key carrying a
		// `.`, `-` or `+` would silently widen the match or throw, and a guard that matches more than
		// it means is the same defect as one that matches a comment.
		new RegExp(`name\\s*=\\s*"env\\.${escapeRe(k)}\\.value"`).test(block),
	);
	const untyped = envValueSettings(block)
		.filter((e) => !e.typed)
		.map((e) => e.key);
	return { found, block, untyped };
}

function main() {
	const abs = path.join(ROOT, CCM_FILE);
	let tf;
	try {
		tf = readFileSync(abs, "utf8");
	} catch (e) {
		// A missing file is a failure, never a skip. A guard that passes because it could not read
		// its own subject is the failure mode this repo has paid for more than once.
		console.error(`::error::check-hetzner-lb-location: cannot read ${CCM_FILE}: ${e.message}`);
		process.exit(1);
	}

	const { found, block, untyped } = analyse(tf);

	if (block === null) {
		console.error(
			`::error::check-hetzner-lb-location: no \`data "helm_template" "hcloud_ccm"\` block in ${CCM_FILE}. ` +
				`Either the CCM was removed (then delete this check and say why in the commit) or it was renamed ` +
				`(then update this check) — but it must never simply stop being looked at.`,
		);
		process.exit(1);
	}

	if (found.length === 0) {
		console.error(
			`::error::check-hetzner-lb-location: the hcloud CCM SETS neither ${LOCATION_KEYS.join(" nor ")}. ` +
				`Without one, hcloud-cloud-controller-manager REFUSES to create a Load Balancer, so every ` +
				`\`type: LoadBalancer\` Service on a Hetzner cluster sits Pending forever — silently. That is what ` +
				`caused #2490: no LB → ingress-nginx Service never healthy → ArgoCD never reaches PostSync → the ` +
				`admission webhook's caBundle is never patched → every Ingress fails x509. Naming a key in a ` +
				`COMMENT does not count; the check matches \`name = "env.<KEY>.value"\`. See ${CCM_FILE}.`,
		);
		process.exit(1);
	}

	if (untyped.length > 0) {
		console.error(
			`::error::check-hetzner-lb-location: the hcloud CCM sets ${untyped.join(", ")} without \`type = "string"\`. ` +
				`A Kubernetes container env \`value\` must be a STRING, and helm's \`--set\` TYPE-INFERS — ` +
				`\`value = "true"\` in HCL becomes a BOOLEAN in the rendered chart, and server-side apply refuses the ` +
				`whole Deployment: "expected string, got true". The bootstrap manifest is one apply, so the CCM taking ` +
				`that object down takes Cilium with it: no CNI, nodes NotReady, every Hetzner deploy dead about four ` +
				`minutes after paying for a cluster (run 32873754809). Add \`type = "string"\` — it is \`--set-string\`. ` +
				`See ${CCM_FILE}.`,
		);
		process.exit(1);
	}

	const typedCount = envValueSettings(block).length;
	console.log(
		`✓ check-hetzner-lb-location: the hcloud CCM sets ${found.join(" + ")} — Load Balancers have a home; ` +
			`all ${typedCount} env-var setting(s) are string-typed.`,
	);
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
// Asserts BOTH directions. A guard whose failing branch is never exercised is a guard that will
// report green through the very regression it exists to catch — which is what happened here: the
// first version's fixtures were all comment-free, so the one shape that could defeat it was the one
// shape never tried.
function selfTest() {
	let fails = 0;
	const ok = (name, cond) => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name}`);
			fails++;
		}
	};

	const withLocation = `
data "helm_template" "hcloud_ccm" {
  set { name = "networking.enabled" value = "true" }
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = data.hcloud_location.selected.name }
}`;
	const withZone = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_NETWORK_ZONE.value" value = "eu-central" }
}`;
	// The EXACT pre-fix shape that shipped the bug.
	// #2549: a value carrying a `#` or `//`. Both are ordinary in helm extraArgs and annotations.
	// #2625's guard was blind to its own file's shape: `/set\s*\{([^{}]*)\}/g` excludes braces
	// OUTRIGHT, so a `set` whose VALUE carries one never matched and was never checked for
	// `type = "string"`. A skipped setting and a typed setting looked identical in the result.
	const braceInAnEnvValue = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" type = "string" }
  set { name = "env.HCLOUD_CAPS.value" value = "{CHOWN,KILL,NET_ADMIN}" }
}`;
	const hashInAString = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" }
  set { name = "extraArgs" value = "--label=team #1" }
}`;
	const slashesInAString = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" }
  set { name = "endpoint" value = "https://api.hetzner.cloud/v1" }
}`;
	const theBug = `
data "helm_template" "hcloud_ccm" {
  set { name = "networking.enabled" value = "true" }
  set { name = "networking.clusterCIDR" value = local.pod_cidr }
}`;
	// #2549's finding 1, verbatim in spirit: the KEYS named in a comment INSIDE the block, with the
	// settings deleted. The first version of this guard passed here. If it ever passes again, the
	// whole #2490 chain can re-arm with CI green.
	const keysOnlyInAComment = `
data "helm_template" "hcloud_ccm" {
  # Without a default location the CCM refuses to create one at all — set
  # HCLOUD_LOAD_BALANCERS_LOCATION or HCLOUD_LOAD_BALANCERS_NETWORK_ZONE.
  set { name = "networking.enabled" value = "true" }
}`;
	const locationElsewhere = `
resource "hcloud_load_balancer" "unrelated" { location = "nbg1" }
data "helm_template" "hcloud_ccm" {
  set { name = "networking.enabled" value = "true" }
}`;
	// #2549's finding 4: a brace inside a quoted VALUE must not truncate the block.
	const braceInAString = `
data "helm_template" "hcloud_ccm" {
  set { name = "securityContext.capabilities.drop" value = "{CHOWN,KILL,NET_RAW}" }
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" }
}`;

	// ── The env-var STRING-TYPING rule. Both directions, and the axis that matters is the TYPE
	//    declaration — not the key, not the value. `value = "true"` is a string in HCL and a boolean
	//    by the time helm renders it, which is the whole trap.
	const typedEnv = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" type = "string" }
  set { name = "env.HCLOUD_LOAD_BALANCERS_USE_PRIVATE_IP.value" value = "true" type = "string" }
}`;
	// THE REGRESSION, exactly as it shipped in #2536: an env value with no type declaration.
	const untypedEnv = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" type = "string" }
  set { name = "env.HCLOUD_LOAD_BALANCERS_USE_PRIVATE_IP.value" value = "true" }
}`;
	// `type = "auto"` is helm's DEFAULT — the inference itself. It must not satisfy the rule.
	const autoTypedEnv = `
data "helm_template" "hcloud_ccm" {
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" type = "auto" }
}`;
	// A type written in PROSE must not satisfy it — the #2549 lesson, applied to the new rule.
	const typeOnlyInAComment = `
data "helm_template" "hcloud_ccm" {
  # these are all type = "string" settings
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" }
}`;
	// A NON-env setting is not subject to the rule: `networking.enabled` is a chart conditional and
	// a real boolean is what it wants. A guard that demanded strings everywhere would break the chart.
	const nonEnvBoolean = `
data "helm_template" "hcloud_ccm" {
  set { name = "networking.enabled" value = "true" }
  set { name = "env.HCLOUD_LOAD_BALANCERS_LOCATION.value" value = "nbg1" type = "string" }
}`;

	ok("string-typed env settings pass", analyse(typedEnv).untyped.length === 0);
	ok("...and both of them were actually examined", envValueSettings(analyse(typedEnv).block).length === 2);
	ok("THE REGRESSION: an untyped env value FAILS", analyse(untypedEnv).untyped.length === 1);
	ok(
		"...and it names the key that is wrong, not the one that is right",
		analyse(untypedEnv).untyped[0] === "HCLOUD_LOAD_BALANCERS_USE_PRIVATE_IP",
	);
	ok('type = "auto" does NOT satisfy the rule — it IS the inference', analyse(autoTypedEnv).untyped.length === 1);
	ok("a type named only in a COMMENT does not satisfy it", analyse(typeOnlyInAComment).untyped.length === 1);
	ok("a non-env setting is not required to be string-typed", analyse(nonEnvBoolean).untyped.length === 0);
	ok("...and the non-env setting was not silently counted as an env one", envValueSettings(analyse(nonEnvBoolean).block).length === 1);
	ok("a block with no env settings at all reports none untyped", analyse(theBug).untyped.length === 0);

	ok("a configured LOCATION passes", analyse(withLocation).found.length === 1);
	ok("a configured NETWORK_ZONE passes", analyse(withZone).found.length === 1);
	ok("the pre-fix shape FAILS", analyse(theBug).found.length === 0);
	ok("...and its block was still found (so it failed for the right reason)", analyse(theBug).block !== null);
	ok("KEYS NAMED ONLY IN A COMMENT do not satisfy the check (#2549)", analyse(keysOnlyInAComment).found.length === 0);
	ok("...and that block was found, so it is a real refusal", analyse(keysOnlyInAComment).block !== null);
	ok("a location outside the CCM block does NOT satisfy it", analyse(locationElsewhere).found.length === 0);
	ok("a missing CCM block is reported as absent, not as a pass", analyse("locals {}").block === null);
	ok("a brace inside a quoted value does not truncate the block (#2549)", analyse(braceInAString).found.length === 1);
	// A `#` inside a VALUE is not a comment. Stripping it left the quote unterminated, so the
	// brace-balancer ran to EOF and a CORRECTLY configured block reported `block: null` — the hard
	// failure that says "the CCM was removed", on a template where it is right there.
	ok("a '#' inside a quoted value does not blank the block (#2549)", analyse(hashInAString).block !== null);
	ok(
		"an UNTYPED env value containing a brace is CAUGHT, not skipped (#2625)",
		analyse(braceInAnEnvValue).untyped.includes("HCLOUD_CAPS"),
	);
	ok(
		"...and the typed sibling in the same block is still seen as typed",
		!analyse(braceInAnEnvValue).untyped.includes("HCLOUD_LOAD_BALANCERS_LOCATION"),
	);
	ok("...and the location it configures is still found", analyse(hashInAString).found.length === 1);
	ok("a '//' inside a quoted value is likewise not a comment", analyse(slashesInAString).found.length === 1);
	// The under-stripping half must stay closed: a comment OUTSIDE a string is still removed.
	ok("a real trailing comment is still stripped", analyse(keysOnlyInAComment).found.length === 0);
	ok(
		"nested braces do not truncate the block",
		analyse(withLocation).block.includes("HCLOUD_LOAD_BALANCERS_LOCATION"),
	);

	console.log(fails === 0 ? "\nself-test: all passed" : `\nself-test: ${fails} FAILED`);
	process.exit(fails === 0 ? 0 : 1);
}

// Only run the CLI when this file IS the entry point. Exporting `analyse`/`extractCcmBlock` while
// unconditionally calling main() meant any importer got `::error::… cannot read …cilium.tf` and was
// killed by this module's own CLI path — which is how a future test of these helpers would die
// (#2549, finding 4).
const isEntryPoint =
	process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
	if (process.argv.includes("--self-test")) selfTest();
	else main();
}
