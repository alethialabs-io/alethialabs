#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const expected = {
  entity: "ALETHIA LABS EDPK",
  eik: "208913663",
  repository_anchor: "0ccb09796151dff50ed3696970b7d4a0b99f10fb",
};

function fail(message) {
  console.error(`activation refused: ${message}`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv) {
  if (argv.includes("--check-markers")) {
    return { checkMarkers: true, apply: false };
  }
  const evidenceIndex = argv.indexOf("--evidence");
  if (evidenceIndex === -1 || !argv[evidenceIndex + 1]) {
    fail("pass --evidence /absolute/or/relative/path/to/SIGNED_EVIDENCE.json");
  }
  return {
    evidence: resolve(argv[evidenceIndex + 1]),
    checkMarkers: false,
    apply: argv.includes("--apply"),
  };
}

const pendingChanges = new Map();

function replaceExactly(path, before, after) {
  const absolute = resolve(root, path);
  const current =
    pendingChanges.get(absolute) ?? readFileSync(absolute, "utf8");
  const occurrences = current.split(before).length - 1;
  if (occurrences !== 1)
    fail(`${path}: expected one activation marker, found ${occurrences}`);
  pendingChanges.set(absolute, current.replace(before, after));
  return absolute;
}

const args = parseArgs(process.argv.slice(2));
if (existsSync(resolve(root, "cla/ACTIVE"))) fail("cla/ACTIVE already exists");

let evidence;
let signedFile;
if (args.checkMarkers) {
  evidence = {
    ...expected,
    effective_date: "2099-01-01",
    signed_file_sha256: "0".repeat(64),
  };
} else {
  if (!existsSync(args.evidence))
    fail(`evidence manifest does not exist: ${args.evidence}`);
  try {
    evidence = JSON.parse(readFileSync(args.evidence, "utf8"));
  } catch (error) {
    fail(`invalid evidence manifest: ${error.message}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (evidence[key] !== value)
      fail(`evidence ${key} does not match the approved transaction`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidence.effective_date ?? "")) {
    fail("evidence effective_date must use YYYY-MM-DD");
  }
  signedFile = resolve(dirname(args.evidence), evidence.signed_file ?? "");
  if (!existsSync(signedFile))
    fail(`sealed signed file does not exist: ${signedFile}`);
  if (readFileSync(signedFile).subarray(0, 5).toString() !== "%PDF-")
    fail("sealed evidence is not a PDF");
  if (sha256(signedFile) !== evidence.signed_file_sha256)
    fail("sealed signed PDF hash mismatch");
}

const changes = [
  replaceExactly(
    "COPYRIGHT.md",
    `The founder currently owns the founder-created pre-incorporation\nsoftware, documentation, logo, design system, domains, and related works, subject\nto the rights of third-party dependencies and contributors.\n\nThe post-registration founder assignment is prepared but is not effective until\nthe sole-owner approval, controlling Bulgarian agreement, and asset schedules are\nsigned. Repository ownership notices must not be switched before that execution.`,
    `Under the founder assignment effective ${evidence.effective_date}, ALETHIA LABS EDPK owns the exclusive economic rights in the scheduled founder-created pre-incorporation software, Enterprise code, documentation, logo, design system, domains, and related works, subject to prior open-source grants and the rights of third-party dependencies and contributors.`,
  ),
  replaceExactly(
    "LICENSING.md",
    `ALETHIA LABS EDPK is registered in Bulgaria under EIK 208913663. Founder-created\npre-incorporation works remain owned by the founder until the prepared written\nassignment to the company is signed. External contributors retain copyright\nin their contributions and grant rights under the applicable project licence and,\nafter activation, the Contributor Licence Agreement.`,
    `ALETHIA LABS EDPK is registered in Bulgaria under EIK 208913663 and owns the exclusive economic rights in the founder-created works scheduled in the founder assignment effective ${evidence.effective_date}. Prior open-source grants remain valid. External contributors retain copyright in their contributions and grant rights under the applicable project licence and the active Contributor Licence Agreement.`,
  ),
  replaceExactly(
    "NOTICE",
    `Copyright (c) 2026-present Borislav Borisov and contributors.\n\nALETHIA LABS EDPK is registered in Bulgaria under EIK 208913663. Until the\nprepared founder IP assignment is signed, the company must not be represented as\nthe owner of all pre-incorporation code, documentation, brand, or design assets.`,
    `Copyright (c) 2026-present ALETHIA LABS EDPK, Borislav Borisov, and contributors.\n\nALETHIA LABS EDPK, EIK 208913663, owns the exclusive economic rights in the scheduled founder-created works under the assignment effective ${evidence.effective_date}. Prior open-source grants and third-party rights remain unaffected.`,
  ),
  replaceExactly(
    "ee/LICENSE",
    `Copyright (c) 2026-present Borislav Borisov. All rights reserved.`,
    `Copyright (c) 2026-present ALETHIA LABS EDPK. All rights reserved.`,
  ),
  replaceExactly(
    "ee/LICENSE",
    `ALETHIA LABS EDPK is registered in Bulgaria under EIK 208913663. Until the\nprepared founder assignment is signed, Borislav Borisov remains the copyright\nholder and commercial licensor of the founder-authored Enterprise code. For\ncommercial licensing enquiries, contact legal@alethialabs.io.`,
    `ALETHIA LABS EDPK, EIK 208913663, owns and commercially licenses the scheduled founder-authored Enterprise code under the assignment effective ${evidence.effective_date}. For commercial licensing enquiries, contact legal@alethialabs.io.`,
  ),
  replaceExactly(
    "ee/README.md",
    `ALETHIA LABS EDPK is registered in Bulgaria under EIK 208913663. Founder-created\nenterprise code remains part of the founder's pre-incorporation works until the\nprepared post-registration assignment is signed. External contributors retain\ncopyright and must be covered by the active contribution agreement before their\nwork is accepted.`,
    `ALETHIA LABS EDPK, EIK 208913663, owns the exclusive economic rights in the scheduled founder-created Enterprise code under the assignment effective ${evidence.effective_date}. External contributors retain copyright and must be covered by the active contribution agreement before their work is accepted.`,
  ),
  replaceExactly(
    "LICENSE",
    `Copyright (c) 2026-present Borislav Borisov and contributors`,
    `Copyright (c) 2026-present ALETHIA LABS EDPK, Borislav Borisov, and contributors`,
  ),
  replaceExactly(
    "COPYRIGHT.md",
    `## Required activation steps\n\n1. Sign the sole-owner approval, founder agreement, and attached schedules.\n2. Record the deferred consideration and acquired right in the company records.\n3. Activate a versioned ICLA and CCLA and record the exact document hash.\n4. Update this notice and the current licensor record without rewriting file\n   histories or removing contributor attribution.`,
    `## Execution evidence\n\nThe founder assignment became effective on ${evidence.effective_date}. Its sealed evidence is recorded in the ownership evidence manifest referenced by \`cla/ACTIVE\`. The company must retain that evidence, the deferred-consideration accounting record, and each later periodic assignment without rewriting repository history or removing contributor attribution.`,
  ),
  replaceExactly(
    "LICENSING.md",
    `Third-party contributions remain paused until a versioned ICLA or CCLA is active\nfor ALETHIA LABS EDPK and the required CLA\nstatus check must pass before outside contributions may merge.`,
    `Third-party contributions require the active versioned ICLA or CCLA for ALETHIA LABS EDPK, and the required \`cla\` status check must pass before outside contributions may merge.`,
  ),
  replaceExactly(
    "CONTRIBUTING.md",
    `> **CLA activation gate:** ALETHIA LABS EDPK is registered under EIK 208913663.\n> We welcome issues and discussion, but cannot merge third-party code until the\n> post-registration CLA is activated. The required \`contribution-legal\` check\n> enforces this automatically.\n\nAfter activation, every external contributor must sign the versioned Contributor\nLicense Agreement before a contribution can merge.`,
    `> **CLA required:** ALETHIA LABS EDPK is registered under EIK 208913663. Every external contributor must sign the active, versioned Contributor License Agreement before a contribution can merge. The required \`cla\` check enforces this automatically.`,
  ),
  replaceExactly(
    "CONTRIBUTING.md",
    `5. Open a pull request. Until the CLA is active, external PRs remain reviewable\n   but cannot merge. After activation, sign the CLA when prompted.`,
    `5. Open a pull request and sign the CLA when prompted. An external PR cannot merge until its required \`cla\` status passes.`,
  ),
  replaceExactly(
    "cla/README.md",
    `They are not active until\n\`cla/ACTIVE\` records their exact hashes and the signing workflow is enabled.`,
    `Their activation date, exact hashes, and signed founder-ownership evidence are recorded in \`cla/ACTIVE\`.`,
  ),
];

const iclaHash = sha256(resolve(root, "cla/ICLA.md"));
const cclaHash = sha256(resolve(root, "cla/CCLA.md"));
const active = `entity: ALETHIA LABS EDPK\neik: "208913663"\nregistered_address: "ul. Sirak Skitnik 9, entrance A, floor 4, apartment 7, 1111 Sofia, Bulgaria"\ncla_version: "1.1"\neffective_date: "${evidence.effective_date}"\nfounder_ownership_evidence: "${args.evidence ?? "[marker-check]"}"\nsigned_evidence_sha256: "${evidence.signed_file_sha256}"\nicla_sha256: "${iclaHash}"\nccla_sha256: "${cclaHash}"\n`;
const workflow = readFileSync(
  resolve(root, "cla/cla-active-workflow.yml"),
  "utf8",
);

if (args.checkMarkers) {
  console.log(
    `activation markers: ok (${changes.length} markers in ${pendingChanges.size} files)`,
  );
  process.exit(0);
}
console.log(`verified signed evidence: ${signedFile}`);
console.log(`effective date: ${evidence.effective_date}`);
console.log(
  `prepared ${pendingChanges.size + 2} repository updates from ${changes.length} verified markers`,
);
if (!args.apply) {
  console.log(
    "dry run only; rerun with --apply to activate ownership and the CLA workflow",
  );
  process.exit(0);
}
for (const [path, content] of pendingChanges) writeFileSync(path, content);
writeFileSync(resolve(root, "cla/ACTIVE"), active);
writeFileSync(resolve(root, ".github/workflows/cla.yml"), workflow);
console.log(
  "company ownership and CLA workflow activated; commit only after branch/ruleset checks",
);
