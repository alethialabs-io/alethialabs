// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
	...nextVitals,
	globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".velite/**"]),
]);

export default eslintConfig;
