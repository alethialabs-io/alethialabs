// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single source of truth for this package's two test budgets, and the invariant that ties them
// together. They are two DIFFERENT clocks and setting them independently is what flaked the required
// TypeScript job twice:
//
//   * `asyncUtilTimeout` is per RTL wait   — how long ONE `waitFor` / `findBy*` may poll.
//   * `testTimeout`      is per whole test — how long the entire `it()` body may take.
//
// A test that chains N sequential waits therefore needs `testTimeout > N × asyncUtilTimeout`, or the
// per-wait budget is unreachable: vitest kills the test first, and the failure reads
// `Test timed out in 15000ms` instead of naming the assertion that never settled.
//
// History (#1236 → #1402): #1236 raised `asyncUtilTimeout` to 8s to de-flake the base-ui overlay
// mounts, but left `testTimeout` at 15s. The worst phone-input test chains FOUR waits (4 × 8s = 32s
// against a 15s budget), so the fix converted a fast legible failure into a slow opaque one and made
// the red MORE likely under load. Deriving `testTimeout` from the other two numbers makes that class
// of drift unrepresentable — you cannot edit one without the other following.
//
// Enforced by tests/timeouts.test.ts, which re-asserts the arithmetic and fails if any test in this
// package grows past MAX_SEQUENTIAL_WAITS.

/**
 * Per-RTL-wait budget: how long a single `waitFor` / `findBy*` may poll before failing.
 *
 * Generous on purpose — base-ui popovers portal and mount asynchronously, cmdk filters its list
 * asynchronously, and a loaded CI runner stretches both well past RTL's 1000ms default (#1236).
 */
export const ASYNC_UTIL_TIMEOUT_MS = 8_000;

/**
 * The longest chain of sequential RTL waits in any single test in this package.
 *
 * Raising this is the supported way to add a wait to a test: `TEST_TIMEOUT_MS` grows with it, so the
 * invariant holds by construction rather than by anyone remembering to bump the other number.
 */
export const MAX_SEQUENTIAL_WAITS = 4;

/**
 * Headroom for the work a test does OUTSIDE its waits — render, `userEvent` keystrokes, teardown.
 * Without it a test whose waits each finish just under budget could still be killed mid-assertion.
 */
export const SETTLE_SLACK_MS = 8_000;

/**
 * Per-test budget, DERIVED so it can never drift below what the per-wait budget implies.
 *
 * This is a ceiling, not a target: the tests here settle in milliseconds on a healthy machine. It
 * only has to be large enough that a slow wait fails with its own message rather than being cut off
 * by the per-test clock.
 */
export const TEST_TIMEOUT_MS =
  ASYNC_UTIL_TIMEOUT_MS * MAX_SEQUENTIAL_WAITS + SETTLE_SLACK_MS;
