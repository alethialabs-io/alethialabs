// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Test stub for `react-phone-number-input/flags`, aliased in vitest.config.ts.
//
// The real module is a barrel of ~250 country flag components, each a full SVG with detailed path
// data. `CountrySelect` and `PhoneInput` render the ENTIRE country list into their cmdk popover
// unvirtualized (country-select.tsx:88 / phone-input.tsx:120 both `.map` over all options), so
// every popover-open in a component test mounts ~250 real SVG trees in jsdom. That render cost —
// not any genuine async slowness — is what made these files take ~28s and ~50s on a PASSING CI run
// and left individual tests within ~1.5s of the per-test timeout, flaking the required TypeScript
// job on PRs that touch no UI code (#1402).
//
// #1452 fixed the phone-input half by passing react-phone-number-input's own `countries` prop, but
// `CountrySelect` exposes no such prop — it reads COUNTRY_OPTIONS from countries.ts directly — so
// country-select.test.tsx kept mounting the full set and stayed the slowest file in the package.
// Stubbing the flags module fixes the cost at its source, for both components, without either one
// needing a test-only prop.
//
// The stub keeps the DOM CONTRACT the tests rely on — a <title> carrying the country name, which is
// exactly why `country-select.test.tsx` scopes its label lookups to `span.flex-1` to disambiguate —
// while dropping the path payload. Behaviour under test (filtering, selection, dial-code
// re-prefixing) is unaffected: no assertion reads flag geometry.

import * as React from "react";

/** Minimal stand-in for one country's flag SVG: same shape, none of the path data. */
function StubFlag({ title }: { title?: string }) {
	return (
		<svg aria-hidden="true" data-stub-flag="">
			{title ? <title>{title}</title> : null}
		</svg>
	);
}

/**
 * The real default export is an object keyed by ISO 3166-1 alpha-2 code. A Proxy answers every
 * country code with the same stub, so the stub never drifts as the country list changes. Symbol
 * keys (`Symbol.toStringTag`, esModule interop probes) fall through to the target so module
 * interop keeps working.
 */
const flags: Record<string, typeof StubFlag> = new Proxy(
	{} as Record<string, typeof StubFlag>,
	{
		get(target, key) {
			if (typeof key === "symbol" || key === "__esModule") {
				return Reflect.get(target, key);
			}
			return StubFlag;
		},
	},
);

export default flags;
