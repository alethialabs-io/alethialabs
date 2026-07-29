// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const allowedPackageReference = new Set([
  "apps/console/lib/enterprise.ts",
  "apps/console/next.config.ts",
  "apps/console/package.json",
  "apps/console/Dockerfile",
  "apps/console/README.md",
  "scripts/dev-up.sh",
  "scripts/box/env-mode.sh",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
]);
const violations = [];

for (const file of files) {
  if (
    file.startsWith("ee/") ||
    file.endsWith(".md") ||
    file.endsWith(".mdx") ||
    allowedPackageReference.has(file)
  ) {
    continue;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (/['"]@alethia\/ee['"]/.test(text)) {
    violations.push(
      `${file}: imports or resolves @alethia/ee outside the boundary`,
    );
  }
  if (
    /\bfrom\s+['"][^'"]*\/ee(?:\/|['"])/.test(text) ||
    /\brequire\(\s*['"][^'"]*\/ee(?:\/|['"])/.test(text)
  ) {
    violations.push(`${file}: imports the enterprise directory by path`);
  }
}

const communityDocker = readFileSync(
  "apps/console/Dockerfile.community",
  "utf8",
);
for (const required of [
  "RUN rm -rf ee",
  "ALETHIA_EDITION=community",
  "pnpm install --frozen-lockfile --filter console...",
]) {
  if (!communityDocker.includes(required)) {
    violations.push(`Dockerfile.community: missing ${required}`);
  }
}

if (violations.length) {
  console.error("Open-core boundary violations:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("OK — community/enterprise repository boundary is explicit.");
