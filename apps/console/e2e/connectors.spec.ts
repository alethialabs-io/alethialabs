// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board (`/{org}/~/connectors`) against a BRAND-NEW org — this project drives a
// full email-OTP signup per test, so every assertion here is about the pristine state that the
// shared-persona `qa` suite (e2e/flows/connectors*.spec.ts) can never observe: nothing connected,
// no accounts, no phantom verification, an untouched setup guide.
//
// It used to look for a Radix `<Select>` group filter (`getByRole("combobox")`). That control is
// gone: the board is on the console filter standard, whose group axis is a `FacetFilter` popover
// (`components/connectors/connectors-filter-bar.tsx`).
//
// Never `getByRole("button", { name: "Connect" })` — the catalog renders a couple of dozen buttons
// whose visible word is "Connect", so that fails strict mode. Each carries
// `aria-label="Connect <connector name>"` (#4268); ask for the one you mean, with `exact: true`.
//
// Ask for the filter bar's inputs BY ROLE, never `getByLabel`/`getByPlaceholder` (#5777). A
// full-page load streams the board into a Suspense boundary, and React often renders that boundary
// on the client before the server's segment for it has arrived. The server's copy then still lands,
// as `<div hidden id="S:n">`, and sits in the DOM until React's segment script removes it. Measured
// in CI (release-gate run 37871585504): 19 of 20 loads, for 2 ms or more — and over 50 ms in
// run 37870297134, past `load`. `getByLabel` and `getByPlaceholder` match that hidden copy, so an
// assertion that lands in the window fails strict mode with "resolved to 2 elements". Role queries
// leave out `hidden` subtrees, which is also what a person and a screen reader get: one search box.

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";

/** The board's search box: the visible, accessible one, never a hidden streamed copy. */
function searchBox(page: Page) {
	return page.getByRole("textbox", { name: "Search connectors", exact: true });
}

test.describe("Connectors page", () => {
	test("loads the board on the shared filter grammar", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(searchBox(page)).toBeVisible();
		await expect(page.getByRole("button", { name: /^Group\b/ })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "All vendors", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Clouds", exact: true })).toBeVisible();
	});

	// The #5777 race, made deterministic: put a server-shaped copy of the search box in a hidden
	// `S:` segment, exactly as React leaves one while a streamed segment waits to be removed, and the
	// locator must still resolve to the one box a person can see. `getByLabel` fails this.
	test("a hidden streamed copy of the board does not make the search box ambiguous", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(searchBox(page)).toBeVisible();
		await page.evaluate(() => {
			const segment = document.createElement("div");
			segment.hidden = true;
			segment.id = "S:5777";
			const copy = document.createElement("input");
			copy.setAttribute("aria-label", "Search connectors");
			copy.placeholder = "Filter connectors…";
			segment.appendChild(copy);
			document.body.appendChild(segment);
		});
		await expect(searchBox(page)).toBeVisible();
		await searchBox(page).fill("Datadog");
		await expect(page.getByRole("button", { name: "Connect Datadog", exact: true })).toBeVisible();
	});

	test("search filters the board by name", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await searchBox(page).fill("Datadog");
		await expect(page.getByRole("button", { name: "Connect Datadog", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Source", exact: true })).toHaveCount(0);
	});

	test("the Group facet narrows the board to one section", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await page.getByRole("button", { name: /^Group\b/ }).click();
		await page.getByRole("option", { name: /^Clouds/ }).click();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("heading", { name: "Clouds", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Registries", exact: true })).toHaveCount(0);
	});

	test("toggles between card and table view", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await page.getByRole("button", { name: "Table view" }).click();
		await expect(page.getByRole("table").first()).toBeVisible();
		await page.getByRole("button", { name: "Card view" }).click();
		await expect(page.getByRole("table")).toHaveCount(0);
	});

	// Regression: a fresh org has never attempted any cloud connection. Viewing the page eagerly
	// creates pending placeholder identities; neither those nor the background sweep may ever
	// surface a phantom "Verification failed → Re-verify" for a connection the user never made.
	test("a fresh org shows no phantom 'Verification failed' / 'Re-verify'", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(searchBox(page)).toBeVisible();
		await expect(page.getByText(/verification failed/i)).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^Re-verify/ })).toHaveCount(0);
	});

	// Regression: visiting the connectors page pre-creates pending placeholder cloud identities.
	// Those must NOT count as a connected cloud, so the setup guide's "Connect a cloud" stays
	// unticked (the header still reads "0 of N done") until a cloud is actually verified.
	test("visiting connectors does not falsely complete 'Connect a cloud'", async ({
		authedPage: page,
		orgSlug,
	}) => {
		// Trigger the eager placeholder creation.
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(searchBox(page)).toBeVisible();

		// Back on the overview, open the setup guide from the topbar.
		await page.goto(`/${orgSlug}`);
		await page.getByRole("button", { name: /setup guide/i }).click();
		await expect(page.getByText(/connect a cloud/i)).toBeVisible();
		// Nothing is done on a brand-new org (pre-fix, the phantom cloud made this "1 of …").
		await expect(page.getByText(/\b0 of \d+ done/i)).toBeVisible();
	});
	test("DIAG 5786", async ({ authedPage: page, orgSlug }) => {
		test.setTimeout(600_000);
		await page.addInitScript(() => {
			const t0 = performance.now();
			const log: string[] = [];
			const w = window as unknown as Record<string, unknown>;
			w.__d5786 = log;
			const at = () => Math.round(performance.now() - t0);
			const SEL = 'input[aria-label="Search connectors"]';
			const origFetch = window.fetch;
			window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
				const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
				const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				const tag = `${h.get("next-action") ? "action=" + h.get("next-action")?.slice(0, 10) : h.get("rsc") ? "rsc" + (h.get("next-router-prefetch") ? "-prefetch" : "") : "fetch"} ${url.replace(location.origin, "").slice(0, 60)}`;
				log.push(`${at()} fetch> ${tag}`);
				const p = origFetch.call(window, input, init);
				p.then(
					(r) => log.push(`${at()} fetch< ${tag} ${r.status} reval=${r.headers.get("x-action-revalidated") ?? "-"}`),
					() => log.push(`${at()} fetch! ${tag}`),
				);
				return p;
			};
			type F = {
				tag: number;
				type: unknown;
				elementType: unknown;
				memoizedProps: Record<string, unknown> | null;
				memoizedState: { dehydrated?: Node | null; memoizedState?: unknown } | null;
				alternate: F | null;
				return: F | null;
				child: F | null;
				sibling: F | null;
				flags: number;
			};
			const nameOf = (f: F): string => {
				const t = f.type as { displayName?: string; name?: string; _context?: unknown } | string | null;
				if (typeof t === "string") {
					const cls = typeof f.memoizedProps?.className === "string" ? String(f.memoizedProps.className).slice(0, 28) : "";
					return `<${t}${cls ? "." + cls.replace(/\s+/g, ".") : ""}>`;
				}
				if (t && typeof t === "object" && "_context" in t) return "Consumer";
				if (f.tag === 10) return "Provider";
				if (t && (typeof t === "function" || typeof t === "object")) return (t as { displayName?: string; name?: string }).displayName || (t as { name?: string }).name || "anon";
				return "-";
			};
			const describe = (f: F): string => {
				const a = f.alternate;
				let flags = "";
				if (a && f.memoizedProps !== a.memoizedProps) flags += "P";
				if (a && f.memoizedState !== a.memoizedState) flags += "S";
				if (f.tag === 10 && a && f.memoizedProps?.value !== a.memoizedProps?.value) flags += "V";
				if (f.flags & 1) flags += "R";
				return `${f.tag}:${nameOf(f)}${flags ? "[" + flags + "]" : ""}`;
			};
			const hook = {
				renderers: new Map<number, unknown>(),
				supportsFiber: true,
				isDisabled: false,
				inject(r: unknown) {
					const id = hook.renderers.size + 1;
					hook.renderers.set(id, r);
					return id;
				},
				checkDCE() {},
				onScheduleFiberRoot() {},
				onCommitFiberUnmount() {},
				onPostCommitFiberRoot() {},
				onCommitFiberRoot(_id: number, root: { current: F }) {
					try {
						const stack: F[] = [root.current];
						let n = 0;
						while (stack.length) {
							const f = stack.pop() as F;
							n++;
							if (f.tag === 13 && f.alternate?.memoizedState?.dehydrated && !f.memoizedState?.dehydrated) {
								const node = f.alternate.memoizedState.dehydrated;
								const chain: string[] = [];
								for (let p: F | null = f, i = 0; p && i < 60; p = p.return, i++) chain.push(describe(p));
								log.push(`${at()} BOUNDARY ${node.isConnected ? "HYDRATED" : "CLIENT-RENDERED"} inputs=${document.querySelectorAll(SEL).length} chain=${chain.join(" < ")}`);
							}
							if (f.sibling) stack.push(f.sibling);
							if (f.child) stack.push(f.child);
						}
						log.push(`${at()} commit fibers=${n}`);
					} catch (e) {
						log.push(`${at()} hookerr ${String(e)}`);
					}
				},
			};
			Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true });
			const mo = new MutationObserver((recs) => {
				for (const r of recs) {
					r.addedNodes.forEach((nd) => {
						if (!(nd instanceof Element)) return;
						if (nd.id && /^S:/.test(nd.id)) log.push(`${at()} +${nd.id} rs=${document.readyState}`);
						const inputs = nd.matches(SEL) ? [nd] : Array.from(nd.querySelectorAll(SEL));
						for (const el of inputs) {
							const inS = el.closest('[id^="S:"]');
							log.push(`${at()} +input in=${inS ? inS.id : "main"} count=${document.querySelectorAll(SEL).length}`);
						}
					});
					r.removedNodes.forEach((nd) => {
						if (nd instanceof Comment && nd.data.startsWith("$")) log.push(`${at()} -comment ${nd.data}`);
					});
					if (r.type === "characterData" && r.target instanceof Comment)
						log.push(`${at()} comment ${r.oldValue} -> ${(r.target as Comment).data}`);
				}
			});
			mo.observe(document, { childList: true, subtree: true, characterData: true, characterDataOldValue: true });
		});
		for (let i = 0; i < 12; i++) {
			await page.goto(`/${orgSlug}/~/connectors`);
			await page.waitForTimeout(2500);
			const log = await page.evaluate(() => ((window as unknown as Record<string, unknown>).__d5786 as string[]) ?? []);
			console.log(`[diag5786] iter=${i}`);
			for (const l of log) console.log(`[diag5786]   ${l}`);
		}
	});
});
