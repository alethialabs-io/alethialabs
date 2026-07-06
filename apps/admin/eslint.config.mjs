// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
	globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
	...nextVitals,
	{
		// The new React-Compiler-era react-hooks rules (eslint-config-next 16) are
		// advisory for this codebase — keep them visible as warnings, not blockers.
		// The classic rules-of-hooks / exhaustive-deps stay as configured.
		rules: {
			"react-hooks/purity": "warn",
			"react-hooks/set-state-in-effect": "warn",
			"react-hooks/refs": "warn",
			"react-hooks/incompatible-library": "warn",
			"react-hooks/preserve-manual-memoization": "warn",
		},
	},
]);

export default eslintConfig;
