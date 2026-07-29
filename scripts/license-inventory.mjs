// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Inventory installed Node packages without downloading or executing dependency
// code. This is a discovery control; release artifacts still require direct SBOM
// scanning because node_modules contains build-only and unshipped packages.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const store = join(process.cwd(), "node_modules", ".pnpm");
const overrides = JSON.parse(
  readFileSync(
    join(process.cwd(), "compliance", "license-overrides.json"),
    "utf8",
  ),
);
const entries = readdirSync(store, { withFileTypes: true }).filter((e) =>
  e.isDirectory(),
);
const packages = new Map();

function record(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!manifest.name || !manifest.version) return;
    const key = `${manifest.name}@${manifest.version}`;
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? overrides[key]?.license ?? "UNKNOWN");
    packages.set(key, {
      name: manifest.name,
      version: manifest.version,
      license,
      override: overrides[key] ?? undefined,
    });
  } catch {
    // Package-store layouts vary; unreadable/non-manifest paths are ignored.
  }
}

for (const entry of entries) {
  const modules = join(store, entry.name, "node_modules");
  let scopedOrPackages = [];
  try {
    scopedOrPackages = readdirSync(modules, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const item of scopedOrPackages) {
    if (!item.isDirectory()) continue;
    if (item.name.startsWith("@")) {
      for (const child of readdirSync(join(modules, item.name), {
        withFileTypes: true,
      })) {
        if (child.isDirectory()) {
          record(join(modules, item.name, child.name, "package.json"));
        }
      }
    } else {
      record(join(modules, item.name, "package.json"));
    }
  }
}

const inventory = [...packages.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
const counts = Object.fromEntries(
  Object.entries(
    inventory.reduce((acc, item) => {
      acc[item.license] = (acc[item.license] ?? 0) + 1;
      return acc;
    }, {}),
  ).sort(([a], [b]) => a.localeCompare(b)),
);
const reviewPattern =
  /(AGPL|GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|BSL|FSL|Commons Clause|UNKNOWN)/i;
const review = inventory.filter((item) => reviewPattern.test(item.license));
const report = {
  generatedAt: new Date().toISOString(),
  scope:
    "installed pnpm store; includes build/dev packages and is not a release-artifact SBOM",
  total: inventory.length,
  counts,
  review,
  packages: process.argv.includes("--all") ? inventory : undefined,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (inventory.some((item) => item.license === "UNKNOWN")) process.exitCode = 2;
