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
// The check is deliberately SHAPE-based, not value-based: it asserts a location or network zone is
// configured, never which one. A region change must not red this.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CCM_FILE = "infra/templates/project/hetzner/cilium.tf";

/** The env keys the CCM will accept as "where do Load Balancers go". Either satisfies it. */
const LOCATION_KEYS = ["HCLOUD_LOAD_BALANCERS_LOCATION", "HCLOUD_LOAD_BALANCERS_NETWORK_ZONE"];

/**
 * Extract the `data "helm_template" "hcloud_ccm" { … }` block from a .tf source by brace
 * balance. Returns null when the block is absent, which the caller treats as a HARD failure
 * rather than a pass — a missing block means this check has stopped looking at anything.
 */
export function extractCcmBlock(tf) {
	const start = tf.search(/data\s+"helm_template"\s+"hcloud_ccm"\s*\{/);
	if (start === -1) return null;
	const open = tf.indexOf("{", start);
	let depth = 0;
	for (let i = open; i < tf.length; i++) {
		if (tf[i] === "{") depth++;
		else if (tf[i] === "}") {
			depth--;
			if (depth === 0) return tf.slice(open, i + 1);
		}
	}
	return null;
}

/**
 * Report which of the accepted location keys the CCM block configures.
 * @returns {{found: string[], block: string|null}}
 */
export function analyse(tf) {
	const block = extractCcmBlock(tf);
	if (block === null) return { found: [], block: null };
	const found = LOCATION_KEYS.filter((k) => block.includes(k));
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
			`::error::check-hetzner-lb-location: the hcloud CCM configures neither ${LOCATION_KEYS.join(" nor ")}. ` +
				`Without one, hcloud-cloud-controller-manager REFUSES to create a Load Balancer, so every ` +
				`\`type: LoadBalancer\` Service on a Hetzner cluster sits Pending forever — silently. That is what ` +
				`caused #2490: no LB → ingress-nginx Service never healthy → ArgoCD never reaches PostSync → the ` +
				`admission webhook's caBundle is never patched → every Ingress fails x509. See ${CCM_FILE}.`,
		);
		process.exit(1);
	}

	console.log(`✓ check-hetzner-lb-location: the hcloud CCM sets ${found.join(" + ")} — Load Balancers have a home.`);
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
// Asserts BOTH directions. A guard whose failing branch is never exercised is a guard that will
// report green through the very regression it exists to catch (#2490 was found by hand, not by CI).
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
	// The EXACT pre-fix shape that shipped the bug. If this ever passes, the check is worthless.
	const theBug = `
data "helm_template" "hcloud_ccm" {
  set { name = "networking.enabled" value = "true" }
  set { name = "networking.clusterCIDR" value = local.pod_cidr }
}`;
	// A location set on some OTHER resource must not satisfy the CCM.
	const locationElsewhere = `
resource "hcloud_load_balancer" "unrelated" { location = "nbg1" }
data "helm_template" "hcloud_ccm" {
  set { name = "networking.enabled" value = "true" }
}
locals { note = "HCLOUD_LOAD_BALANCERS_LOCATION mentioned in a comment outside the block" }`;

	ok("a configured LOCATION passes", analyse(withLocation).found.length === 1);
	ok("a configured NETWORK_ZONE passes", analyse(withZone).found.length === 1);
	ok("the pre-fix shape FAILS", analyse(theBug).found.length === 0);
	ok("...and its block was still found (so it failed for the right reason)", analyse(theBug).block !== null);
	ok("a location outside the CCM block does NOT satisfy it", analyse(locationElsewhere).found.length === 0);
	ok("a missing CCM block is reported as absent, not as a pass", analyse("locals {}").block === null);
	// Brace balance: a nested block must not truncate extraction early.
	ok(
		"nested braces do not truncate the block",
		analyse(withLocation).block.includes("HCLOUD_LOAD_BALANCERS_LOCATION"),
	);

	console.log(fails === 0 ? "\nself-test: all passed" : `\nself-test: ${fails} FAILED`);
	process.exit(fails === 0 ? 0 : 1);
}

if (process.argv.includes("--self-test")) selfTest();
else main();
