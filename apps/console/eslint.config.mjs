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
		// The react-hooks rules GATE (#6459). eslint-config-next spreads eslint-plugin-react-hooks 7's
		// `recommended` preset, whose React Compiler rules (purity, set-state-in-effect, refs,
		// incompatible-library, immutability, preserve-manual-memoization …) are errors; this file
		// used to set five of them back to "warn", and with no --max-warnings nothing gated, so the
		// count drifted to 78. They are now the preset's own errors again, and exhaustive-deps (a
		// "warn" in the preset) is raised to match. Fix a finding; do not soften one here.
		//
		// Errors rather than `--max-warnings 0`: the console's lint also carries advisory warnings by
		// decision (vitest/no-conditional-expect, above), and a global cap would gate on those too.
		//
		// The one honest suppression is TanStack Table's `useReactTable`, which has no form the
		// compiler can memoise: those sites carry a stated `eslint-disable-next-line
		// react-hooks/incompatible-library`. See docs/plans/console-react-hooks-warnings.md.
		rules: {
			"react-hooks/exhaustive-deps": "error",
		},
	},
	{
		// TODO(#6147): delete this block once #6147 lands. These four files are owned by #6147 (drop
		// `motion`), which is rewriting them, so their findings were left for it rather than fixed
		// under it: agent-chat.tsx, design-project-canvas.tsx and chart-workload-panel.tsx each set
		// state in an effect, and config-fields.tsx calls react-hook-form's `watch()`. Exactly these
		// paths and exactly those two rules; every other rule gates here as everywhere.
		files: [
			"components/agent/agent-chat.tsx",
			"components/design-project/canvas/design-project-canvas.tsx",
			"components/design-project/canvas/inspector/chart-workload-panel.tsx",
			"components/design-project/canvas/inspector/config-fields.tsx",
		],
		rules: {
			"react-hooks/set-state-in-effect": "warn",
			"react-hooks/incompatible-library": "warn",
		},
	},
	{
		// Session-hydration guard (#5382): product code reads the signed-in person through
		// `useViewer()` (components/providers/viewer-provider.tsx), never better-auth's `useSession`.
		// That hook hands the LIVE client session to `useSyncExternalStore` as its SERVER snapshot,
		// so anything rendered from it hydrates against the browser's session fetch rather than the
		// server's HTML — an intermittent React #418 (#5377, #5380).
		//
		// What is matched is the NAME `useSession` reached through any object, in each form that
		// reaches it: `x.useSession`, `x["useSession"]`, and destructuring `{ useSession } = x`.
		// The object is deliberately not read, so an alias of `authClient` or a second
		// `createAuthClient()` is caught too. Out of scope, stated: tests and e2e (they mock the
		// session the hook reads); a dynamically computed key (`x[name]`), which no lint can see.
		// lib/auth/client.ts no longer re-exports `useSession`, so importing it is a type error.
		files: ["**/*.{ts,tsx}"],
		ignores: ["tests/**", "e2e/**", "components/providers/viewer-provider.tsx"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector: "MemberExpression[property.name='useSession']",
					message:
						"Read the signed-in person with useViewer() from @/components/providers/viewer-provider — better-auth's useSession is not hydration-safe (#5382).",
				},
				{
					selector: "MemberExpression[computed=true][property.value='useSession']",
					message:
						"Read the signed-in person with useViewer() from @/components/providers/viewer-provider — better-auth's useSession is not hydration-safe (#5382).",
				},
				{
					selector: "ObjectPattern > Property[key.name='useSession']",
					message:
						"Read the signed-in person with useViewer() from @/components/providers/viewer-provider — better-auth's useSession is not hydration-safe (#5382).",
				},
			],
		},
	},
	{
		// Playwright fixtures use a `use` callback the rules-of-hooks rule misreads
		// as a React hook.
		files: ["e2e/**"],
		rules: { "react-hooks/rules-of-hooks": "off" },
	},
	{
		// An app may not reach into a SIBLING app with a relative path. On 2026-07-30 #1711 put a
		// marketing test under apps/console importing "../../../marketing/proxy"; console's tsconfig
		// includes **/*.ts, so that dragged apps/marketing/proxy.ts into the CONSOLE type-check, and
		// the console image installs --filter console... (no marketing) — so next/server did not
		// resolve there and TS2307 broke every production deploy for 26 days. Full CI stayed green
		// because it installs the whole workspace. Shared code is PROMOTED to packages/*, never
		// reached across for. This catches it at lint time instead of in a buildx log.
		rules: {
			"import/no-restricted-paths": [
				"error",
				{
					basePath: import.meta.dirname,
					zones: [{ target: ".", from: "../", except: ["./console"] }],
				},
			],
		},
	},
]);

export default eslintConfig;
