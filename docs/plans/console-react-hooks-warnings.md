# Console: fix the react-hooks (React Compiler) lint findings, then gate on them (#6459)

## Where this started

`apps/console` lints with `eslint-config-next/core-web-vitals`, and that config spreads
`eslint-plugin-react-hooks@7`'s `recommended` preset. In the preset the React Compiler rules are
errors. The console's `eslint.config.mjs` then sets five of them back to `warn` (`purity`,
`set-state-in-effect`, `refs`, `incompatible-library` and `preserve-manual-memoization`), and
`exhaustive-deps` is `warn` in the preset itself. No `--max-warnings` applies, so nothing gates.

CI's `TypeScript (lint · types · test · docs)` job on `dev` (run 41729957804, 2026-11-03) printed
78 `react-hooks/*` warnings in the `console:lint` group. The issue's 79 counted log lines that name
a rule, and one of those lines is a code frame quoting an `eslint-disable` comment.

| Rule | Count |
|---|---|
| `set-state-in-effect` | 33 |
| `incompatible-library` | 20 |
| `refs` | 16 |
| `exhaustive-deps` | 5 |
| `purity` | 4 |

This list is the CI log, not a local run. The lane's local-resources rule forbids local lint, so
every slice confirms its result in the same CI group.

## Files another unit owns

#6147 (drop `motion`) owns `components/agent/agent-chat.tsx`,
`components/agent/elench/elench-panel.tsx`, `components/ai-elements/shimmer.tsx`, `app/globals.css`
and `components/design-project/canvas/**`. Four of the findings are in those paths:

- `agent-chat.tsx`: one `set-state-in-effect`.
- `canvas/design-project-canvas.tsx`: two `set-state-in-effect`.
- `canvas/inspector/chart-workload-panel.tsx`: one `set-state-in-effect`.
- `canvas/inspector/config-fields.tsx`: one `incompatible-library`.

They are left as they are. The gate excludes exactly those four files, in a block that names #6147
and carries a TODO to remove the exclusion once #6147 lands.

## How each kind is fixed

The fixes change code. None of them suppresses a finding or moves the work into a timer or a
microtask to get past the rule.

- **Mount detection** (`setMounted(true)` in an effect) uses `useHydrated` from
  `@repo/ui/use-hydrated`.
- **State reset when an input changes** (a page number, a "Show more" window, a stream's lines, a
  price row) becomes state *keyed by the input it belongs to*: `{ key, value }`, with the value read
  only while the key matches. The render that shows the new input already shows the reset value.
  Before, the old value showed for one commit.
- **State seeded from a prop or URL once** (a dialog's base env on opening, the remembered email,
  a deep link's sheet) uses React's guarded "adjust state while rendering" form, or a `useState`
  initializer when the value is known at mount.
- **State cleared before a request** (`setClientSecret(null)` in the effect that re-creates a
  Stripe intent) moves to the event handler that changed the request: the currency toggle, the
  tier choice, the declaration.
- **Refs read or written during render** become state (the add-on card's frozen row). A "latest
  callback" ref becomes `useEffectEvent`.
- **`Date.now()` in render** becomes either a `useSyncExternalStore` clock whose server snapshot
  is `null`, which also keeps hydration exact, or a TanStack `initialDataUpdatedAt` function.
- **react-hook-form `watch()`** becomes `useWatch`. TanStack Table's `useReactTable` has no form
  the compiler can memoise. The plugin also compiles a function before it honours `"use no memo"`,
  so that directive does not silence the rule. Those three sites carry a one-line
  `eslint-disable-next-line react-hooks/incompatible-library` that states why. They are the only
  suppressions.
- **`exhaustive-deps`**: a fallback `[]` built outside a memo moves inside it, or is memoised
  itself. An effect keyed on `sharedCtx?.x` members reads the context directly.

Each slice adds or extends a test for every change that has behaviour, and the test asserts that
behaviour, not the absence of the warning.

A component that loses its last `watch()`, or its last effect-borne `setState`, is compiled by the
plugin for the first time. That can surface errors that were hidden behind the bail-out, such as
`react-hooks/immutability` for a function used before it is declared. Each slice re-reads the CI
lint log for new findings after its conversions.

## Slices

Each slice is its own PR into `dev` (`Part of #6459`) and is green on its own. While the rules are
still `warn`, a slice can only lower the count. The gate goes in last.

| Slice | Area | PR |
|---|---|---|
| A | agent, elench, ai-elements, widgets | the agent-area PR |
| B | `incompatible-library`: react-hook-form `watch()` → `useWatch`; `useReactTable` | #6468 |
| C | lists, auth, billing, connectors, environments, plan, repository selector, runners, job logs, clock | this PR |
| D | **the gate**: `eslint.config.mjs` | last, `Closes #6459` |

## The gate (slice D)

In `apps/console/eslint.config.mjs`:

1. Delete the block that sets `purity`, `set-state-in-effect`, `refs`, `incompatible-library` and
   `preserve-manual-memoization` to `warn`. The preset's own severities (`error`) then apply.
2. Set `react-hooks/exhaustive-deps` to `error`.
3. Add one block for exactly the four #6147 files listed above. It sets the rules they trip back to
   `warn`, names #6147, and has a TODO to delete itself when #6147 lands.

These are errors and not a `--max-warnings 0` because the console's lint also carries 108
`vitest/no-conditional-expect` warnings that are advisory by decision. A global warning cap would
gate on those as well.
