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
 * Strip `#` and `//` line comments from HCL.
 *
 * Deliberately naive about `#` inside a string: over-stripping can only make this guard STRICTER (a
 * real setting would have to be restated outside a comment), and strictness is the safe direction
 * for a guard whose whole job is to refuse a claim. Under-stripping is the failure that matters —
 * it is what let prose satisfy the check — and it is the one this closes.
 */
export function stripComments(hcl) {
	return hcl
		.split("\n")
		.map((line) => line.replace(/(^|\s)(#|\/\/).*$/, "$1"))
		.join("\n");
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
export function analyse(tf) {
	const block = extractCcmBlock(stripComments(tf));
	if (block === null) return { found: [], block: null };
	const found = LOCATION_KEYS.filter((k) =>
		// The rendered shape of a real setting, not the key appearing somewhere.
		new RegExp(`name\\s*=\\s*"env\\.${k}\\.value"`).test(block),
	);
	return { found, block };
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

	const { found, block } = analyse(tf);

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

	console.log(`✓ check-hetzner-lb-location: the hcloud CCM sets ${found.join(" + ")} — Load Balancers have a home.`);
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

	ok("a configured LOCATION passes", analyse(withLocation).found.length === 1);
	ok("a configured NETWORK_ZONE passes", analyse(withZone).found.length === 1);
	ok("the pre-fix shape FAILS", analyse(theBug).found.length === 0);
	ok("...and its block was still found (so it failed for the right reason)", analyse(theBug).block !== null);
	ok("KEYS NAMED ONLY IN A COMMENT do not satisfy the check (#2549)", analyse(keysOnlyInAComment).found.length === 0);
	ok("...and that block was found, so it is a real refusal", analyse(keysOnlyInAComment).block !== null);
	ok("a location outside the CCM block does NOT satisfy it", analyse(locationElsewhere).found.length === 0);
	ok("a missing CCM block is reported as absent, not as a pass", analyse("locals {}").block === null);
	ok("a brace inside a quoted value does not truncate the block (#2549)", analyse(braceInAString).found.length === 1);
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
