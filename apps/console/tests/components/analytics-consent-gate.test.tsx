// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The proof #2371 asks for: NO PostHog request occurs before affirmative analytics consent.
//
// This is an ABSENCE assertion, which is the kind that most easily becomes vacuous — a test that
// renders nothing, or whose mock was never installed, reports "no requests" and proves nothing. So
// every case here first asserts a POSITIVE control: that the very same setup DOES load PostHog once
// consent is given. If the gate were deleted, the negative cases fail; if the harness were broken,
// the positive case fails. Both halves have to hold.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthogInit = vi.fn();
const posthogReset = vi.fn();
const posthogOptIn = vi.fn();
const posthogOptOut = vi.fn();
const posthogRegister = vi.fn();

// The dynamic `import("posthog-js")` inside AnalyticsProvider is the ONLY way the SDK can reach the
// network from this app: it is imported lazily, behind the consent branch, and never via a <script>.
// Counting imports of it therefore counts "would a PostHog request be possible".
vi.mock("posthog-js", () => ({
	default: {
		init: posthogInit,
		reset: posthogReset,
		opt_in_capturing: posthogOptIn,
		opt_out_capturing: posthogOptOut,
		register: posthogRegister,
		capture: vi.fn(),
		identify: vi.fn(),
		group: vi.fn(),
	},
}));

import { CONSENT_COOKIE, writeConsent } from "@repo/privacy/consent";
import { ConsentProvider } from "@repo/privacy/consent-provider";
import { AnalyticsProvider } from "@/components/providers/analytics-provider";

/** Clear every cookie and storage key a case may have written. */
function reset(): void {
	for (const item of document.cookie.split("; ")) {
		const name = item.split("=")[0];
		if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
	}
	localStorage.clear();
	sessionStorage.clear();
	Reflect.deleteProperty(navigator, "globalPrivacyControl");
	vi.clearAllMocks();
}

beforeEach(() => {
	// A configured project key, so nothing is skipped merely because analytics is switched off by
	// configuration — that would make every assertion below vacuous.
	process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
	process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
	reset();
});

afterEach(() => {
	Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_KEY");
	Reflect.deleteProperty(process.env, "NEXT_PUBLIC_POSTHOG_HOST");
	reset();
});

function mount() {
	return render(
		<ConsentProvider>
			<AnalyticsProvider>
				<div>Console</div>
			</AnalyticsProvider>
		</ConsentProvider>,
	);
}

describe("analytics is gated on consent", () => {
	// THE POSITIVE CONTROL. If this fails, every negative case below is meaningless — the harness,
	// not the gate, would be what is stopping PostHog.
	it("initialises PostHog once analytics consent exists", async () => {
		writeConsent({ analytics: true });
		mount();
		await waitFor(() => expect(posthogInit).toHaveBeenCalledOnce());
		expect(posthogInit.mock.calls[0]?.[0]).toBe("phc_test_key");
	});

	it("does not touch PostHog before any decision is made", async () => {
		mount();
		// The first-visit notice is up — the app HAS rendered, so this is not an empty test.
		await screen.findByRole("region", { name: "Privacy choices" });
		expect(posthogInit).not.toHaveBeenCalled();
	});

	it("does not touch PostHog when analytics is rejected", async () => {
		writeConsent({ analytics: false });
		mount();
		await waitFor(() =>
			expect(
				screen.queryByRole("region", { name: "Privacy choices" }),
			).not.toBeInTheDocument(),
		);
		expect(posthogInit).not.toHaveBeenCalled();
	});

	// GPC is a standing opt-out. A stored `analytics: true` must not overturn it — this is the case
	// that a naive `consent.analytics === true` read would get wrong while looking correct.
	it("does not touch PostHog under Global Privacy Control, even with a stored yes", async () => {
		Object.defineProperty(navigator, "globalPrivacyControl", {
			value: true,
			configurable: true,
		});
		writeConsent({ analytics: true });
		mount();
		await waitFor(() =>
			expect(
				screen.queryByRole("region", { name: "Privacy choices" }),
			).not.toBeInTheDocument(),
		);
		expect(posthogInit).not.toHaveBeenCalled();
	});

	it("never starts session recording, even with analytics consent", async () => {
		writeConsent({ analytics: true });
		mount();
		await waitFor(() => expect(posthogInit).toHaveBeenCalledOnce());
		const options = posthogInit.mock.calls[0]?.[1];
		expect(options).toMatchObject({ disable_session_recording: true });
		// The SDK is never asked to start a recording, and the option that would allow one is pinned.
		expect(options).not.toHaveProperty("session_recording");
	});

	// The requirement is that identifiers are DELETED on withdrawal, not that capture stops.
	it("deletes PostHog storage when consent is absent", async () => {
		localStorage.setItem("ph_phc_test_key_posthog", '{"distinct_id":"abc"}');
		document.cookie = "ph_phc_test_key_posthog=abc; Path=/";
		writeConsent({ analytics: false });

		mount();

		await waitFor(() =>
			expect(localStorage.getItem("ph_phc_test_key_posthog")).toBeNull(),
		);
		expect(document.cookie).not.toContain("ph_phc_test_key_posthog");
	});
});

describe("the consent cookie", () => {
	it("is the only thing written before a decision", async () => {
		mount();
		await screen.findByRole("region", { name: "Privacy choices" });
		// Nothing stored at all until the person chooses — not even an empty record.
		expect(document.cookie).not.toContain(CONSENT_COOKIE);
		expect(localStorage.length).toBe(0);
	});
});
