// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Do nothing with `req`. Its only job is to be CALLED from a closure that lives as long as the work a
 * route ties to `req.signal` — typically a stream's teardown — so that closure captures the request
 * and keeps it reachable until the work ends.
 *
 * Why that matters: `req.signal` is not the signal the request was built with. undici gives every
 * `Request` its own abort controller, holds it through a WeakRef, and unregisters the listener on the
 * caller's signal once that controller is collected. A route that reads `req.signal` and then lets the
 * `Request` go stops hearing its client's disconnect after the next GC, and whatever it tied to that
 * signal (a subscription, a DB poll, a model call that bills) runs on with nobody reading it (#5796,
 * #5817).
 */
export function holdRequest(_req: Request): void {}
