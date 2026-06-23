// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../");

const config: NextConfig = {
	basePath: "/blog",
	output: "standalone",
	// Monorepo: trace workspace files from the repo root for a self-contained
	// standalone bundle inside Docker.
	outputFileTracingRoot: repoRoot,
	reactStrictMode: true,
};

export default config;
