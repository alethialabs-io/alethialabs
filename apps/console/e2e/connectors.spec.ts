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
// full-page load streams the board into a Suspense boundary, and a streamed segment waits in a
// `<div hidden id="S:n">` until React's segment script moves it into place. `getByLabel` and
// `getByPlaceholder` match nodes inside that hidden div; role queries leave `hidden` subtrees out,
// which is also what a person and a screen reader get: one search box.
//
// That window used to be much wider. Until #5786 React threw the server's copy away and rendered
// the board again on the client, so the hidden copy sat beside a live one: two search boxes on 19 of
// 20 CI loads (release-gate run 37871585504). The cause was the consent decision changing a root
// context value after mount; the test "the board the server streamed is the board that hydrates"
// below holds that fixed. The role queries stay, because the brief segment window is real either way.

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import { installHydrationProbe, readHydrationProbe } from "./helpers/hydration-probe";

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

	// #5786: the streamed board must HYDRATE — the search box the server sent is the one left on the
	// page — and at no point may two exist. A client render of the boundary replaces the server's node
	// with a new one, so node identity catches it on every load, not only on the loads where the
	// duplicate happens to be observed. Three loads, because the failure was a race the old code lost
	// on almost every load but not all.
	test("the board the server streamed is the board that hydrates", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.addInitScript(() => {
			const probe = window as unknown as { __firstSearchBox?: Element; __mostSearchBoxes?: number };
			probe.__mostSearchBoxes = 0;
			new MutationObserver(() => {
				const boxes = document.querySelectorAll('input[aria-label="Search connectors"]');
				if (!probe.__firstSearchBox && boxes[0]) probe.__firstSearchBox = boxes[0];
				probe.__mostSearchBoxes = Math.max(probe.__mostSearchBoxes ?? 0, boxes.length);
			}).observe(document, { childList: true, subtree: true });
		});
		for (let load = 0; load < 3; load++) {
			await page.goto(`/${orgSlug}/~/connectors`);
			await expect(searchBox(page)).toBeVisible();
			const seen = await page.evaluate(() => {
				const probe = window as unknown as { __firstSearchBox?: Element; __mostSearchBoxes?: number };
				const live = document.querySelector('main input[aria-label="Search connectors"]');
				return {
					mostAtOnce: probe.__mostSearchBoxes,
					serverNodeIsLive: probe.__firstSearchBox !== undefined && probe.__firstSearchBox === live,
				};
			});
			expect(seen, `load ${load + 1}`).toEqual({ mostAtOnce: 1, serverNodeIsLive: true });
		}
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
});

// TEMPORARY MEASUREMENT PROBE for #5849 — removed before the PR leaves draft.
test.describe("hydration probe (#5849, temporary)", () => {
	test("records the hydration timeline of the activity and connectors boundaries", async ({
		authedPage: page,
		orgSlug,
		browser,
	}, testInfo) => {
		test.setTimeout(300_000);
		await installHydrationProbe(page);
		const routes = { activity: `/${orgSlug}/~/settings/activity`, connectors: `/${orgSlug}/~/connectors` };
		const out: Record<string, unknown[]> = {};
		/** Wait for the probe's hydration mark, tolerating a page that never reaches it. */
		const settle = async () => {
			await page
				.waitForFunction(() => {
					const p = Reflect.get(window, "__probe");
					return Array.isArray(p?.marks) && p.marks.some((m: { name: string }) => m.name === "trigger-hydrated");
				}, undefined, { timeout: 30_000 })
				.catch(() => undefined);
			await page.waitForTimeout(1500);
		};
		for (const [name, path] of Object.entries(routes)) {
			out[name] = [];
			for (let i = 0; i < 3; i++) {
				await page.goto(path);
				await settle();
				out[name].push({ kind: "plain", probe: await readHydrationProbe(page) });
			}
			for (let i = 0; i < 3; i++) {
				await page.goto(path, { waitUntil: "commit" });
				const trigger = page.locator('main button[data-slot="popover-trigger"]').first();
				await trigger.waitFor({ state: "visible", timeout: 30_000 });
				await page.waitForTimeout(300);
				await trigger.click();
				const opened = await page
					.locator('[data-slot="popover-content"], [role="dialog"], [role="listbox"]')
					.first()
					.waitFor({ state: "visible", timeout: 3_000 })
					.then(() => true, () => false);
				await settle();
				out[name].push({ kind: "click300", opened, probe: await readHydrationProbe(page) });
			}
			await browser.startTracing(page, {
				categories: [
					"devtools.timeline",
					"disabled-by-default-devtools.timeline",
					"v8.execute",
					"disabled-by-default-v8.cpu_profiler",
					"blink.user_timing",
					"loading",
					"toplevel",
				],
			});
			await page.goto(path);
			await settle();
			const trace = await browser.stopTracing();
			out[name].push({ kind: "traced", probe: await readHydrationProbe(page) });
			await testInfo.attach(`trace-${name}.json`, { body: trace, contentType: "application/json" });
		}
		const urls = await page.evaluate(() =>
			performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.includes("/_next/static/chunks/") && u.endsWith(".js")),
		);
		const sources: Record<string, string> = {};
		for (const u of new Set(urls)) sources[u] = await (await page.request.get(u)).text();
		await testInfo.attach("chunks.json", { body: JSON.stringify(sources), contentType: "application/json" });
		await testInfo.attach("probe.json", { body: JSON.stringify(out, null, 1), contentType: "application/json" });
		for (const [name, loads] of Object.entries(out)) {
			for (const load of loads) {
				const marks = Reflect.get(Reflect.get(Object(load), "probe") ?? {}, "marks");
				console.log(`#5849-PROBE ${name} ${JSON.stringify({ ...Object(load), probe: undefined, marks })}`);
			}
		}
	});
});
