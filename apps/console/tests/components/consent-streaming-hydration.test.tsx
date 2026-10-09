// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A streamed Suspense boundary still waiting for its server HTML must HYDRATE when that HTML
// arrives, not be client-rendered the moment the consent cookie is read (#5786).
//
// `ConsentProvider` sits at the root of the console, above every boundary a page streams into, and
// `AnalyticsProvider` — a consent CONSUMER — wraps the whole page under it. The server cannot read the
// consent cookie the way the browser does, so the browser learns the decision after mount. When that
// answer lived in the provider's state, learning it changed the context VALUE; the consumer around
// the page re-rendered, and React propagated the change down into its subtree, where it reached the
// dehydrated boundary. React's rule for a dehydrated boundary that receives an update while its
// content is still pending (`$?`, or `$~` once queued for reveal) is to give up on hydrating it and
// render it on the client — silently, with no recoverable error. The server's streamed copy then
// arrived into a hidden `S:` div with nothing left to receive it: on the connectors page, a second,
// hidden filter bar on 19 of 20 CI loads (release-gate run 37871585504, #5784).
//
// The fiber-level CI trace behind this (release-gate run 37895619718, a React DevTools-hook probe on
// the connectors page): in the load where the probe's fiber chain reached the root, the commit that
// client-rendered the pending boundary was the one in which the consent provider's state and its
// context value changed, with the consent-reading `AnalyticsProvider` re-rendering below it.

// The harness streams a real Fizz shell with one boundary whose content never resolves (it stands
// for a segment still in flight), hydrates it in jsdom with a decision in the cookie and the document
// still "loading", flushes the mount effects, and asks whether the boundary is still the server's.
//
// Mutation check (done when this was written): restoring the `useState` consent in the provider —
// so the context value changes on mount — fails the first test with `expected [] to deeply equal
// [ '$?' ]`: React deleted the server's boundary and mounted its own. Without the consumer AROUND
// the boundary (a sibling consumer instead) the old code passes too, which is why `ConsentAware`
// wraps the page rather than sitting beside it.

import { act, Suspense, use, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSENT_COOKIE, CONSENT_VERSION } from "@repo/privacy/consent";
import { ConsentProvider, useConsent } from "@repo/privacy/consent-provider";

/** A segment that is still in flight: it suspends forever, on the server and the client alike. */
const IN_FLIGHT = new Promise<never>(() => {});

/** The streamed section: it never resolves, so its boundary stays pending for the whole test. */
function StreamedSection(): ReactNode {
	use(IN_FLIGHT);
	return <p>streamed</p>;
}

/**
 * A consent consumer that WRAPS the page, as the console's `AnalyticsProvider` does: it reads the
 * decision and renders its children inside. Being an ancestor of the boundary is what matters —
 * when it re-renders on a context change, React propagates that change into the subtree below it
 * lazily, and that walk is what reaches the dehydrated boundary.
 */
function ConsentAware({ children }: { children: ReactNode }): ReactNode {
	const { hasDecision } = useConsent();
	return <div data-decision={hasDecision ? "decided" : "undecided"}>{children}</div>;
}

/** The page shape: consent at the root, a consumer around the shell, one streamed boundary. */
function Page(): ReactNode {
	return (
		<ConsentProvider>
			<ConsentAware>
				<main>
					<Suspense fallback={<span>loading</span>}>
						<StreamedSection />
					</Suspense>
				</main>
			</ConsentAware>
		</ConsentProvider>
	);
}

/** Server-render `Page` and return the HTML flushed with the shell (the boundary still pending). */
async function streamShell(): Promise<string> {
	const stream = await renderToReadableStream(<Page />);
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let html = "";
	// The shell is flushed as soon as it is ready; the boundary's content never is, so the stream is
	// left open and only the lock released — awaiting a cancel would wait on the in-flight segment.
	while (!html.includes("<!--$?-->")) {
		const { value, done } = await reader.read();
		if (done) break;
		html += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	return html;
}

/** Every Suspense marker comment under `root`, in document order. */
function boundaryMarkers(root: Node): string[] {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
	const markers: string[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node instanceof Comment && node.data.startsWith("$")) markers.push(node.data);
	}
	return markers;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	// The document is still streaming: React only waits for a pending boundary's HTML while
	// `readyState` is "loading" — once the document is complete it gives up and client-renders it
	// (that is how a boundary the server never finished is recovered). jsdom reports "complete".
	Object.defineProperty(document, "readyState", { configurable: true, get: () => "loading" });
});

afterEach(() => {
	// Drop the instance override so the prototype's real getter answers again.
	Reflect.deleteProperty(document, "readyState");
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.cookie = `${CONSENT_COOKIE}=; Path=/; Max-Age=0`;
});

describe("a streamed boundary survives the consent decision being read on mount (#5786)", () => {
	it("stays the server's pending boundary after the provider learns a stored decision", async () => {
		const shell = await streamShell();
		// The fixture is doing its job only if the server left the boundary pending.
		expect(shell).toContain("<!--$?-->");

		// A returning visitor: the decision is in the cookie before the page hydrates.
		const record = { analytics: false, version: CONSENT_VERSION, decidedAt: "2026-10-09T00:00:00.000Z" };
		document.cookie = `${CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(record))}; Path=/`;

		container = document.createElement("div");
		container.innerHTML = shell;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
		g.IS_REACT_ACT_ENVIRONMENT = false;
		root = hydrateRoot(container as HTMLDivElement, <Page />, {
			onRecoverableError: (error) => recoverable.push(error),
		});
		await new Promise((r) => setTimeout(r, 200));
		g.IS_REACT_ACT_ENVIRONMENT = true;

		// The provider DID learn the decision after mount — so a change really happened.
		expect(container.querySelector("[data-decision]")?.getAttribute("data-decision")).toBe("decided");
		// ...and the boundary is still waiting for the server, not replaced by a client render.
		expect(boundaryMarkers(container)).toEqual(["$?"]);
		expect(recoverable).toEqual([]);
	});

	it("still hydrates the shell cleanly when there is no decision yet", async () => {
		const shell = await streamShell();
		container = document.createElement("div");
		container.innerHTML = shell;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		await act(async () => {
			root = hydrateRoot(container as HTMLDivElement, <Page />, {
				onRecoverableError: (error) => recoverable.push(error),
			});
		});
		expect(container.querySelector("[data-decision]")?.getAttribute("data-decision")).toBe("undecided");
		expect(boundaryMarkers(container)).toEqual(["$?"]);
		expect(recoverable).toEqual([]);
	});
});
