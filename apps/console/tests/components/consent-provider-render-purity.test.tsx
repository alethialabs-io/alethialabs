// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `@repo/privacy`'s provider and `useOptionalConsent` were rewritten for eslint-plugin-react-hooks 7
// (#6146): the notice's "ready" flag moved from a `setState` inside the mount effect into the
// consent store, and the missing-provider warning moved from the render body into an effect. These
// pin the behaviour that rewrite had to keep.
//
// What each one is there to catch: starting the store with `ready: true` renders the notice on the
// server and in a returning visitor's first client commit (the first two tests); dropping the
// `warnedNoProvider` guard warns once per consumer (2, not 1); warning from the render body again
// warns during the server render.

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_COOKIE, writeConsent } from "@repo/privacy/consent";
import { ConsentProvider, useOptionalConsent } from "@repo/privacy/consent-provider";

/** Renders whether consent is reachable, through the optional hook. */
function OptionalConsentProbe() {
	const consent = useOptionalConsent();
	return <span>{consent === null ? "no provider" : "provider"}</span>;
}

describe("ConsentProvider render purity (#6146)", () => {
	beforeEach(() => {
		document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0`;
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not server-render the first-visit notice, because the decision is not known yet", () => {
		const html = renderToString(
			<ConsentProvider>
				<div>Product</div>
			</ConsentProvider>,
		);
		expect(html).toContain("Product");
		expect(html).not.toContain("Privacy choices");
	});

	it("never mounts the notice, even for one commit, for a visitor who already decided", () => {
		writeConsent({ analytics: false });
		// Every node React ever inserts, including one it removed again before the test looks.
		const added: Node[] = [];
		const collect = (records: MutationRecord[]) => {
			for (const record of records) added.push(...Array.from(record.addedNodes));
		};
		const observer = new MutationObserver(collect);
		observer.observe(document.body, { childList: true, subtree: true });

		render(
			<ConsentProvider>
				<div>Product</div>
			</ConsentProvider>,
		);
		// Records still queued for the observer's microtask would be dropped by disconnect().
		collect(observer.takeRecords());
		observer.disconnect();

		const notice = '[aria-label="Privacy choices"]';
		const insertedNotice = added.some(
			(node) => node instanceof Element && (node.matches(notice) || node.querySelector(notice)),
		);
		expect(screen.getByText("Product")).toBeInTheDocument();
		expect(added.length).toBeGreaterThan(0);
		expect(insertedNotice).toBe(false);
	});

	it("shows the notice after mount to a visitor with no decision", async () => {
		render(
			<ConsentProvider>
				<div>Product</div>
			</ConsentProvider>,
		);
		expect(await screen.findByRole("region", { name: "Privacy choices" })).toBeInTheDocument();
	});

	it("warns once, in the browser, when no provider is mounted — not on the server, not per consumer", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		renderToString(<OptionalConsentProbe />);
		expect(warn).not.toHaveBeenCalled();

		const { rerender } = render(
			<>
				<OptionalConsentProbe />
				<OptionalConsentProbe />
			</>,
		);
		rerender(
			<>
				<OptionalConsentProbe />
				<OptionalConsentProbe />
			</>,
		);

		expect(screen.getAllByText("no provider")).toHaveLength(2);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("no ConsentProvider above this component");
	});
});
