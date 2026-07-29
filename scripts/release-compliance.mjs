// SPDX-FileCopyrightText: 2026 Borislav Borisov and contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? join(root, "dist", "compliance"));
mkdirSync(output, { recursive: true });

const licenseRun = spawnSync(
  process.execPath,
  [join(root, "scripts", "license-inventory.mjs"), "--all"],
  { cwd: root, encoding: "utf8" },
);
if (!licenseRun.stdout) {
  throw new Error(`Node license inventory failed: ${licenseRun.stderr}`);
}
const nodeInventory = JSON.parse(licenseRun.stdout);
writeFileSync(
  join(output, "node-license-inventory.json"),
  `${JSON.stringify(nodeInventory, null, 2)}\n`,
);

function readGoModules(directory) {
  const result = spawnSync("go", ["list", "-m", "-json", "all"], {
    cwd: join(root, directory),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`go list failed in ${directory}: ${result.stderr}`);
  }
  const modules = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < result.stdout.length; index += 1) {
    const character = result.stdout[index];
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        modules.push(JSON.parse(result.stdout.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  return modules;
}

const goScopes = ["apps/cli", "apps/runner", "packages/core"];
const goModules = Object.fromEntries(
  goScopes.map((scope) => [scope, readGoModules(scope)]),
);
writeFileSync(
  join(output, "go-module-inventory.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), goModules }, null, 2)}\n`,
);

const components = [
  ...nodeInventory.packages.map((pkg) => ({
    type: "library",
    name: pkg.name,
    version: pkg.version,
    purl: `pkg:npm/${encodeURIComponent(pkg.name)}@${pkg.version}`,
    licenses: [{ license: { id: pkg.license } }],
  })),
  ...Object.values(goModules)
    .flat()
    .filter((module) => !module.Main)
    .map((module) => ({
      type: "library",
      name: module.Path,
      version: module.Version ?? "unknown",
      purl: module.Version
        ? `pkg:golang/${module.Path}@${module.Version}`
        : undefined,
    })),
];

const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: "alethialabs",
      version: commit,
    },
    properties: [
      {
        name: "alethia:inventory-scope",
        value:
          "workspace dependency inventory; scan each final container separately before release",
      },
    ],
  },
  components,
};
writeFileSync(
  join(output, "workspace.cdx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`,
);

if (nodeInventory.review.length > 0) {
  writeFileSync(
    join(output, "manual-review-required.json"),
    `${JSON.stringify(nodeInventory.review, null, 2)}\n`,
  );
}

if (licenseRun.status !== 0) {
  throw new Error(
    "License inventory contains unresolved metadata; artifacts were written for review.",
  );
}

process.stdout.write(`${output}\n`);
