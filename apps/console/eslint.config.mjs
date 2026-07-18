// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import vitest from "@vitest/eslint-plugin";

const eslintConfig = defineConfig([
	// Generated / build output — never linted.
	globalIgnores([
		".next/**",
		"out/**",
		"build/**",
		"coverage/**",
		".stryker-tmp/**",
		"reports/mutation/**",
		"next-env.d.ts",
		"types/database.types.ts",
		"lib/validations/database.schemas.ts",
	]),
	...nextVitals,
	{
		// Type-safety guard: the codebase holds ZERO explicit `any` (enforced here so it can't
		// regress). Use the real generated/finite type, or `unknown` with proper narrowing.
		files: ["**/*.{ts,tsx}"],
		rules: {
			"@typescript-eslint/no-explicit-any": "error",
		},
	},
	{
		// Cast guard (product code): ZERO `as` type assertions. They bypass the checker, so they're
		// banned outside tests — `as const` is exempt (it narrows, it doesn't assert a foreign type).
		// The handful of places TypeScript genuinely can't express a runtime-correct fact
		// (Object.keys→keyof T, distributed-union variance, generic Partial<T> writes per TS2862,
		// and upstream better-auth/AI-SDK/Stripe/react-flow type mismatches) use a described
		// `@ts-expect-error` instead: it carries no fabricated type, keeps the finite annotation,
		// and SELF-CLEANS — the day a TS/library upgrade fixes the limitation, the directive errors
		// as unused and forces its own removal. `@ts-ignore`/`@ts-nocheck` stay banned (they don't
		// self-clean); every `@ts-expect-error` must state why. Companion to no-explicit-any.
		files: ["**/*.{ts,tsx}"],
		ignores: ["tests/**", "e2e/**"],
		rules: {
			"@typescript-eslint/consistent-type-assertions": [
				"error",
				{ assertionStyle: "never" },
			],
			"@typescript-eslint/ban-ts-comment": [
				"error",
				{
					"ts-expect-error": "allow-with-description",
					"ts-ignore": true,
					"ts-nocheck": true,
					"ts-check": false,
					minimumDescriptionLength: 10,
				},
			],
		},
	},
	{
		// Test-quality guards — catch vacuous tests (no assertion, conditional/standalone expect,
		// duplicate titles). Complements mutation testing + the check-test-imports tripwire.
		files: ["tests/**/*.{ts,tsx}"],
		plugins: { vitest },
		rules: {
			// Hard guards against vacuous tests.
			"vitest/expect-expect": "error",
			"vitest/valid-expect": "error",
			"vitest/no-standalone-expect": "error",
			"vitest/no-identical-title": "error",
			// Advisory: the idiomatic zod `expect(r.success).toBe(true); if (r.success) {…}` narrowing
			// pattern (success IS asserted unconditionally first) trips this, so keep it visible but
			// non-blocking — mutation testing catches a genuinely-skipped assertion.
			"vitest/no-conditional-expect": "warn",
		},
	},
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
	{
		// Playwright fixtures use a `use` callback the rules-of-hooks rule misreads
		// as a React hook.
		files: ["e2e/**"],
		rules: { "react-hooks/rules-of-hooks": "off" },
	},
]);

export default eslintConfig;
