// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Writes src/brand.generated.ts from packages/brand. Run from packages/status via `pnpm gen:brand`,
// which bundles this file with esbuild first (it imports a .tsx component and React).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { generatedModule } from "./brand-source";

const out = join(process.cwd(), "src", "brand.generated.ts");
writeFileSync(out, generatedModule());
process.stdout.write(`wrote ${out}\n`);
