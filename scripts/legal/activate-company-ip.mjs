#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// The one-command, evidence-gated switch from founder ownership to company ownership.
//
// Registering the company did NOT transfer the intellectual property. Until the founder assignment
// is signed, every ownership notice in this repository must keep saying so — and #2366 exists
// because the tempting failure is to quietly flip that prose the day the company appears in the
// register. This script is the opposite: it refuses to change a single word until it has verified
// a sealed, hashed, signed PDF.
//
// It is FAIL-CLOSED in five independent ways. Each one alone stops an activation:
//   1. `cla/ACTIVE` must not already exist — activation is not idempotent, it is once.
//   2. Every field in the evidence manifest must match the registered entity, read from the
//      controlled legal source, not from a copy kept here.
//   3. The sealed file must exist, must actually be a PDF, and its SHA-256 must match the manifest.
//   4. Every prose marker must appear EXACTLY ONCE in its file. Zero means the wording drifted and
//      this script no longer knows what it is rewriting; two means it would rewrite the wrong one.
//   5. Nothing is written without `--apply`. The default is a dry run that reports what it would do.
//
// Why (2) reads a file instead of hardcoding: the entity's legal form is volatile, and
// scripts/check-license-headers.mjs already records the rule — "the volatile legal form lives ONLY
// in packages/legal/src/entity.ts (LEGAL_ENTITY) + NOTICE / LICENSE prose". A second copy of the
// name and EIK in this file would be a second thing to forget on a rename. That is the same defect
// that let programme-rollup call two live gates dead: a checker mirroring an emitter that moved.
//
// Usage:
//   node scripts/legal/activate-company-ip.mjs --check-markers          (CI: are the markers intact?)
//   node scripts/legal/activate-company-ip.mjs --evidence path/to/SIGNED_EVIDENCE.json
//   node scripts/legal/activate-company-ip.mjs --evidence … --apply
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTITY_SOURCE = "packages/legal/src/entity.ts";

function fail(message) {
	console.error(`activation refused: ${message}`);
	process.exit(1);
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Reads the registered-entity facts from the controlled legal source. Parsed rather than imported
 * because this is a .mjs script and entity.ts is TypeScript; the repo already reads generated/
 * source TS this way (see parseUnsupportedKinds in scripts/programme-rollup.mjs).
 * @returns {{legalName: string, registrationNumber: string, registeredAddress: string}}
 */
export function readLegalEntity(tsText) {
	const field = (name) => {
		const m = tsText.match(new RegExp(`\\b${name}:\\s*\\n?\\s*"([^"]+)"`));
		return m === null ? null : m[1];
	};
	const legalName = field("legalName");
	const registrationNumber = field("registrationNumber");
	const registeredAddress = field("registeredAddress");
	if (!legalName || !registrationNumber || !registeredAddress) {
		fail(`${ENTITY_SOURCE}: could not read legalName / registrationNumber / registeredAddress`);
	}
	return { legalName, registrationNumber, registeredAddress };
}

function parseArgs(argv) {
	if (argv.includes("--check-markers")) return { checkMarkers: true, apply: false };
	const i = argv.indexOf("--evidence");
	if (i === -1 || !argv[i + 1]) fail("pass --evidence /path/to/SIGNED_EVIDENCE.json (or --check-markers)");
	return { evidence: resolve(argv[i + 1]), checkMarkers: false, apply: argv.includes("--apply") };
}

const pendingChanges = new Map();

/**
 * Stages one prose rewrite, refusing unless the marker appears exactly once. A marker that no longer
 * matches means the legal wording moved on without this script — the right response is to stop and
 * re-read the file, never to guess.
 */
function replaceExactly(path, before, after) {
	const absolute = resolve(root, path);
	if (!existsSync(absolute)) fail(`${path}: file does not exist`);
	const current = pendingChanges.get(absolute) ?? readFileSync(absolute, "utf8");
	const occurrences = current.split(before).length - 1;
	if (occurrences !== 1) fail(`${path}: expected one activation marker, found ${occurrences}`);
	pendingChanges.set(absolute, current.replace(before, after));
	return absolute;
}

const args = parseArgs(process.argv.slice(2));
if (existsSync(resolve(root, "cla/ACTIVE"))) fail("cla/ACTIVE already exists — ownership is already activated");

const entity = readLegalEntity(readFileSync(resolve(root, ENTITY_SOURCE), "utf8"));

let evidence;
let signedFile;
if (args.checkMarkers) {
	// A marker check must exercise the SAME rewrite path a real activation takes, or it would pass
	// while the thing it guards is broken. Only the evidence is synthetic.
	evidence = { effective_date: "2099-01-01" };
} else {
	if (!existsSync(args.evidence)) fail(`evidence manifest does not exist: ${args.evidence}`);
	try {
		evidence = JSON.parse(readFileSync(args.evidence, "utf8"));
	} catch (error) {
		fail(`invalid evidence manifest: ${error.message}`);
	}
	if (evidence.entity !== entity.legalName) {
		fail(`evidence entity "${evidence.entity}" does not match ${ENTITY_SOURCE} ("${entity.legalName}")`);
	}
	if (evidence.eik !== entity.registrationNumber) {
		fail(`evidence eik "${evidence.eik}" does not match ${ENTITY_SOURCE} ("${entity.registrationNumber}")`);
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.effective_date ?? "")) {
		fail("evidence effective_date must use YYYY-MM-DD");
	}
	// The anchor names the repository state the signed asset schedule enumerates. It is checked for
	// existence rather than against a constant on purpose: a constant baked in before signature is
	// a value nobody has agreed to yet. Read the printed anchor back against the signed schedule.
	if (!/^[0-9a-f]{40}$/.test(evidence.repository_anchor ?? "")) {
		fail("evidence repository_anchor must be a full 40-character commit SHA");
	}
	try {
		execFileSync("git", ["-C", root, "cat-file", "-e", `${evidence.repository_anchor}^{commit}`], { stdio: "ignore" });
	} catch {
		fail(`evidence repository_anchor ${evidence.repository_anchor} is not a commit in this repository`);
	}
	signedFile = resolve(dirname(args.evidence), evidence.signed_file ?? "");
	if (!existsSync(signedFile)) fail(`sealed signed file does not exist: ${signedFile}`);
	if (readFileSync(signedFile).subarray(0, 5).toString() !== "%PDF-") fail("sealed evidence is not a PDF");
	if (sha256(signedFile) !== evidence.signed_file_sha256) fail("sealed signed PDF hash mismatch");
}

const on = evidence.effective_date;

// ── the prose markers ──
// Each `before` is the CURRENT wording on dev, verbatim. Each `after` is what becomes true only once
// the assignment is signed. Nothing here asserts company ownership before that.
const changes = [
	replaceExactly(
		"COPYRIGHT.md",
		`The founder currently owns the founder-created pre-incorporation
software, documentation, logo, design system, domains, and related works, subject
to the rights of third-party dependencies and contributors.

The prepared founder assignment is a draft and is not effective until the
registered company is correctly identified and the agreement is signed.`,
		`Under the founder assignment effective ${on}, ${entity.legalName} owns the exclusive economic
rights in the scheduled founder-created pre-incorporation software, Enterprise code, documentation,
logo, design system, domains, and related works, subject to prior open-source grants and the rights
of third-party dependencies and contributors.`,
	),
	replaceExactly(
		"COPYRIGHT.md",
		`## Required activation steps

1. Record the exact registered legal name, form, EIK, address, and registration date
   in the controlled legal source.
2. Complete counsel review of the founder assignment, moral-rights language,
   consideration/tax treatment, thesis statement, and future-works arrangement.
3. Sign the founder assignment and company acceptance documentation.
4. Activate a versioned ICLA and CCLA and record the exact document hash.
5. Update this notice and the public legal-entity record without rewriting file
   histories or removing contributor attribution.`,
		`## Execution evidence

The founder assignment became effective on ${on}. Its sealed evidence is recorded in the ownership
evidence manifest referenced by \`cla/ACTIVE\`. The company must retain that evidence, the
deferred-consideration accounting record, and each later periodic assignment, without rewriting
repository history or removing contributor attribution.`,
	),
	replaceExactly(
		"LICENSING.md",
		`ALETHIA LABS is registered in Bulgaria as a single-member variable capital company
under EIK 208913663. Founder-created pre-incorporation works remain owned by the
founder until a written assignment
to the registered company is completed. External contributors retain copyright
in their contributions and grant rights under the applicable project licence and,
after activation, the Contributor Licence Agreement.`,
		`${entity.legalName} is registered in Bulgaria as a single-member variable capital company under
EIK ${entity.registrationNumber}, and owns the exclusive economic rights in the founder-created works
scheduled in the founder assignment effective ${on}. Prior open-source grants remain valid. External
contributors retain copyright in their contributions and grant rights under the applicable project
licence and the active Contributor Licence Agreement.`,
	),
	replaceExactly(
		"LICENSING.md",
		`Third-party contributions remain paused until a versioned ICLA or CCLA is active,
its exact document hash is recorded, and the required CLA status check passes.
Company registration does not by itself activate those agreements.`,
		`Third-party contributions require the active versioned ICLA or CCLA for ${entity.legalName}, and
the required \`contribution-legal\` status check must pass before an outside contribution may merge.`,
	),
	replaceExactly(
		"NOTICE",
		`Copyright (c) 2026-present Borislav Borisov and contributors.

ALETHIA LABS, a Bulgarian single-member variable capital company (EIK 208913663),
is registered in Bulgaria. Founder-created pre-incorporation code,
documentation, brand, and design assets remain owned by
Borislav Borisov until a written assignment to the company is signed and accepted.`,
		`Copyright (c) 2026-present ${entity.legalName}, Borislav Borisov, and contributors.

${entity.legalName}, a Bulgarian single-member variable capital company (EIK
${entity.registrationNumber}), owns the exclusive economic rights in the scheduled founder-created
works under the assignment effective ${on}. Prior open-source grants and third-party rights remain
unaffected.`,
	),
	replaceExactly(
		"LICENSE",
		`Copyright (c) 2026-present Borislav Borisov and contributors`,
		`Copyright (c) 2026-present ${entity.legalName}, Borislav Borisov, and contributors`,
	),
	replaceExactly(
		"ee/LICENSE",
		`Copyright (c) 2026-present Borislav Borisov. All rights reserved.`,
		`Copyright (c) 2026-present ${entity.legalName}. All rights reserved.`,
	),
	replaceExactly(
		"ee/LICENSE",
		`ALETHIA LABS is registered as a Bulgarian single-member variable capital company
under EIK 208913663, but registration did not transfer founder-created works.
Until the relevant rights are assigned in writing, Borislav Borisov is the
copyright holder and commercial licensing party. For commercial
licensing enquiries, contact legal@alethialabs.io.`,
		`${entity.legalName}, EIK ${entity.registrationNumber}, owns and commercially licenses the
scheduled founder-authored Enterprise code under the assignment effective ${on}. For commercial
licensing enquiries, contact legal@alethialabs.io.`,
	),
	replaceExactly(
		"ee/README.md",
		`ALETHIA LABS is registered as a Bulgarian single-member variable capital company
under EIK 208913663. Founder-created enterprise code remains part of the founder's
pre-incorporation works until a written assignment to the company is executed.
External contributors retain copyright and must be covered by the
active contribution agreement before their work is accepted.`,
		`${entity.legalName}, EIK ${entity.registrationNumber}, owns the exclusive economic rights in the
scheduled founder-created Enterprise code under the assignment effective ${on}. External contributors
retain copyright and must be covered by the active contribution agreement before their work is
accepted.`,
	),
	replaceExactly(
		"CONTRIBUTING.md",
		`> **CLA activation gate:** ALETHIA LABS is registered as a Bulgarian single-member
> variable capital company under EIK 208913663.
> We welcome issues and discussion, but cannot merge third-party code until the
> versioned post-registration CLA is activated and the required
> \`contribution-legal\` check passes.

After activation, every external contributor must sign the versioned Contributor
License Agreement before a contribution can merge.`,
		`> **CLA required:** ${entity.legalName} is registered as a Bulgarian single-member variable
> capital company under EIK ${entity.registrationNumber}. The required \`contribution-legal\` check
> enforces the signature requirement automatically.

Every external contributor must sign the active, versioned Contributor
License Agreement before a contribution can merge.`,
	),
	replaceExactly(
		"cla/README.md",
		`The agreements in this directory identify the registered company but remain
inactive drafts. They must not be signed until counsel approves the text and the
versioned activation record and signing workflow are enabled.`,
		`The agreements in this directory are active for ${entity.legalName}. Their activation date, exact
document hashes, and the sealed founder-ownership evidence are recorded in \`cla/ACTIVE\`.`,
	),
];

const iclaHash = sha256(resolve(root, "cla/ICLA.md"));
const cclaHash = sha256(resolve(root, "cla/CCLA.md"));
const active = [
	`entity: ${entity.legalName}`,
	`eik: "${entity.registrationNumber}"`,
	`registered_address: "${entity.registeredAddress}"`,
	`cla_version: "1.1"`,
	`effective_date: "${on}"`,
	`repository_anchor: "${evidence.repository_anchor ?? "[marker-check]"}"`,
	// The manifest's NAME and HASH, never its path: it lives in the private management repo, and an
	// absolute path from whichever machine ran the activation is not a durable legal reference.
	`founder_ownership_evidence: "${args.evidence ? basename(args.evidence) : "[marker-check]"}"`,
	`founder_ownership_evidence_sha256: "${args.evidence ? sha256(args.evidence) : "[marker-check]"}"`,
	`signed_evidence_sha256: "${evidence.signed_file_sha256 ?? "[marker-check]"}"`,
	`icla_sha256: "${iclaHash}"`,
	`ccla_sha256: "${cclaHash}"`,
	"",
].join("\n");

const workflowSource = resolve(root, "cla/cla-active-workflow.yml");
if (!existsSync(workflowSource)) fail("cla/cla-active-workflow.yml is missing — nothing to activate the CLA with");
const workflow = readFileSync(workflowSource, "utf8");

if (args.checkMarkers) {
	console.log(`activation markers: ok (${changes.length} markers across ${pendingChanges.size} files)`);
	console.log(`entity source: ${ENTITY_SOURCE} → ${entity.legalName}, EIK ${entity.registrationNumber}`);
	process.exit(0);
}

console.log(`verified sealed evidence: ${signedFile}`);
console.log(`  sha256:          ${evidence.signed_file_sha256}`);
console.log(`  effective date:  ${on}`);
console.log(`  entity:          ${entity.legalName}, EIK ${entity.registrationNumber}`);
console.log(`  anchor:          ${evidence.repository_anchor}  ← check this against the signed schedule`);
console.log(`prepared ${pendingChanges.size + 2} repository updates from ${changes.length} verified markers`);
if (!args.apply) {
	console.log("dry run only; rerun with --apply to activate ownership and the CLA workflow");
	process.exit(0);
}
for (const [path, content] of pendingChanges) writeFileSync(path, content);
writeFileSync(resolve(root, "cla/ACTIVE"), active);
writeFileSync(resolve(root, ".github/workflows/cla.yml"), workflow);
console.log("company ownership and CLA workflow activated; commit only after branch/ruleset checks");
