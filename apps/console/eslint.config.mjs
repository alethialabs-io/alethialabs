// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import vitest from "@vitest/eslint-plugin";

const USE_SESSION_MESSAGE =
	"Read the signed-in person with useViewer() from @/components/providers/viewer-provider — better-auth's useSession is not hydration-safe (#5382).";

/** The useSession hydration guard (#5382); see the block that applies it below. */
const USE_SESSION_SELECTORS = [
	{ selector: "MemberExpression[property.name='useSession']", message: USE_SESSION_MESSAGE },
	{
		selector: "MemberExpression[computed=true][property.value='useSession']",
		message: USE_SESSION_MESSAGE,
	},
	{ selector: "ObjectPattern > Property[key.name='useSession']", message: USE_SESSION_MESSAGE },
];

/** The names a caught error goes by in this codebase (#6650). The rule's boundary is stated below. */
const CAUGHT_ERROR_NAME = "/^(err|error|e|cause|reason|ex|exception)$/";
/** A server module: one with no `"use client"` directive. */
const SERVER_MODULE = "Program:not(:has(ExpressionStatement[directive='use client']))";
/** A `console.error(…)` or `console.warn(…)` call. */
const CONSOLE_ERROR_CALL =
	"CallExpression[callee.object.name='console'][callee.property.name=/^(error|warn)$/]";
/** An identifier named like a caught error, or a member chain rooted at one (`err.cause.message`). */
const ERROR_VALUE = [
	`Identifier[name=${CAUGHT_ERROR_NAME}]`,
	`MemberExpression:has(Identifier.object[name=${CAUGHT_ERROR_NAME}])`,
];
const CAUGHT_ERROR_MESSAGE =
	"Report a caught error through the structured logger: log.error(msg, { err }).";
/** The caught-error guard (#6650); see the block that applies it below. */
const CAUGHT_ERROR_SELECTORS = [
	...ERROR_VALUE.map((v) => `${CONSOLE_ERROR_CALL} > ${v}.arguments`),
	...ERROR_VALUE.map((v) => `${CONSOLE_ERROR_CALL} > TemplateLiteral.arguments > ${v}.expressions`),
	...ERROR_VALUE.map((v) => `${CONSOLE_ERROR_CALL} > CallExpression.arguments > ${v}.arguments`),
].map((selector) => ({ selector: `${SERVER_MODULE} ${selector}`, message: CAUGHT_ERROR_MESSAGE }));

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
			"no-restricted-syntax": ["error", ...USE_SESSION_SELECTORS],
		},
	},
	{
		// Caught-error guard (#6650, #6634): console server code reports a caught error through the
		// structured logger, `log.error(msg, { err })` / `log.warn(msg, { err })` from
		// lib/observability/log.ts, so its `err` serializer decides what is written. `console.error`
		// and `console.warn` hand the object to util.inspect, which prints the error's own enumerable
		// fields — more than the serializer allows (a DrizzleQueryError's bound parameter values).
		//
		// WHERE: app/**/*.ts and lib/**/*.ts. Not .tsx (components and pages), not tests, e2e or
		// scripts. A `"use client"` .ts module is excluded STRUCTURALLY, not by a list: every selector
		// is prefixed with `Program:not(:has(ExpressionStatement[directive='use client']))`, so the
		// directive itself takes the file out and a new client module needs no config edit. A .ts
		// module with no directive that still ships to the browser is listed below by path, with why.
		//
		// WHAT is matched: a `console.error`/`console.warn` call one of whose arguments is
		//   - an identifier named in CAUGHT_ERROR_NAME (`err`, `error`, `e`, `cause`, `reason`, `ex`,
		//     `exception`) — `console.error("x", err)`;
		//   - a member chain rooted at one — `err.message`, `err.cause.stack`;
		//   - a template literal interpolating either — `` `x: ${err}` ``, `` `${err.message}` ``;
		//   - a call taking either directly — `String(err)`, `JSON.stringify(err)`.
		// BOUNDARY, stated: the rule matches a NAME, not a binding. "The identifier bound by the
		// enclosing catch clause" cannot be written as a selector (esquery cannot compare one node's
		// attribute with another's), so `catch (boom) { console.error(boom) }` passes, and a non-error
		// value that happens to be called `reason` fires. An error first copied into another variable,
		// or passed nested deeper than the forms above, is not seen either. The name list is the
		// convention this codebase already uses for caught errors; a new name belongs in it.
		files: ["app/**/*.ts", "lib/**/*.ts"],
		ignores: [
			"**/*.test.ts",
			"**/__tests__/**",
			"**/e2e/**",
			"**/scripts/**",
			// Browser-reachable with no "use client" of its own: imported only by client components
			// (components/org/upgrade-org-sheet.tsx, components/billing/{credit-pack-dialog,
			// upgrade-ai-sheet}.tsx). The server logger (pino + OTel) cannot run there, and the
			// browser's devtools console is the only reader of this line, so console.error is right.
			"lib/billing/intent-error.ts",
		],
		rules: {
			// no-restricted-syntax's options REPLACE, they do not merge, so the useSession selectors
			// above are repeated here or they would stop applying to these files.
			"no-restricted-syntax": ["error", ...USE_SESSION_SELECTORS, ...CAUGHT_ERROR_SELECTORS],
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
