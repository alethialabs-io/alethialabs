// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// R8 — EVERY ENABLED CONTROL DOES SOMETHING. The measurement, without the spec around it.
//
// "Nothing is just sitting there" is a claim about the product that nothing measured until #4277.
// This module activates a route's enabled controls one at a time and asks whether ANYTHING
// observable happened within `EFFECT_WINDOW_MS`. `inert.spec.ts` owns the route loop, the budget
// and the recording; everything here is a pure-ish function of a page.
//
// ── IT NEVER PRESSES A CONFIRM ──────────────────────────────────────────────────────────────────
//
// The rule is the same one `destructive.spec.ts` carries, and it is enforced rather than promised.
// `activate()` REFUSES to click while a dialog or an alertdialog is open, and a confirm button
// exists nowhere else — so no click this module makes can ever be the second one, the one inside a
// confirmation. A MENU is deliberately not in that refusal (it holds no confirm, and R8 has to be
// able to activate the depth-1 items of a menu it opened). The only keys pressed inside any overlay
// are Escape.
//
// A control REGISTERED in `apps/console/destructive-actions.yaml` is still activated, because its
// declared confirmation IS its effect and #4266 already proves the confirmation is real. A control
// whose accessible name reads destructive and that the ledger does NOT know about is never
// activated — it is recorded FAIL `unregistered-destructive`, the live twin of the static census.
//
// ── WHAT THIS CAN AND CANNOT SEE — READ THIS BEFORE QUOTING AN R8 SCORE ──────────────────────────
//
// R8 IS A LIVE PREDICATE, SO IT SCORES ONLY WHAT THE FIXTURE RENDERS. A control behind a
// conditional the audit's empty organisation never reaches — a row action that needs a failed
// deployment, a button gated on a plan the run does not buy — is not measured, not failed, and not
// counted anywhere. It is INVISIBLE to this instrument and will stay invisible however many times
// the leg runs, because a live pass cannot enumerate a subtree that never mounted. That bound is
// stated here, in RUBRIC.md and in the route's own evidence (`enumeratedFrom`), so that "R8 passed"
// is never read as "every control in the console does something". Closing it needs a STATIC
// matcher over the handlers, which is a different instrument and a different unit.
//
// ITS ERRORS ARE BIASED TOWARD PASS, deliberately. Six of the seven effects are attributable to the
// click (a navigation, a new overlay, an aria flip on the control itself, a toast, a download, a
// request the route was quiet enough for). The seventh — a DOM mutation anywhere inside `<main>` —
// is not: an async re-render provoked by the PREVIOUS control can land inside this control's
// window. It is therefore checked LAST, after every attributable signal, and the page is
// re-navigated after any control that moved the DOM so that the contamination cannot accumulate. A
// false PASS costs a missed inert button; a false FAIL costs a lane chasing a control that works.
//
// THE NETWORK SIGNAL IS EARNED PER ROUTE, NOT ASSUMED. A Next console prefetches, revalidates and
// polls on its own. On a route that chatters, "a request happened" is true of every control and of
// no control, so `measureQuiescence()` watches the route for one window BEFORE anything is clicked
// and disables the signal when the page was not quiet. Without that, R8 passes vacuously on every
// page with a poll on it — which is the whole failure this predicate exists to catch, reproduced
// inside the instrument.

import type { Locator, Page } from "@playwright/test";

/** The window an effect must appear in. RUBRIC.md R8 states it; nothing here may soften it. */
export const EFFECT_WINDOW_MS = 1_000;

/** How often the window is sampled. An effect that fires at 40ms should not cost a full second. */
const POLL_MS = 50;

/**
 * Overlay layers, as the console's own primitives render them.
 *
 * `[data-slot$="-content"]` catches every shadcn/base-ui layer by construction; the four roles
 * catch a layer built by hand. Both halves are needed: the slot alone misses a raw `role="dialog"`,
 * and the roles alone miss a popover that names no role at all.
 */
const OVERLAY_SELECTOR = '[data-slot$="-content"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * A CONFIRMATION is open. `activate()` refuses to click while one of these is on screen.
 *
 * Deliberately narrower than `MODAL_SELECTOR`: a confirm button lives in a dialog or an
 * alertdialog, never in a menu, and R8 must still be able to activate the depth-1 items of a menu
 * it opened. Keeping menus out of the refusal is what lets the menu pass exist at all; keeping
 * dialogs in it is what makes "never presses a confirm" a property of the code.
 */
const CONFIRM_SELECTOR = '[data-slot="alert-dialog-content"], [role="alertdialog"], [role="dialog"]';

/** Anything `recover()` must close before the next control is activated. */
const MODAL_SELECTOR = `${CONFIRM_SELECTOR}, [role="menu"]`;

/**
 * Overlays, MINUS menus — the basis a menu item's effect is measured against.
 *
 * Every menu primitive in this console closes its menu when an item is activated, whatever the item
 * does, so counting the open menu would make "the menu closed and a dialog opened" arithmetic to
 * zero and report a working item as inert.
 */
export const OVERLAY_SELECTOR_WITHOUT_MENUS = '[data-slot$="-content"]:not([role="menu"]), [role="dialog"], [role="alertdialog"], [role="listbox"]';

/** A toast, either polite or assertive. */
const STATUS_SELECTOR = '[role="status"], [role="alert"]';

/**
 * The verbs that make an accessible name read as destructive.
 *
 * MIRRORED FROM `scripts/check-destructive-actions.mjs`'s `DESTRUCTIVE_VERB`, which is the ONE
 * definition of "this verb destroys something" in the repo. A second hand-kept list is exactly what
 * stops matching silently, so `audit-report.mjs --self-test` parses this array out of this file and
 * asserts it is the census's alternation, verb for verb. Add a verb THERE.
 */
export const DESTRUCTIVE_VERBS = [
	"delete",
	"remove",
	"destroy",
	"revoke",
	"cancel",
	"detach",
	"disconnect",
	"reject",
	"unshare",
	"suspend",
] as const;

/**
 * The verbs that must carry an OBJECT before a NAME reads as destructive.
 *
 * The census matches IDENTIFIERS and requires a capital after the verb (`cancelSubscription`, never
 * the bare word). A name has no such shape, and one verb in the list above is also the universal
 * escape hatch: "Cancel" is what every form and every dialog calls its way out. Treating a bare
 * "Cancel" as an unregistered destructive control would file a FAIL against every form in the
 * console — a blind counter manufacturing work — so the bare form is excluded and the form with an
 * object ("Cancel subscription", "Cancel this run") is not.
 *
 * "Delete" is NOT in here, and the difference is measured: `SettingsDangerRow`
 * (`components/settings/settings-ui.tsx`) labels every destructive button just "Delete" and puts
 * the subject in an unassociated `<div>`. A bare "Delete" is a real destructive control in this
 * console; a bare "Cancel" never is.
 */
const BARE_VERB_IS_BENIGN = ["cancel"] as const;

/**
 * The ONE control this instrument may not press, and the reason stated in full.
 *
 * Signing out revokes the run's session server-side. Every verdict recorded after it would be a
 * measurement of the sign-in page wearing the route's name — a true assertion about the wrong
 * thing, recorded 39 more times. So the shell's sign-out is enumerated, counted and recorded as
 * NOT ACTIVATED with this reason; it is never scored PASS and never scored FAIL.
 *
 * It is ONE pattern, spelled out, because an exclusion list is the thing that grows quietly until
 * the predicate measures nothing. Anything else that wants to be here needs its own sentence.
 */
const SESSION_ENDING_NAME = /^(sign|log)\s?out$/i;

/** Whether activating this control would end the run's own session. */
export function endsTheSession(name: string): boolean {
	return SESSION_ENDING_NAME.test(normalise(name));
}

/** What a control is, and where it was enumerated from. */
export interface EnumeratedControl {
	/** `button`, `link`, `menuitem` — the control's role, not its tag. */
	role: string;
	/** Accessible name, trimmed and collapsed. `(unnamed)` when the control offers none. */
	name: string;
	/** `main` · `chrome` (the shell, measured once) · `menu` (a depth-1 item of an opened menu). */
	origin: "main" | "chrome" | "menu";
	/** Where to find it again after a re-navigation: the scope selector plus its index in it. */
	scope: string;
	index: number;
	/** For a menu item: the name of the control that opens its menu. */
	opener?: string;
}

/** A control that is present and NOT enabled. Not scored by R8; counted for a later R9. */
export interface DisabledControl {
	role: string;
	name: string;
	/** `aria-disabled` or `disabled` with a `title` / `aria-describedby` saying why. */
	reason: "disabled-with-reason" | "disabled-no-reason";
}

/** A link that leaves the console. PASSes on a real `href`, and is never clicked. */
export interface ExternalLink {
	name: string;
	href: string;
}

/** Everything one enumeration pass found. */
export interface Enumeration {
	controls: EnumeratedControl[];
	disabled: DisabledControl[];
	external: ExternalLink[];
	/** False when the page rendered no `<main>` at all — a claim about the RUN, not the page. */
	hasMain: boolean;
}

/** What activating one control produced, or `null` when the window closed with nothing. */
export type Effect =
	| "navigation"
	| "overlay"
	| "aria-state"
	| "toast"
	| "download"
	| "dom-mutation"
	| "network"
	| null;

/** One control's outcome. `effect: null` with no `excluded` is the FAIL R8 exists to find. */
export interface Observation {
	control: EnumeratedControl;
	effect: Effect;
	/** Set when the control was deliberately not activated, or could not be. */
	excluded?: "unregistered-destructive" | "opens-file-chooser" | "control-list-moved" | "session-ending";
	/** True when the page must be reloaded before the next control is activated. */
	dirtied: boolean;
}

/** Collapse whitespace so a two-line button label is one name. */
function normalise(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** What R8 treats as an activatable control, before any enabled/visible filtering. */
const CONTROL_PARTS = ["button", "a[href]", '[role="menuitem"]', '[role="button"]'] as const;

/**
 * The control selector for one scope, built ONCE and DISTRIBUTED over the scope's parts.
 *
 * Two reasons this is a function rather than a template literal at each call site:
 *
 *  1. `enumerateControls()` and `resolve()` must ask the same question, or an index means two
 *     different things on the two sides of a re-navigation — the exact attribution failure
 *     `resolve()`'s name re-read exists to catch, reintroduced by a copy-pasted selector.
 *  2. A SCOPE CAN ITSELF BE A LIST, and naive interpolation silently measures the wrong thing. The
 *     chrome's scope is `header, aside`; `` `${scope} button` `` expands to `header, aside button`,
 *     which CSS reads as "every `<header>` element, or every button inside an `<aside>`" — so the
 *     header's own buttons vanish and the `<header>` element itself is enumerated as a control. The
 *     shell chrome would have been measured as one unnamed control and nothing else, and the pass
 *     would have looked like it worked.
 *
 * Exported so the property can be asserted against a real DOM rather than against the string this
 * returns. A test that pins the rendering is a test of `join(", ")`; the assertion that matters is
 * "both halves of a list scope are enumerated, and no container element is" — which is what
 * `predicate-selftest.spec.ts` asks of `enumerateControls()` on a `header`/`aside`/`main` page.
 */
export function controlSelector(scope: string): string {
	return scope
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.flatMap((part) => CONTROL_PARTS.map((control) => `${part} ${control}`))
		.join(", ");
}

/**
 * THE ONE PLACE THAT DECIDES A CONTROL IS NOT CLICKED. Returns the reason, or `null` to activate.
 *
 * Both loops in `inert.spec.ts` — the route's controls and a menu's depth-1 items — ask this, and
 * they ask it BEFORE they resolve a locator, which is what makes "the unregistered destructive
 * control is never activated" a property of the control flow rather than of two matching `if`s.
 *
 * It is one function because it was two. The rule was written out in `driveControls()` and again in
 * `driveMenus()`, and a rule with two renderers is a rule whose next fix reaches one of them: a verb
 * added to the menu loop and not to the route loop would silently start CLICKING a delete the
 * ledger does not declare, and nothing in the report would say so. `interactionControl()` drives
 * this function in both directions, so the arm cannot pass by never firing.
 *
 * `isRegistered` is injected rather than imported: the ledger reader is a subprocess that only the
 * spec can run, and the positive control has to be able to answer the question both ways.
 *
 * @param name the control's accessible name
 * @param isRegistered whether `destructive-actions.yaml` declares this control on this route
 */
export function preActivationExclusion(name: string, isRegistered: boolean): "session-ending" | "unregistered-destructive" | null {
	if (endsTheSession(name)) return "session-ending";
	// A REGISTERED destructive control IS activated: its declared confirmation is its effect, and
	// #4266 already proves that confirmation is real. `activate()` then refuses to click anything
	// while that dialog is open, so the confirm inside it is unreachable by construction.
	if (namesDestructiveAction(name) && !isRegistered) return "unregistered-destructive";
	return null;
}

/**
 * Whether an accessible name reads as destructive.
 *
 * Word-boundary anchored at the front so `undelete` and `cancellation` do not match, and the bare
 * form of an ambiguous verb is refused — see `BARE_VERB_IS_BENIGN`.
 */
export function namesDestructiveAction(name: string): boolean {
	const words = normalise(name).toLowerCase().split(/[^a-z]+/).filter(Boolean);
	const verbAt = words.findIndex((w) => (DESTRUCTIVE_VERBS as readonly string[]).includes(w));
	if (verbAt === -1) return false;
	const verb = words[verbAt];
	if (!(BARE_VERB_IS_BENIGN as readonly string[]).includes(verb)) return true;
	// An ambiguous verb needs an object after it: "Cancel subscription" yes, "Cancel" no.
	return words.length > verbAt + 1;
}

/**
 * Whether a link stays inside the console.
 *
 * Resolved against the PAGE's own origin, never a hardcoded production host — the audit runs
 * against `localhost`, so a constant base would read `https://alethialabs.io/pricing` as internal
 * and CLICK it, navigating the run off the app it is measuring.
 */
export function isSameOrigin(href: string, pageUrl: string): boolean {
	try {
		return new URL(href, pageUrl).origin === new URL(pageUrl).origin;
	} catch {
		return false;
	}
}

/** A link that goes nowhere — `href="#"`, `href=""`, a bare `javascript:` — is not a navigation. */
function isVoidHref(href: string): boolean {
	const h = href.trim();
	return h === "" || h === "#" || h.toLowerCase().startsWith("javascript:");
}

/**
 * Enumerate the enabled controls inside `scope`, plus the disabled and external ones beside them.
 *
 * `scope` is a CSS selector — `main` for the page, the shell chrome selector for the chrome, an
 * opened menu for its depth-1 items. The returned controls carry their scope and index rather than
 * a `Locator`, because the page is re-navigated between activations and a handle does not survive
 * that; `resolve()` turns one back into a locator and CHECKS the name still matches.
 */
export async function enumerateControls(page: Page, scope: string, origin: EnumeratedControl["origin"]): Promise<Enumeration> {
	const hasMain = (await page.locator("main").count()) > 0;
	const nodes = page.locator(controlSelector(scope));
	const count = await nodes.count();
	const controls: EnumeratedControl[] = [];
	const disabled: DisabledControl[] = [];
	const external: ExternalLink[] = [];
	for (let index = 0; index < count; index += 1) {
		const node = nodes.nth(index);
		const probed = await node
			.evaluate((el) => {
				const style = window.getComputedStyle(el);
				const rect = el.getBoundingClientRect();
				return {
					tag: el.tagName.toLowerCase(),
					role: el.getAttribute("role"),
					href: el.getAttribute("href"),
					ariaDisabled: el.getAttribute("aria-disabled"),
					nativeDisabled: el.hasAttribute("disabled"),
					title: el.getAttribute("title"),
					describedBy: el.getAttribute("aria-describedby"),
					ariaLabel: el.getAttribute("aria-label"),
					text: el.textContent ?? "",
					visible: style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0,
				};
			})
			.catch(() => null);
		// A node that vanished between `count()` and the read is a page still settling, not a
		// finding. It is skipped rather than recorded, and the route's `enumerated` count says so.
		if (probed === null || !probed.visible) continue;

		const role = probed.role ?? (probed.tag === "a" ? "link" : "button");
		const name = normalise(probed.text) || normalise(probed.ariaLabel ?? "") || "(unnamed)";

		if (probed.nativeDisabled || probed.ariaDisabled === "true") {
			disabled.push({
				role,
				name,
				reason: probed.title || probed.describedBy ? "disabled-with-reason" : "disabled-no-reason",
			});
			continue;
		}
		if (probed.tag === "a" && probed.href !== null) {
			// An external link PASSES on a real href and is NEVER clicked: activating it navigates
			// the run out of the console, and what it would prove — that the destination exists —
			// is not R8's question.
			if (!isSameOrigin(probed.href, page.url())) {
				if (!isVoidHref(probed.href)) external.push({ name, href: probed.href });
				continue;
			}
			// A same-origin `href="#"` is a link that goes nowhere. It stays in `controls`: that is
			// precisely the inert control R8 is looking for, and it must be activated to find out
			// whether a handler does the work the href does not.
		}
		controls.push({ role, name, origin, scope, index });
	}
	return { controls, disabled, external, hasMain };
}

/**
 * Turn an enumerated control back into a locator, refusing when the list has moved under us.
 *
 * Positional re-resolution is the only option after a re-navigation — the page renders a new DOM
 * and no handle survives it — and a position that now names a DIFFERENT control would produce a
 * verdict attributed to the wrong button. That is a true assertion about the wrong thing, which is
 * worse than no assertion, so the name is re-read and a mismatch is reported rather than clicked.
 */
export async function resolve(page: Page, control: EnumeratedControl): Promise<Locator | null> {
	const nodes = page.locator(controlSelector(control.scope));
	if ((await nodes.count()) <= control.index) return null;
	const node = nodes.nth(control.index);
	const name = await node
		.evaluate((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim() || (el.getAttribute("aria-label") ?? "").trim() || "(unnamed)")
		.catch(() => null);
	return name === control.name ? node : null;
}

/**
 * Watch the route for one effect window with NOTHING clicked, and report whether it was quiet.
 *
 * The result decides whether "a request happened" may count as this control's effect at all. A
 * console route that revalidates on an interval issues requests whatever the user does, so on one
 * of those the network signal is true of every control and therefore evidence about none. Measuring
 * it once per route costs one second and is the difference between R8 catching inert buttons and
 * R8 passing every page that polls.
 */
export async function measureQuiescence(page: Page): Promise<{ quiet: boolean; requests: string[] }> {
	const requests: string[] = [];
	const onRequest = (request: { url(): string; method(): string }) => {
		if (isChatter(request.url())) return;
		requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
	};
	page.on("request", onRequest);
	await page.waitForTimeout(EFFECT_WINDOW_MS);
	page.off("request", onRequest);
	return { quiet: requests.length === 0, requests: requests.slice(0, 5) };
}

/** Static assets and the browser's own housekeeping are not a control's effect. */
function isChatter(url: string): boolean {
	return /\/_next\/(static|image)\//.test(url) || /\/favicon\.|\.(png|jpe?g|svg|webp|woff2?|css|map)(\?|$)/.test(url);
}

/** Options `activate()` needs from the route loop. */
export interface ActivateOptions {
	/** False on a route `measureQuiescence()` found chattering — the network signal is withheld. */
	networkUsable: boolean;
	/** What counts as "a new overlay". Menu items pass `OVERLAY_SELECTOR_WITHOUT_MENUS`. */
	overlaySelector?: string;
}

/**
 * Activate ONE control and report the first effect observed inside the window.
 *
 * REFUSES TO CLICK THROUGH AN OPEN OVERLAY. Every click this module makes is made from a clean page
 * state, which is what makes "never presses a confirm" a property of the code rather than a rule to
 * remember: a confirm button only exists inside a dialog, and this function will not click while
 * one is open.
 *
 * The effects are checked in ATTRIBUTABILITY ORDER, not in the rubric's listing order. A navigation,
 * a new overlay, an aria flip on the control itself, a toast and a download are all consequences of
 * this click. A DOM mutation anywhere in `<main>` and a network request are not necessarily, so
 * they are checked last — see this file's header.
 */
export async function activate(page: Page, locator: Locator, options: ActivateOptions): Promise<{ effect: Effect; fileChooser: boolean; dirtied: boolean }> {
	if ((await page.locator(CONFIRM_SELECTOR).count()) > 0) {
		throw new Error(
			"R8 refuses to activate a control while a dialog is open. Every click this instrument " +
				"makes is made from a clean page state — that is what makes 'it never presses a confirm' " +
				"structural rather than a promise. Recover the page before calling activate().",
		);
	}

	const beforeUrl = page.url();
	const ariaBefore = await locator.evaluate((el) => ({
		expanded: el.getAttribute("aria-expanded"),
		pressed: el.getAttribute("aria-pressed"),
		selected: el.getAttribute("aria-selected"),
		checked: el.getAttribute("aria-checked"),
	}));

	await page.evaluate(
		({ overlaySel, statusSel }) => {
			const root = document.querySelector("main") ?? document.body;
			window.__alethiaR8?.observer?.disconnect();
			// The probe object is installed FIRST and the observer closes over `window.__alethiaR8`
			// itself. Building it locally and spreading the result into `window` is the shape that
			// reads correct and measures nothing: the observer would then mutate a copy the page
			// never publishes, `mutated` would be false forever, and every control with no other
			// signal would report inert.
			window.__alethiaR8 = {
				mutated: false,
				overlays: document.querySelectorAll(overlaySel).length,
				statuses: document.querySelectorAll(statusSel).length,
			};
			const observer = new MutationObserver(() => {
				const probe = window.__alethiaR8;
				if (probe !== undefined) probe.mutated = true;
			});
			observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
			window.__alethiaR8.observer = observer;
		},
		{ overlaySel: options.overlaySelector ?? OVERLAY_SELECTOR, statusSel: STATUS_SELECTOR },
	);

	const requests: string[] = [];
	const onRequest = (request: { url(): string; method(): string }) => {
		if (!isChatter(request.url())) requests.push(request.url());
	};
	let fileChooser = false;
	const onFileChooser = () => {
		fileChooser = true;
	};
	let downloaded = false;
	const onDownload = () => {
		downloaded = true;
	};
	page.on("request", onRequest);
	page.once("filechooser", onFileChooser);
	page.once("download", onDownload);

	try {
		// `force` because R8's question is "does this control do anything", not "is it hit-testable"
		// — R4 already measures overlap and R2 measures stacking, and letting a covered control time
		// out here would report it as inert for a reason that is another predicate's finding.
		await locator.click({ timeout: EFFECT_WINDOW_MS, force: true, noWaitAfter: true }).catch(() => {});

		const deadline = Date.now() + EFFECT_WINDOW_MS;
		let effect: Effect = null;
		let mutated = false;
		for (;;) {
			if (page.url() !== beforeUrl) {
				effect = "navigation";
				break;
			}
			if (downloaded) {
				effect = "download";
				break;
			}
			const now = await page
				.evaluate(
					({ overlaySel, statusSel }) => ({
						mutated: window.__alethiaR8?.mutated === true,
						overlays: document.querySelectorAll(overlaySel).length,
						statuses: document.querySelectorAll(statusSel).length,
						before: { overlays: window.__alethiaR8?.overlays ?? 0, statuses: window.__alethiaR8?.statuses ?? 0 },
					}),
					{ overlaySel: options.overlaySelector ?? OVERLAY_SELECTOR, statusSel: STATUS_SELECTOR },
				)
				// A navigation mid-evaluate destroys the execution context; the url check above
				// catches it on the next turn of the loop.
				.catch(() => null);
			if (now !== null) {
				mutated = mutated || now.mutated;
				if (now.overlays > now.before.overlays) {
					effect = "overlay";
					break;
				}
				if (now.statuses > now.before.statuses) {
					effect = "toast";
					break;
				}
			}
			const ariaNow = await locator
				.evaluate((el) => ({
					expanded: el.getAttribute("aria-expanded"),
					pressed: el.getAttribute("aria-pressed"),
					selected: el.getAttribute("aria-selected"),
					checked: el.getAttribute("aria-checked"),
				}))
				.catch(() => null);
			if (ariaNow !== null && JSON.stringify(ariaNow) !== JSON.stringify(ariaBefore)) {
				effect = "aria-state";
				break;
			}
			if (fileChooser) break;
			if (Date.now() >= deadline) break;
			await page.waitForTimeout(POLL_MS);
		}

		// The two unattributable signals, in the order the header argues for. `mutated` is read one
		// last time because the loop may have exited on the deadline between polls.
		if (effect === null && !fileChooser) {
			mutated = mutated || (await page.evaluate(() => window.__alethiaR8?.mutated === true).catch(() => false));
			if (mutated) effect = "dom-mutation";
			else if (options.networkUsable && requests.length > 0) effect = "network";
		}
		return {
			effect,
			fileChooser,
			// Anything that moved the page means the next control must start from a fresh load: a
			// stale async mutation is the one signal this instrument cannot attribute, so it is not
			// allowed to accumulate across controls.
			dirtied: effect !== null || fileChooser,
		};
	} finally {
		page.off("request", onRequest);
		page.off("filechooser", onFileChooser);
		page.off("download", onDownload);
		await page.evaluate(() => window.__alethiaR8?.observer?.disconnect()).catch(() => {});
	}
}

/**
 * Close whatever the last activation opened. Escape twice, then report whether anything is left.
 *
 * Escape is the ONLY key pressed inside an overlay, and no button inside one is ever clicked — see
 * the header. Twice, because a menu inside a dialog takes two.
 */
export async function recover(page: Page): Promise<boolean> {
	for (let i = 0; i < 2; i += 1) {
		if ((await page.locator(MODAL_SELECTOR).count()) === 0) return true;
		await page.keyboard.press("Escape").catch(() => {});
		await page.waitForTimeout(150);
	}
	return (await page.locator(MODAL_SELECTOR).count()) === 0;
}

/** One R8 cell as `report.write()` leaves it in the merged artifact. */
export interface ScoredRecord {
	route: string;
	verdict: string;
	reason?: string;
}

/**
 * THE EMPTINESS GUARD, as a function of the numbers rather than of a Playwright runner.
 *
 * Returns the reasons this run may NOT be read as a clean R8 board; empty means it may. Three
 * questions, and each one has already been the way a board went quietly green somewhere in this
 * repo:
 *
 *  1. WAS THE INSTRUMENT ITSELF BELIEVED? A withheld predicate rewrites every verdict to NOT
 *     MEASURED, so a run whose positive control was red produces a file of nothing but withheld
 *     cells — and a check that only counts records sees a full array and reads it as a pass. An
 *     emptiness check cannot see a WITHHELD measurement unless it is told to look for one.
 *  2. DOES THE FILE DESCRIBE EVERY ROUTE? A route recorded nowhere is not a NOT MEASURED; it is a
 *     route the report does not mention, and the denominator shrinks to fit the answer.
 *  3. DID ANYTHING GET DRIVEN AT ALL? `MIN_MEASURED` is the floor under "a run whose fixtures all
 *     stopped seeding records NOT MEASURED everywhere and reports forty green tests".
 *
 * It is a pure function so that all three can be driven from a plain node harness — the floor that
 * only its own suite can exercise is the floor nobody has ever seen fail.
 *
 * @param records every R8 cell in the merged artifact
 * @param withheld the run-scoped withhold reason for R8, or `undefined` when the control was green
 * @param routeCount how many routes the manifest names
 * @param minMeasured the floor under PASS + FAIL
 */
export function emptinessProblems(records: ScoredRecord[], withheld: string | undefined, routeCount: number, minMeasured: number): string[] {
	const measured = records.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL").length;
	const notMeasured = records.filter((r) => r.verdict === "NOT MEASURED").length;
	const na = records.filter((r) => r.verdict === "N/A").length;
	const problems: string[] = [];
	if (withheld !== undefined) {
		problems.push(`R8's positive control was red, so every verdict in this run is NOT MEASURED: ${withheld}`);
	}
	if (measured + notMeasured + na !== routeCount) {
		problems.push(
			`R8 recorded ${measured + notMeasured + na} of ${routeCount} routes — a route that is neither measured, ` +
				`not-measured nor N/A went unrecorded, and a report describing fewer routes than the manifest names ` +
				`shrinks its denominator to fit its answer.`,
		);
	}
	if (measured < minMeasured) {
		problems.push(
			`only ${measured} of ${routeCount} routes produced a PASS or a FAIL (floor ${minMeasured}). A run whose ` +
				`fixtures all stopped seeding records NOT MEASURED everywhere and reports green.`,
		);
	}
	return problems;
}

/**
 * THE POSITIVE CONTROL. Drive the instrument against a page whose right answers are known.
 *
 * Returns the list of things it got WRONG — empty means the instrument works. `inert.spec.ts` runs
 * this BEFORE it scores a single route and `report.withhold()`s R8 over anything it returns, so a
 * broken measurement publishes NOT MEASURED rather than a column of FAILs. #3804 is why: R3's own
 * control was red on `dev` while the same job published R3 FAILs for two real routes.
 *
 * `predicate-selftest.spec.ts` drives the same function in both directions — clean, and with each
 * arm neutered — because a control nothing has ever seen fail is not known to be a control.
 *
 * @param page a page this function may navigate and overwrite
 * @param fixture optional replacement markup, so the self-test can break one arm at a time
 */
export async function interactionControl(page: Page, fixture: string = CONTROL_FIXTURE): Promise<string[]> {
	const problems: string[] = [];
	await page.setContent(fixture);

	const enumerated = await enumerateControls(page, "main", "main");
	const names = enumerated.controls.map((c) => c.name);
	if (!names.includes("Nothing happens")) problems.push("R8: the enumeration did not find the handler-less button — an inert control it cannot see is an inert control it will never report.");
	if (!names.includes("Open the dialog")) problems.push("R8: the enumeration did not find the dialog opener.");
	if (names.includes("Unavailable")) problems.push("R8: an `aria-disabled` control was enumerated as enabled — R8 must not score a control a person cannot press.");
	if (enumerated.disabled.some((d) => d.name === "Unavailable" && d.reason === "disabled-with-reason") === false) {
		problems.push("R8: a disabled control carrying a `title` was not counted as `disabled-with-reason`.");
	}
	if (enumerated.external.some((e) => e.name === "Docs") === false) {
		problems.push("R8: a cross-origin link was not recorded as external — it must PASS on its href and never be clicked.");
	}
	if (!namesDestructiveAction("Delete workspace")) problems.push("R8: the destructive-name matcher does not read `Delete workspace` as destructive.");
	if (namesDestructiveAction("Cancel")) problems.push("R8: a bare `Cancel` reads as destructive — that files a finding against every form in the console.");
	if (!namesDestructiveAction("Cancel subscription")) problems.push("R8: `Cancel subscription` does not read as destructive, so a real one would be activated.");

	// THE TAG ARM, DRIVEN BOTH WAYS. Reading the verb is half of the rule; the other half is the
	// ledger join, and a join that answers the same way for a declared and an undeclared control is
	// the failure that matters in each direction. Answer "not registered" for everything and the
	// run files a FAIL against all 40 of the ledger's own confirmed buttons — a blind counter
	// manufacturing work. Answer "registered" for everything and a delete nobody declared is
	// CLICKED, which is the one thing R8 promises never to do.
	if (preActivationExclusion("Delete workspace", false) !== "unregistered-destructive") {
		problems.push("R8: an UNDECLARED control named `Delete workspace` was not tagged `unregistered-destructive` — the live twin of the census does not fire, and R8 would click a delete nobody declared.");
	}
	if (preActivationExclusion("Delete workspace", true) !== null) {
		problems.push("R8: a control the ledger DOES declare was refused activation — its confirmation is its effect, and withholding it files a finding against every registered destructive control in the console.");
	}
	if (preActivationExclusion("Open project", false) !== null) {
		problems.push("R8: a benign control was excluded before activation — an exclusion that fires on an ordinary button measures nothing.");
	}
	if (preActivationExclusion("Sign out", true) !== "session-ending") {
		problems.push("R8: sign-out was not excluded — activating it revokes the run's session and every later verdict measures the sign-in page wearing the route's name.");
	}

	// EACH ARM STARTS FROM A FRESH PAGE. The fixture's dialog is plain markup and does not close on
	// Escape, so running the opener first would leave an overlay open and `activate()` — which
	// refuses to click through one, by design — would throw on the arm after it. The control would
	// then report the instrument broken for a reason that belongs entirely to the control's own
	// fixture, which is the cheapest way to make a positive control stop being consulted.
	const opener = enumerated.controls.find((c) => c.name === "Open the dialog");
	const inert = enumerated.controls.find((c) => c.name === "Nothing happens");
	if (inert !== undefined) {
		await page.setContent(fixture);
		const locator = await resolve(page, inert);
		const observed = locator === null ? null : (await activate(page, locator, { networkUsable: false })).effect;
		if (observed !== null) {
			problems.push(`R8: the handler-less button reported ${JSON.stringify(observed)} rather than nothing — the FAIL arm does not fire, and every inert control in the console would pass.`);
		}
	}
	if (opener !== undefined) {
		await page.setContent(fixture);
		const locator = await resolve(page, opener);
		const observed = locator === null ? null : (await activate(page, locator, { networkUsable: false })).effect;
		if (observed !== "overlay") problems.push(`R8: the dialog opener reported ${JSON.stringify(observed)} rather than an overlay — the PASS arm does not fire.`);
	}
	return problems;
}

/**
 * The control's page. A real doctype, because `setContent` without one is QUIRKS mode and this
 * repo has already paid for a fixture that measured something the console never renders (#3804).
 */
export const CONTROL_FIXTURE = `<!doctype html><html lang="en"><head><title>R8 control</title></head><body><main>
	<button id="inert">Nothing happens</button>
	<button id="opener">Open the dialog</button>
	<button aria-disabled="true" title="You do not have permission">Unavailable</button>
	<a href="https://example.invalid/docs">Docs</a>
	<div id="layer"></div>
</main><script>
	document.getElementById("opener").addEventListener("click", function () {
		var d = document.createElement("div");
		d.setAttribute("role", "dialog");
		d.textContent = "opened";
		document.getElementById("layer").appendChild(d);
	});
</script></body></html>`;

declare global {
	interface Window {
		__alethiaR8?: { mutated: boolean; overlays: number; statuses: number; observer?: MutationObserver };
	}
}
