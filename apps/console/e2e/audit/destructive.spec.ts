// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DESTRUCTIVE-ACTION SPEC — the live half of #4266.
//
// `apps/console/destructive-actions.yaml` records, for every control that destroys something, what
// stands between the click and the mutation. `scripts/check-destructive-actions.mjs` proves the
// ledger and the tree name the same set of call sites. This proves the CONFIRMATIONS are real:
// it opens each control, asserts the confirmation the entry declares, presses **Cancel**, and then
// proves nothing was destroyed — twice over, by two independent observations.
//
// ── IT NEVER PRESSES A CONFIRM ──────────────────────────────────────────────────────────────────
//
// The only button this file ever clicks inside a dialog is Cancel. `confirm_action` is read so the
// destructive button can be FOUND and asserted; it is never activated. That is not a convention to
// remember — `assertNeverPressed()` below fails the test if the located confirm button is ever the
// click target, so the rule is enforced rather than trusted.
//
// ── "NOTHING MUTATED", TWO WAYS ─────────────────────────────────────────────────────────────────
//
// Two observations, and NEITHER is complete. The first version of this comment claimed they were
// two independent proofs; run 34368830312 refuted that, and the corrected bounds are stated here
// because an assertion that is true about the wrong thing is worse than a missing one:
//
//   1. A REQUEST deny-list, ASSERTED ONLY WHERE ATTRIBUTABLE. A Next server action POSTs to the
//      current URL carrying an opaque id in `Next-Action` — the action's name is nowhere in the
//      request — so "a POST happened" does not mean "this control's mutation fired". `project.delete`
//      produced six unrelated such POSTs from the page's own work. It is therefore asserted only
//      for the bare-fetch shape (`<path> <VERB>`), where the path IS the identifier, and merely
//      RECORDED otherwise.
//   2. A DATABASE fingerprint, row counts across every public table before and after. This carries
//      the assertion in every other case. It sees an insert or a delete and CANNOT see an update in
//      place, so a mutation that flips a column — `setMemberSuspended` — would pass it.
//
// What this suite proves, stated at its real strength: the declared confirmation appears, Cancel
// closes it, and **no row was created or destroyed**. Not "nothing happened at all".
//
// ── A WITHHELD VERDICT IS NOT A PASS ────────────────────────────────────────────────────────────
//
// A control the run could not reach — its fixture is not seedable in this environment, its route
// does not materialise, the trigger is not rendered for the persona — is recorded as
// `not-measured` WITH ITS REASON, never as a silent pass. That distinction is this repo's most
// expensive recurring defect, so it is made twice: `test-results/destructive.json` carries the
// reason per control, and the LAST test in the file fails when the run did not drive the controls
// the registry says it OWES. A suite whose fixtures all quietly stopped seeding would otherwise
// report 47 green tests having asserted nothing.
//
// ⚠ THE FLOOR IS DERIVED FROM THE REGISTRY. IT WAS A CONSTANT, AND A CONSTANT COULD NOT SEE THIS.
//
// It was `MIN_MEASURED = 1` — one measured control satisfied the floor for all 47 entries, so 46
// of them could withhold and the suite still reported green. Each withheld control test passes on
// its own too, because `withhold()` records and RETURNS before any `expect` runs. So the registry
// could record `status: confirmed` for a control no instrument has ever opened, and every gate went
// green on it (#4646, from #4610/#4598/#4588 — three entries in one wave claiming a confirmation
// nothing opens).
//
// What replaces it is not a bigger number. `owedFindings()` below asks, per entry: does the
// registry claim a confirmation here, and can this spec seed what that claim needs? If both, the
// run OWES a measurement and a withheld verdict is a FAILURE NAMED BY ID. A withheld verdict on an
// entry recorded `missing` or `inert` stays green — that is honest, not a claim.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page, type Request } from "@playwright/test";

import { db, closeDb } from "../helpers/db";
import { restoreContext, materialize, resolveOrgSlug, resolveOwner, saveContext, seedRouteFixtures, type AuditContext } from "./context";
import { consoleRoutes } from "./manifest";

// ── the ledger, through the census's reader ─────────────────────────────────────────────────────

interface ControlEntry {
	id: string;
	route: string;
	surface: string;
	mutation: string;
	mutation_surface?: string;
	reach?: { menu?: string; section?: string; select?: string; open?: string }[];
	control?: { role?: string; name?: string };
	confirm?: string;
	confirm_action?: string;
	dialog_title?: string;
	fixture?: string;
	persona?: string;
	status?: string;
	issue?: string;
	"prod-qa"?: string;
	reason?: string;
}

/**
 * The registry, read by the census script in a subprocess.
 *
 * A subprocess rather than an import, following `manifest.ts`'s reading of `console-routes.mjs`: a
 * Playwright spec and a repo `.mjs` do not share a module system, and a second hand-rolled reader
 * of one list is precisely the disagreement the registry exists to prevent.
 *
 * It RAISES rather than returning `[]`. A suite that runs zero controls and a suite whose ledger
 * failed to load are the same colour otherwise.
 */
function registry(): ControlEntry[] {
	const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
	const seam = path.join(repoRoot, "scripts", "check-destructive-actions.mjs");
	let raw: string;
	try {
		raw = execFileSync(process.execPath, [seam, "--registry-json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	} catch (err) {
		throw new Error(`the destructive-action registry could not be read — this spec has no denominator and MUST NOT run over an assumed one.\n  seam: ${seam}\n  ${String(err)}`);
	}
	const parsed = JSON.parse(raw) as { controls?: ControlEntry[] };
	if (!Array.isArray(parsed.controls) || parsed.controls.length === 0) {
		throw new Error(`${seam} --registry-json produced no controls`);
	}
	return parsed.controls;
}

const CONTROLS = registry();

/**
 * The fixtures `e2e/audit/context.ts` → `seedRouteFixtures` ACTUALLY writes, named as the registry
 * names them. This is the spec's half of the floor below, and #4458 grows it one batch at a time.
 *
 * Verified against the tree, not copied from the registry's `fixture:` column:
 *  · `none` — needs no seeding at all.
 *  · `project` — `seedProject` writes the project, its default environment and the network/cluster
 *    components, and `seedRouteFixtures` calls it.
 *
 * `active-job` is DELIBERATELY ABSENT and the absence is the finding. `seedRouteFixtures` does call
 * `seedJob`, but with no `status`, and `seedJob` defaults to a FINISHED deploy — so the row it
 * writes is not the fixture `jobs.cancel` declares. Listing `active-job` here would claim a
 * measurement the seeder cannot produce, which is the same over-claim one level down.
 *
 * ⚠ `fixture:` is DECLARED on every registry entry and, before this, was read by nothing — not this
 * spec, not `context.ts`, not `scripts/check-destructive-actions.mjs`. A column no instrument reads
 * cannot be wrong, which is why 35 distinct fixtures could be declared against two that are seeded.
 */
const SEEDABLE_FIXTURES: ReadonlySet<string> = new Set(["none", "project"]);

/**
 * Entries the registry records `confirmed`, whose fixture IS seedable, and which the run still
 * cannot reach — each with the reason and the thing that has to change.
 *
 * THIS LEDGER FAILS IN BOTH DIRECTIONS, and the second direction is the one that matters. An
 * undeclared withheld verdict on an owed control is loud. A ledger entry that OUTLIVES its subject
 * is silent, and would suppress a real measurement forever — so an entry here that the run DID
 * measure is also a failure, telling the reader to delete the line. The list can therefore only
 * shrink, and #4458's fixture work shrinks it.
 *
 * It is not a place to park work. Every line names a defect in the REGISTRY ENTRY or in the
 * product, not "no fixture yet" — an entry whose fixture is unseedable never reaches this list at
 * all, because `SEEDABLE_FIXTURES` already excludes it.
 */
const UNREACHED: ReadonlyMap<string, string> = new Map([
	[
		"env.destroy",
		"its reach chain opens with {select: \"the project node\"} — a canvas node, not an accessible " +
			"name, so `walkReach`'s role/label lookup cannot resolve it. The entry needs a reach step naming " +
			"a real control, or the canvas node needs an accessible name.",
	],
	[
		"canvas.discard-staged",
		'its reach step is {open: "add a node so the pending-changes bar renders"} — a sentence of ' +
			"prose where a control name belongs, so it can never match. The bar renders only once the " +
			"canvas holds a staged change, which is a STATE the `project` fixture does not create.",
	],
]);

// ── the record ──────────────────────────────────────────────────────────────────────────────────

type Observed = "confirmed" | "missing" | "inert" | "undo" | "not-measured" | "errored";

interface Verdict {
	id: string;
	route: string;
	expected: string;
	observed: Observed;
	verdict: "match" | "mismatch" | "withheld" | "errored";
	reason?: string;
}

const verdicts: Verdict[] = [];

function record(v: Verdict): void {
	verdicts.push(v);
}

/** A reason is REQUIRED — "not measured" with no cause is the shape that reads as a pass. */
function withhold(entry: ControlEntry, reason: string): void {
	record({ id: entry.id, route: entry.route, expected: String(entry.status), observed: "not-measured", verdict: "withheld", reason });
}

// ── never press a confirm ───────────────────────────────────────────────────────────────────────

/**
 * Wrap a locator so that clicking it fails loudly. The destructive button is located so it can be
 * ASSERTED — its presence and its label are the evidence — and this makes "never pressed" a
 * property of the code rather than a promise in a comment.
 */
function assertNeverPressed(confirmButton: Locator, id: string): Locator {
	return new Proxy(confirmButton, {
		get(target, prop, receiver) {
			if (prop === "click" || prop === "dblclick" || prop === "press") {
				return () => {
					throw new Error(`${id}: this spec must NEVER activate a destructive confirmation. Only Cancel is ever pressed.`);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

// ── observation 1: the request deny-list ────────────────────────────────────────────────────────

interface RequestWatch {
	stop: () => Request[];
}

/**
 * Record every non-GET request the page issues from now on. A Next server action posts to the
 * CURRENT url carrying a `Next-Action` header, so the mutation has no distinctive path of its own —
 * the method and the header are what identify it.
 */
function watchMutations(page: Page): RequestWatch {
	const seen: Request[] = [];
	const onRequest = (req: Request) => {
		const method = req.method();
		if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
		// Next's RSC and telemetry chatter is not a mutation.
		const url = req.url();
		if (/\/_next\/(static|image)\//.test(url)) return;
		seen.push(req);
	};
	page.on("request", onRequest);
	return {
		stop: () => {
			page.off("request", onRequest);
			return seen;
		},
	};
}

function describeRequests(reqs: Request[]): string {
	return reqs.map((r) => `${r.method()} ${new URL(r.url()).pathname}${r.headers()["next-action"] ? " [Next-Action]" : ""}`).join(", ");
}

// ── observation 2: the database fingerprint ─────────────────────────────────────────────────────

/**
 * Row counts across every public table.
 *
 * Table-agnostic on purpose: the registry does not record which table a control writes, and adding
 * that field would be a second list to keep in step by hand. Counting everything asks a broader
 * question — "did this click destroy ANY row" — which is the question the spec actually wants, and
 * it cannot go stale when a control starts writing somewhere new.
 */
async function fingerprint(): Promise<Map<string, number>> {
	const sql = db();
	const tables = await sql<{ table_name: string }[]>`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		ORDER BY table_name`;
	const counts = new Map<string, number>();
	for (const { table_name } of tables) {
		// `sql.unsafe` is generic, so the row shape is DECLARED rather than cast. CLAUDE.md §6 bans
		// `as`, and the ban earns its keep here: the cast this replaced claimed `{ n: number }` of a
		// value the driver types as `Row & Iterable<Row>`, which is exactly the assertion a reader
		// cannot check and the compiler had already refused.
		const rows = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table_name}"`);
		counts.set(table_name, rows[0].n);
	}
	return counts;
}

function diffFingerprints(before: Map<string, number>, after: Map<string, number>): string[] {
	const moved: string[] = [];
	for (const [table, n] of before) {
		const m = after.get(table);
		if (m !== undefined && m !== n) moved.push(`${table} ${n}→${m}`);
	}
	return moved;
}

// ── reaching a control ──────────────────────────────────────────────────────────────────────────

/**
 * Walk the entry's `reach` chain. Returns null with a reason when a step cannot be taken — a
 * control behind an opener that is not rendered is NOT MEASURED, not absent.
 */
async function walkReach(page: Page, entry: ControlEntry): Promise<string | null> {
	for (const step of entry.reach ?? []) {
		const [kind, nameRaw] = Object.entries(step)[0] ?? [];
		if (!kind || !nameRaw) continue;
		const name = String(nameRaw);
		try {
			if (kind === "section") {
				// A `section` is the LABELLED REGION holding the control, and in this console that
				// label is often not a heading. `SettingsDangerRow` (settings-ui.tsx:193) renders
				// its `title` as `<div className="… font-medium …">` with no role at all, so a
				// heading-only lookup withheld `org.delete` and `project.delete` — both of which
				// need no fixture and were the two controls this suite could otherwise have
				// measured on a bare org. Measured on run 34364283140: 0 of 46.
				//
				// So: heading first, because that is the correct markup and the one the console is
				// moving toward (CLAUDE.md §6 / SectionHeading); plain text second, because that is
				// what is there today. Falling back is not papering over the a11y gap — the gap is
				// reported separately — it is refusing to let this suite's denominator depend on it.
				const heading = page.getByRole("heading", { name: new RegExp(escapeRe(name), "i") }).first();
				const label = page.getByText(new RegExp(`^\\s*${escapeRe(name)}\\s*$`, "i")).first();
				const target = (await heading.count()) > 0 ? heading : label;
				await target.waitFor({ state: "visible", timeout: 8_000 });
				await target.scrollIntoViewIfNeeded();
				continue;
			}
			// menu / open / select all resolve to "activate the thing named, then wait for it".
			//
			// `option` is in the list because a rail row is not always a button: #4433 rebuilt the
			// alerts channel and policy rails as `role="listbox"` of `role="option"`, precisely so a
			// policy's rail row stops colliding by role with its "Used by" pill. A button-only
			// opener would withhold every `select:` control on that route and blame the fixture.
			const named = new RegExp(escapeRe(name), "i");
			const opener = page
				.getByRole("button", { name: named })
				.or(page.getByRole("option", { name: named }))
				.or(page.getByRole("menuitem", { name: named }))
				.or(page.getByLabel(named))
				.first();
			await opener.waitFor({ state: "visible", timeout: 8_000 });
			await opener.click();
			await page.waitForTimeout(300);
		} catch {
			return `reach step {${kind}: "${name}"} could not be taken on ${entry.route}`;
		}
	}
	return null;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The roles the registry is allowed to name.
 *
 * The ledger is DATA — a YAML file a person edits — so its `role` arrives as an unconstrained
 * string, and `getByRole` takes a union. Narrowing against this list rather than casting is what
 * turns a typo into a recorded finding: an unknown role withholds the control WITH its reason,
 * where a cast would have thrown mid-test or, worse, silently matched nothing.
 *
 * It holds exactly what the ledger uses today (`button`, `menuitem`, `switch`) plus the roles a
 * destructive trigger could plausibly take next. Extend it when a control needs one; the failure
 * when you have not is legible.
 */
const CONTROL_ROLES = ["button", "menuitem", "switch", "link", "tab", "option", "checkbox", "radio", "menuitemcheckbox"] as const;

type ControlRole = (typeof CONTROL_ROLES)[number];

function asControlRole(role: string | undefined): ControlRole | null {
	return CONTROL_ROLES.find((r): r is ControlRole => r === role) ?? null;
}

/**
 * The candidate set for the trigger, by accessible role + name — never a CSS class, per the field
 * contract.
 *
 * It returns the locator UNNARROWED. That is the whole point: a `.first()` here would make
 * `resolveTrigger`'s ambiguity check structurally unable to fire, because a `.first()` locator
 * resolves to at most one element and `count()` can then only be 0 or 1. It was written that way,
 * under a comment describing the hazard it caused (#4639), and the audit resolved every collision
 * by document order for as long as it stood. Narrowing is a DECISION, and it belongs where the
 * decision is made.
 */
function triggerCandidates(page: Page, entry: ControlEntry): { locator: Locator } | { problem: string } {
	const role = asControlRole(entry.control?.role);
	const name = entry.control?.name;
	if (!entry.control?.role || !name) return { problem: "the entry declares no `control` role+name, so there is nothing to activate" };
	if (!role) {
		return {
			problem: `the entry names role "${entry.control.role}", which is not one of ${CONTROL_ROLES.join(", ")}. Either the role is a typo or a destructive control has taken a new shape — add it to CONTROL_ROLES.`,
		};
	}
	// A name carrying a `<placeholder>` is a template; match its literal prefix.
	const literal = name.split("<")[0].trim();
	const matcher = literal ? new RegExp(escapeRe(literal), "i") : new RegExp(escapeRe(name), "i");
	return { locator: page.getByRole(role, { name: matcher }) };
}

/** The single control to drive, or the reason no verdict can be attributed to any of them. */
type Resolution = { locator: Locator } | { withhold: string };

/**
 * Turn the candidate set into ONE control, or into a withheld verdict with its reason.
 *
 * AMBIGUITY IS A FINDING, NOT A COIN FLIP.
 *
 * `.first()` picks one of N identically-named controls and records the verdict against whichever it
 * happened to be — a true assertion about the wrong control, which is worse than no assertion
 * because it reads as measured. The settings pages make this concrete: `SettingsDangerRow` names
 * every destructive button just "Delete" and puts the thing being deleted in an unassociated
 * `<div>`, so two danger rows on one page are two identical buttons.
 *
 * After `reach` has run, more than one match means the entry's reach did not narrow to a single
 * control — that is a defect in the registry entry, or in the product's naming, and either way it
 * must be reported rather than guessed past. So `.first()` is applied HERE and only once
 * `matches === 1` has been established, which makes it a no-op on a set of one rather than a choice
 * between N.
 *
 * ⚠ WHAT IS COUNTED IS THE ACCESSIBILITY TREE, AND THE COUNT COMES BEFORE THE VISIBILITY GATE.
 * Both halves are measured rather than assumed, because the first draft of this comment asserted the
 * opposite of the first half and passed every test and linter — which is the defect class this unit
 * exists to close, committed inside the fix for it.
 *
 *  · `getByRole` defaults to `includeHidden: false`, so a duplicate hidden by `hidden`,
 *    `display:none`, `visibility:hidden` or `aria-hidden` is NOT a candidate (measured: 2 in the DOM,
 *    `count()` 1). That is the behaviour to want. The persona cannot activate such a control, so no
 *    verdict could be mis-attributed to it, and counting it would withhold a perfectly measurable
 *    control on every page carrying a closed menu with a "Delete" item in it — mass false ambiguity,
 *    which costs exactly what #4646 is about.
 *  · A match that IS in the tree but that `isVisible()` rejects — a zero-box control — is counted
 *    (measured: `count()` 2, `first().isVisible()` false). Hence the order: gate on visibility first
 *    and that duplicate silently drops out, leaving `.first()` to pick the survivor and report a
 *    verdict as though the name were unambiguous. Counting first names the collision instead.
 *
 * Driven in all five directions by the self-tests at the foot of this file: 0 matches, 1 match, 2
 * identically-named controls, a hidden duplicate (not ambiguity), and a zero-box duplicate
 * (ambiguity). The ⚠ above is a claim about behaviour, and an unasserted claim is what #4639 is.
 */
async function resolveTrigger(page: Page, entry: ControlEntry, where: string): Promise<Resolution> {
	const candidates = triggerCandidates(page, entry);
	if ("problem" in candidates) return { withhold: candidates.problem };
	const matches = await candidates.locator.count();
	const named = `the trigger {${entry.control?.role}: "${entry.control?.name}"}`;
	if (matches === 0) return { withhold: `${named} is not rendered at ${where} for this persona` };
	if (matches > 1) {
		return {
			withhold:
				`${named} matches ${matches} controls at ${where} after its reach chain — ` +
				"ambiguous, so no verdict can be attributed. Narrow the entry's `reach`, or give the control an accessible name that distinguishes it.",
		};
	}
	const locator = candidates.locator.first();
	if (!(await locator.isVisible().catch(() => false))) {
		return { withhold: `${named} is not rendered at ${where} for this persona` };
	}
	return { locator };
}

// ── the suite ───────────────────────────────────────────────────────────────────────────────────

let contextOnce: Promise<AuditContext> | null = null;

/**
 * The audit context — the org, its owner, and the rows the parameterised routes need.
 *
 * Established LAZILY, on the first control test that needs it, rather than in a file-level
 * `beforeAll`. Two reasons, and the second is why it changed:
 *
 *  1. A `beforeAll` that throws makes every test in the file fail with the hook's error, which says
 *     nothing about any individual control. Reached from the test body, the same failure is recorded
 *     as a withheld verdict WITH ITS REASON on each control — the distinction this file's header
 *     calls the repo's most expensive recurring defect.
 *  2. A file-level hook runs for EVERY test in the file, including the self-tests at the foot of
 *     this one. Those drive `resolveTrigger` against `page.setContent()` markup and need no app, no
 *     database and no seeded org; a hook that reaches for all three would make the instrument's own
 *     test depend on the environment it exists to keep honest.
 *
 * It restores before it seeds, so a WORKER RESTART reuses the previous worker's rows instead of
 * writing a second set (see `context.ts` — a single timeout discards the worker, and `beforeAll`
 * ran again in the fresh one).
 */
function auditContext(browser: Browser): Promise<AuditContext> {
	contextOnce ??= (async () => {
		const page = await browser.newPage();
		try {
			const orgSlug = await resolveOrgSlug(page);
			const ctx: AuditContext = { orgSlug, owner: await resolveOwner(orgSlug) };
			restoreContext(ctx);
			if (!ctx.projectSlug) {
				await seedRouteFixtures(ctx);
				saveContext(ctx);
			}
			return ctx;
		} finally {
			await page.close();
		}
	})();
	return contextOnce;
}

for (const entry of CONTROLS) {
	test(`${entry.id} — declares ${entry.confirm ?? "none"} (${entry.status})`, async ({ page, browser }) => {
		const routeRecord = consoleRoutes().routes.find((r) => r.route === entry.route);
		if (!routeRecord) {
			withhold(entry, `the manifest has no route ${entry.route} — the control's page moved or was removed`);
			return;
		}

		let ctx: AuditContext;
		try {
			ctx = await auditContext(browser);
		} catch (err) {
			withhold(entry, `the audit context could not be established: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		let url: string;
		try {
			url = materialize(routeRecord, ctx);
		} catch (err) {
			withhold(entry, `route could not be materialised: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		await page.goto(url, { waitUntil: "domcontentloaded" });

		const reachFailure = await walkReach(page, entry);
		if (reachFailure) {
			withhold(entry, reachFailure);
			return;
		}

		const resolved = await resolveTrigger(page, entry, url);
		if ("withhold" in resolved) {
			withhold(entry, resolved.withhold);
			return;
		}
		const trigger = resolved.locator;

		// ── both observations start BEFORE the click.
		const before = await fingerprint();
		const watch = watchMutations(page);

		await trigger.click();
		await page.waitForTimeout(500);

		const dialog = page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"], [role="dialog"]').first();
		const dialogAppeared = await dialog.isVisible().catch(() => false);

		const expectsDialog = entry.confirm === "alert-dialog" || entry.confirm === "confirm-dialog";
		let observed: Observed;

		if (expectsDialog) {
			if (!dialogAppeared) {
				const requests = watch.stop();
				record({ id: entry.id, route: entry.route, expected: String(entry.status), observed: "missing", verdict: "mismatch", reason: "no confirmation appeared" });
				expect(dialogAppeared, `${entry.id}: the registry says this control confirms with a ${entry.confirm}, and no dialog appeared. Requests seen: ${describeRequests(requests) || "none"}`).toBe(true);
				return;
			}
			// The destructive button is ASSERTED, never activated.
			if (entry.confirm_action) {
				const confirmButton = assertNeverPressed(dialog.getByRole("button", { name: new RegExp(escapeRe(entry.confirm_action), "i") }).first(), entry.id);
				await expect(confirmButton, `${entry.id}: the dialog should offer "${entry.confirm_action}"`).toBeVisible();
			}
			if (entry.dialog_title) {
				const literal = entry.dialog_title.split("<")[0].trim();
				if (literal) {
					await expect(dialog, `${entry.id}: a renamed dialog is a finding, not a pass — expected a title beginning "${literal}"`).toContainText(new RegExp(escapeRe(literal), "i"));
				}
			}
			// The ONLY button this file ever presses.
			const cancel = dialog.getByRole("button", { name: /^(cancel|no|keep|nevermind|never mind)\b/i }).first();
			await expect(cancel, `${entry.id}: a confirmation with no way out is worse than none`).toBeVisible();
			await cancel.click();
			await expect(dialog, `${entry.id}: Cancel should close the dialog`).toBeHidden({ timeout: 5_000 });
			observed = "confirmed";
		} else if (entry.confirm === "undo") {
			observed = "undo";
		} else {
			// `none` / `popover`: the registry records that a bare click fires. The spec asserts the
			// RECORDED state — a dialog appearing here is stale evidence, and the lane that added it
			// must flip the entry in the same PR. It is a finding either way, never a silent pass.
			//
			// It is asserted WITHOUT clicking: the trigger was already activated above, and for a
			// `none` control that click is the mutation. That is why the two observations below are
			// read but not required to be empty for this branch — see the verdict.
			observed = dialogAppeared ? "confirmed" : entry.status === "inert" ? "inert" : "missing";
		}

		const requests = watch.stop();
		const after = await fingerprint();
		const moved = diffFingerprints(before, after);

		if (expectsDialog) {
			// ── WHAT EACH OBSERVATION CAN AND CANNOT PROVE ──────────────────────────────────
			//
			// The header comment used to claim these were two independent proofs of "nothing
			// mutated". The first run showed that to be an overclaim, and the retraction is worth
			// stating precisely because the shape is this repo's most expensive defect: an
			// assertion that is true about the wrong thing.
			//
			// A Next server action POSTs to the CURRENT url carrying an opaque action id in
			// `Next-Action` — the action's NAME is nowhere in the request. So "a POST happened
			// while the dialog was open" does not mean "this control's mutation fired": measured on
			// run 34368830312, `project.delete` produced SIX such POSTs to `…/settings/general`
			// from the page's own unrelated work, and the assertion failed on all of them.
			//
			// So the deny-list asserts ONLY where the request can be attributed to this entry's
			// mutation — the bare-fetch shape (`<path> <VERB>`), where the path IS the identifier.
			// For a server action it is recorded as evidence and not asserted on, because an
			// unattributable request is not evidence about THIS control.
			//
			// The DATABASE FINGERPRINT carries the assertion in every other case. It is not
			// complete either, and the bound is stated rather than implied: it counts rows, so it
			// sees an insert or a delete and CANNOT see an update in place — a mutation like
			// `setMemberSuspended` that flips a column would pass it. That is a real gap, and the
			// honest answer is that this suite proves "no row was created or destroyed", not
			// "nothing happened at all".
			const mutating = requests.filter((r) => r.method() !== "GET");
			const fetchShape = entry.mutation.match(/^(\S+)\s+(DELETE|PUT|POST)$/);
			if (fetchShape) {
				const attributable = mutating.filter((r) => new URL(r.url()).pathname.includes(fetchShape[1]) && r.method() === fetchShape[2]);
				expect(
					attributable.length,
					`${entry.id}: \`${entry.mutation}\` was issued while the confirmation was open and Cancel was pressed — the mutation fired before the user agreed. ${describeRequests(attributable)}`,
				).toBe(0);
			}
			expect(moved, `${entry.id}: Cancel was pressed and rows still moved: ${moved.join(", ")}`).toEqual([]);
		}

		record({
			id: entry.id,
			route: entry.route,
			expected: String(entry.status),
			observed,
			verdict: observed === entry.status ? "match" : "mismatch",
			reason: observed === entry.status ? undefined : `the registry records "${entry.status}" and the run observed "${observed}"`,
		});

		expect(
			observed,
			`${entry.id}: the registry records "${entry.status}" but the run observed "${observed}". ` +
				(observed === "confirmed"
					? "A confirmation now exists where the ledger says there is none — the lane that added it must flip this entry in the same PR (the registry header states this)."
					: "The confirmation the ledger promises is not there."),
		).toBe(entry.status);
	});
}

// ── the report, and the guard on its own emptiness ──────────────────────────────────────────────

test.afterAll(async () => {
	const dir = path.resolve(__dirname, "..", "..", "test-results");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	// RECONCILE, so the ledger's own arithmetic holds. A test that THREW — a failed assertion, a
	// timeout — never reaches its `record()`, so it is neither measured nor withheld: it is absent,
	// and the report silently describes fewer controls than exist. Measured on run 34368830312,
	// which printed "0 of 46 controls measured, 44 withheld" — the missing 2 are exactly the two
	// that failed, and the two numbers not summing to 46 is the only thing that said so.
	//
	// An absent row and a withheld one are different findings, so they get different words rather
	// than a shared silence.
	const seen = new Set(verdicts.map((v) => v.id));
	for (const c of CONTROLS) {
		if (seen.has(c.id)) continue;
		record({
			id: c.id,
			route: c.route,
			expected: String(c.status),
			observed: "errored",
			verdict: "errored",
			reason: "the test threw before recording a verdict — see this control's failure in the run log",
		});
	}

	const measured = verdicts.filter((v) => v.verdict === "match" || v.verdict === "mismatch").length;
	writeFileSync(
		path.join(dir, "destructive.json"),
		`${JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				ledgerCount: CONTROLS.length,
				measured,
				withheld: verdicts.filter((v) => v.verdict === "withheld").length,
				errored: verdicts.filter((v) => v.verdict === "errored").length,
				controls: verdicts,
			},
			null,
			2,
		)}\n`,
	);
	await closeDb();
});

/**
 * Which entries the run OWED a measurement, given the registry and what this spec can seed.
 *
 * An entry is owed when the registry records `confirmed` — the claim that a confirmation exists —
 * AND its fixture is one `seedRouteFixtures` writes. `missing` and `inert` are recorded DEFECTS, not
 * claims, so withholding on one is honest.
 */
function owedIds(controls: ControlEntry[], seedable: ReadonlySet<string>, unreached: ReadonlyMap<string, string>): string[] {
	return controls.filter((c) => c.status === "confirmed" && seedable.has(String(c.fixture)) && !unreached.has(c.id)).map((c) => c.id);
}

/**
 * Everything wrong with this run's coverage, as a list of findings. Empty means the floor held.
 *
 * A PURE function of the registry and the verdicts — no page, no database, no clock — so the floor
 * itself can be driven in both directions by the self-tests at the foot of this file. A floor that
 * can only be exercised by a full gate run is a floor nobody can show is working, and #4646 is what
 * that costs.
 *
 * It returns findings rather than asserting, and each finding NAMES AN ID. The constant it replaces
 * compared two integers, so its failure message could say "only 1 of 47 were driven" and could not
 * say WHICH — and a count is the one thing a reader cannot act on.
 */
function owedFindings(
	controls: ControlEntry[],
	vs: Verdict[],
	seedable: ReadonlySet<string>,
	unreached: ReadonlyMap<string, string>,
): string[] {
	const byId = new Map(vs.map((v) => [v.id, v]));
	const measured = (id: string): boolean => {
		const v = byId.get(id);
		return v?.verdict === "match" || v?.verdict === "mismatch";
	};
	const findings: string[] = [];

	// ── direction 1: an owed control that was not driven. The defect #4646 records.
	for (const id of owedIds(controls, seedable, unreached)) {
		const v = byId.get(id);
		if (measured(id)) continue;
		findings.push(
			`${id}: the registry records "confirmed" and its fixture is seedable, so this run owed a measurement — ` +
				`it ${v ? `${v.verdict}: ${v.reason ?? "no reason recorded"}` : "recorded no verdict at all"}. ` +
				"A confirmation nothing opened is the registry asserting what no run has established.",
		);
	}

	// ── direction 2: the ledger and the seedable set may not OUTLIVE their subjects.
	for (const [id, why] of unreached) {
		const entry = controls.find((c) => c.id === id);
		if (!entry) {
			findings.push(`UNREACHED names "${id}", which is not in the registry — delete the line, or fix the id.`);
			continue;
		}
		if (entry.status !== "confirmed" || !seedable.has(String(entry.fixture))) {
			findings.push(
				`UNREACHED names "${id}", which is already excluded from what the run owes (status "${entry.status}", fixture "${entry.fixture}") — ` +
					"the line suppresses nothing and must go, or it will hide a real finding when that changes.",
			);
			continue;
		}
		if (measured(id)) {
			findings.push(`UNREACHED names "${id}" and the run MEASURED it — delete the line. It reads: ${why}`);
		}
	}

	// ── direction 3: the seedable set may not UNDERSTATE the run either.
	//
	// Without this, `SEEDABLE_FIXTURES` could be emptied and every finding above would disappear —
	// the cheapest escape from a red floor would be to deepen the defect. A fixture the run reached
	// but the set does not name is a fixture that must be added, so the floor rises on its own as
	// #4458 wires seeders, rather than waiting for someone to remember to raise it.
	const understated = new Set<string>();
	for (const c of controls) {
		if (c.status !== "confirmed" || seedable.has(String(c.fixture))) continue;
		if (measured(c.id)) understated.add(String(c.fixture));
	}
	for (const fixture of understated) {
		findings.push(
			`the run MEASURED a control whose fixture "${fixture}" is not in SEEDABLE_FIXTURES — the set understates what this ` +
				"spec can reach, so the floor is lower than the truth. Add it.",
		);
	}
	return findings;
}

// ⚠ THE TITLE IS A BASELINE KEY. `apps/console/e2e/gate-baseline.json` records this test by name,
// and `scripts/e2e-ratchet.mjs` rule 4 fails the leg on "baseline names a test the run lacks" — a
// rename is indistinguishable from a deletion there. What this test ASKS changed; what it is CALLED
// must not, unless the baseline moves in the same commit.
test("the run measured something — a withheld verdict is not a pass", async () => {
	const measured = verdicts.filter((v) => v.verdict === "match" || v.verdict === "mismatch").length;
	const withheld = verdicts.filter((v) => v.verdict === "withheld");
	const errored = verdicts.filter((v) => v.verdict === "errored");
	const summary = withheld.map((v) => `  · ${v.id}: ${v.reason}`).join("\n");
	const owed = owedIds(CONTROLS, SEEDABLE_FIXTURES, UNREACHED);
	// Printed on every run, pass or fail. The three counts MUST sum to the ledger — if they do not, a
	// control went unrecorded, which is the failure the reconciliation above exists to make
	// impossible to miss. `owed` is printed beside them because the interesting number is no longer
	// how many ran, it is how many SHOULD have.
	console.log(
		`destructive: ${measured} measured, ${withheld.length} withheld, ${errored.length} errored ` +
			`= ${measured + withheld.length + errored.length} of ${CONTROLS.length} in the ledger; ` +
			`${owed.length} owed (${owed.join(", ") || "none"}), ${UNREACHED.size} declared unreached.\n${summary}`,
	);
	const findings = owedFindings(CONTROLS, verdicts, SEEDABLE_FIXTURES, UNREACHED);
	// The findings are PRINTED in the message, not counted. A boolean assertion about a structure
	// that does not show the structure when it fails sends the reader back to the run log.
	expect(findings, `the run did not establish what the registry claims:\n${findings.map((f) => `  · ${f}`).join("\n")}\n\nwithheld:\n${summary}`).toEqual([]);
});

// ── the instrument's own test ───────────────────────────────────────────────────────────────────
//
// `resolveTrigger` is the step that decides whether a control was MEASURED or WITHHELD, so a defect
// in it is invisible by construction: it does not make the suite red, it makes the suite report a
// verdict about the wrong element, or a reason that names the wrong cause. #4639 is exactly that —
// the ambiguity branch stood for as long as the file existed and could not fire, because the locator
// it counted had already been narrowed with `.first()`.
//
// So the decision is driven here against markup this file builds, in ALL FIVE directions: no match,
// one match, two identically-named controls, a visible control beside an A11Y-HIDDEN duplicate (NOT
// ambiguity), and a visible control beside a ZERO-BOX duplicate (ambiguity). Each drives the REAL
// function, not a restatement of it — a self-test that re-implements the rule verifies a copy.
//
// The last two are not decoration. They are the only assertions on the ⚠ in `resolveTrigger`'s
// doc comment, which states what is counted and in what order; the count and the order are each a
// separate decision, and each has its own mutation here. Keep this number in step with the tests
// below — a comment that says FOUR beside five tests is the same defect class as the one this unit
// closes, and nothing but a reader catches it.
//
// Their BODIES reach for no app, no database and no seeded org: `page.setContent` is the entire
// fixture, and nothing here calls `auditContext`, `materialize` or `record`. That is a property of
// the tests, NOT of the leg they ride in — `audit-interaction` declares `dependencies: ["setup"]`
// and the config's `webServer` boots the console for the controls above, so in CI these five start
// after it like everything else in the file. What the property buys is that they can be driven
// against a bare chromium with a config that declares neither, which is how #4639's fix was
// mutation-tested in both directions before it was written.

/** A registry-shaped entry for the self-tests. Never recorded: `record()` is not reached from here. */
function selfTestEntry(name: string): ControlEntry {
	return {
		id: "self-test.trigger",
		route: "/self-test",
		surface: "apps/console/e2e/audit/destructive.spec.ts",
		mutation: "",
		control: { role: "button", name },
	};
}

test("self-test — `resolveTrigger` withholds on AMBIGUITY rather than picking one of N", async ({ page }) => {
	// Two danger rows, both named "Delete" — the `SettingsDangerRow` shape the comment on
	// `resolveTrigger` names. A `.first()` anywhere upstream of the count makes this case
	// indistinguishable from the single-control one.
	await page.setContent(`
		<main>
			<div><span>Production</span><button>Delete</button></div>
			<div><span>Staging</span><button>Delete</button></div>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("withhold" in resolved, "two identically-named controls must NOT resolve to a locator — that is the mis-attribution #4639 records").toBe(true);
	if (!("withhold" in resolved)) return;
	expect(resolved.withhold).toContain("matches 2 controls");
	expect(resolved.withhold).toContain("ambiguous, so no verdict can be attributed");
});

test("self-test — `resolveTrigger` resolves a SINGLE match, and the template's prefix is what matches", async ({ page }) => {
	await page.setContent(`
		<main>
			<div><span>Production</span><button>Delete</button></div>
			<div><span>Staging</span><button>Keep</button></div>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("locator" in resolved, "one match is not ambiguous and must be driven").toBe(true);
	if (!("locator" in resolved)) return;
	await expect(resolved.locator).toHaveText("Delete");
});

test("self-test — an A11Y-HIDDEN duplicate is NOT a candidate, so one visible control still resolves", async ({ page }) => {
	// First half of the ⚠ on `resolveTrigger`. `getByRole` defaults to `includeHidden: false`, so the
	// duplicate behind `hidden` is not in the candidate set at all and the visible control is driven.
	// Flip that default and every page carrying a closed menu with a "Delete" item in it starts
	// withholding for ambiguity — a measurable control lost to a control nobody can press.
	await page.setContent(`
		<main>
			<div hidden><span>Production</span><button>Delete</button></div>
			<div><span>Staging</span><button>Delete</button></div>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("locator" in resolved, "a control the persona cannot activate is not a control the verdict could be mis-attributed to").toBe(true);
	if (!("locator" in resolved)) return;
	await expect(resolved.locator).toBeVisible();
});

test("self-test — a ZERO-BOX duplicate IS counted, so it reports ambiguity rather than `not rendered`", async ({ page }) => {
	// Second half of the ⚠: the count runs BEFORE the visibility gate. This markup is the case that
	// separates the two orders — both buttons are in the accessibility tree, and the first has no
	// box. Gate on visibility first and the zero-box one drops out silently, leaving `.first()` to
	// report a verdict as though the name were unambiguous.
	await page.setContent(`
		<main>
			<button style="width:0;height:0;padding:0;border:0;overflow:hidden">Delete</button>
			<button>Delete</button>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("withhold" in resolved, "two in-tree controls with one accessible name is a collision, whatever their boxes").toBe(true);
	if (!("withhold" in resolved)) return;
	expect(resolved.withhold).toContain("matches 2 controls");
	expect(resolved.withhold).not.toContain("is not rendered");
});

test("self-test — `resolveTrigger` withholds `not rendered` when NOTHING matches", async ({ page }) => {
	await page.setContent(`<main><button>Keep</button></main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("withhold" in resolved).toBe(true);
	if (!("withhold" in resolved)) return;
	expect(resolved.withhold).toContain("is not rendered at about:self-test");
	// The two withholding branches must stay DISTINGUISHABLE: "not rendered" and "ambiguous" are
	// different findings with different fixes, and a shared reason is how #4639's collisions were
	// reported as a missing fixture for as long as they were.
	expect(resolved.withhold).not.toContain("ambiguous");
});

// ── the floor's own test ────────────────────────────────────────────────────────────────────────
//
// `owedFindings` is the whole of #4646: it is what decides whether a run that DROVE NOTHING is
// allowed to be green. The constant it replaced could only be exercised by a full gate run — an app,
// a database, a seeded org and a browser — so nothing ever demonstrated it working, and it did not.
// These drive it directly, on synthetic verdicts, in both directions.
//
// They build their registry and their verdicts rather than reading the real ones on purpose. A
// self-test that ran against `CONTROLS` would change meaning every time a lane flips an entry, and
// would then be asserting whatever the registry happens to say — which is the thing under test.

/** A registry-shaped entry for the floor's self-tests. */
function floorEntry(id: string, status: string, fixture: string): ControlEntry {
	return { id, route: "/self-test", surface: "apps/console/e2e/audit/destructive.spec.ts", mutation: "", status, fixture };
}

/**
 * An EMPTY UNREACHED ledger, for the self-tests that build their own registry.
 *
 * Passing the real `UNREACHED` to a synthetic three-entry registry would make every real ledger
 * line report "not in the registry" — which is direction 2 working correctly on the wrong input.
 * This is why the ledger and the seedable set are PARAMETERS rather than module reads: the one
 * test that must drive the REAL ledger passes it explicitly, and says so in its name.
 */
const NO_LEDGER: ReadonlyMap<string, string> = new Map();

/** A verdict for `id` that counts as MEASURED. */
function measuredVerdict(id: string): Verdict {
	return { id, route: "/self-test", expected: "confirmed", observed: "confirmed", verdict: "match" };
}

/** A verdict for `id` that counts as WITHHELD — the shape that used to read as a pass. */
function withheldVerdict(id: string): Verdict {
	return { id, route: "/self-test", expected: "confirmed", observed: "not-measured", verdict: "withheld", reason: "the trigger is not rendered for this persona" };
}

test("self-test — a FULL array of withheld verdicts is not a pass, and the old floor let it be one", async () => {
	// The exact shape #4646 records: one control measured, every other one withheld. `MIN_MEASURED`
	// was 1, so `measured >= 1` held and the suite was GREEN with 46 of 47 controls asserting
	// nothing — while each withheld control test passed on its own too, because `withhold()` returns
	// before any `expect` runs.
	const controls = [floorEntry("a.delete", "confirmed", "project"), floorEntry("b.delete", "confirmed", "project"), floorEntry("c.delete", "confirmed", "none")];
	const vs = [measuredVerdict("a.delete"), withheldVerdict("b.delete"), withheldVerdict("c.delete")];

	const measured = vs.filter((v) => v.verdict === "match" || v.verdict === "mismatch").length;
	expect(measured, "the premise: the old constant floor of 1 is satisfied by this run").toBeGreaterThanOrEqual(1);

	const findings = owedFindings(controls, vs, SEEDABLE_FIXTURES, NO_LEDGER);
	expect(findings.length, `the derived floor must reject it and name both: ${findings.join(" | ")}`).toBe(2);
	expect(findings.join("\n")).toContain("b.delete");
	expect(findings.join("\n")).toContain("c.delete");
	// The finding must NAME the id. A count is the one thing a reader cannot act on.
	expect(findings.join("\n")).toContain("owed a measurement");
});

test("self-test — withholding on a `missing` or `inert` entry stays GREEN", async () => {
	// A recorded DEFECT is not a claim. The floor must not manufacture work out of an entry that
	// already says the confirmation is absent — that is the over-reporting direction, and it would
	// push the next reader to silence the floor rather than seed a fixture.
	const controls = [floorEntry("byo.chart.detach", "missing", "project"), floorEntry("account.delete", "inert", "none")];
	expect(owedFindings(controls, [withheldVerdict("byo.chart.detach"), withheldVerdict("account.delete")], SEEDABLE_FIXTURES, NO_LEDGER)).toEqual([]);
});

test("self-test — an entry whose fixture is UNSEEDABLE is not owed, so #4458's gap is not manufactured work", async () => {
	const controls = [floorEntry("teams.member.remove", "confirmed", "team-with-a-member")];
	expect(owedFindings(controls, [withheldVerdict("teams.member.remove")], SEEDABLE_FIXTURES, NO_LEDGER)).toEqual([]);
});

test("self-test — every OWED control measured is the pass", async () => {
	const controls = [floorEntry("a.delete", "confirmed", "project"), floorEntry("b.delete", "confirmed", "none")];
	expect(owedFindings(controls, [measuredVerdict("a.delete"), measuredVerdict("b.delete")], SEEDABLE_FIXTURES, NO_LEDGER)).toEqual([]);
});

test("self-test — the UNREACHED ledger fails in BOTH directions, against the REAL registry", async () => {
	// This one drives the REAL `UNREACHED` and the REAL `CONTROLS`, which is what makes it the
	// ledger's own test rather than a test of a ledger shape. Every other floor self-test builds a
	// synthetic registry and passes `NO_LEDGER`.
	const declared = [...UNREACHED.keys()];
	expect(declared.length, "an empty ledger would make this test vacuous").toBeGreaterThan(0);

	// A ledger line that OUTLIVES its subject is the silent failure: it suppresses a real finding
	// forever. So every declared id must still be a real entry that would otherwise be owed.
	for (const id of declared) {
		const entry = CONTROLS.find((c) => c.id === id);
		expect(entry, `UNREACHED names "${id}", which is not in the registry — delete the line, or fix the id`).toBeTruthy();
		expect(entry?.status, `UNREACHED names "${id}", which the registry does not record "confirmed" — it suppresses nothing`).toBe("confirmed");
		expect(SEEDABLE_FIXTURES.has(String(entry?.fixture)), `UNREACHED names "${id}", whose fixture "${entry?.fixture}" is not seedable — it suppresses nothing`).toBe(true);
	}

	const owed = owedIds(CONTROLS, SEEDABLE_FIXTURES, UNREACHED);
	expect(owed, "the floor must owe something, or it is a floor at zero").not.toEqual([]);

	// Direction A — everything owed measured, everything declared withheld: silent, by design.
	const honest = [...owed.map(measuredVerdict), ...declared.map(withheldVerdict)];
	expect(owedFindings(CONTROLS, honest, SEEDABLE_FIXTURES, UNREACHED)).toEqual([]);

	// Direction B — a declared entry the run MEASURED: loud, and it says to delete the line.
	const flipped = [...owed.map(measuredVerdict), measuredVerdict(declared[0]), ...declared.slice(1).map(withheldVerdict)];
	const findings = owedFindings(CONTROLS, flipped, SEEDABLE_FIXTURES, UNREACHED);
	expect(findings.join("\n")).toContain("delete the line");
	expect(findings.join("\n")).toContain(declared[0]);

	// Direction C — an owed control withheld: the #4646 defect, on the real registry.
	const dishonest = [...owed.slice(1).map(measuredVerdict), withheldVerdict(owed[0]), ...declared.map(withheldVerdict)];
	const owedFail = owedFindings(CONTROLS, dishonest, SEEDABLE_FIXTURES, UNREACHED);
	expect(owedFail.join("\n")).toContain("owed a measurement");
	expect(owedFail.join("\n")).toContain(owed[0]);
});

test("self-test — SEEDABLE_FIXTURES cannot be EMPTIED to silence the floor", async () => {
	// The escape route a floor like this invites: drop a fixture from the seedable set and every
	// finding about it disappears. Direction 3 closes it — a control the run reached whose fixture
	// the set does not name is itself a failure, so the set can only understate reality loudly.
	const controls = [floorEntry("a.delete", "confirmed", "fleet-pool")];
	const findings = owedFindings(controls, [measuredVerdict("a.delete")], SEEDABLE_FIXTURES, NO_LEDGER);
	expect(findings.join("\n")).toContain("understates what this");
	expect(findings.join("\n")).toContain("fleet-pool");
});

test("self-test — a control that recorded NO verdict at all is a finding, not an absence", async () => {
	const controls = [floorEntry("a.delete", "confirmed", "project")];
	const findings = owedFindings(controls, [], SEEDABLE_FIXTURES, NO_LEDGER);
	expect(findings.join("\n")).toContain("recorded no verdict at all");
});

// ── the instrument's own test ───────────────────────────────────────────────────────────────────
//
// `resolveTrigger` is the step that decides whether a control was MEASURED or WITHHELD, so a defect
// in it is invisible by construction: it does not make the suite red, it makes the suite report a
// verdict about the wrong element, or a reason that names the wrong cause. #4639 is exactly that —
// the ambiguity branch stood for as long as the file existed and could not fire, because the locator
// it counted had already been narrowed with `.first()`.
//
// So the decision is driven here against markup this file builds, in ALL FIVE directions: no match,
// one match, two identically-named controls, a visible control beside an A11Y-HIDDEN duplicate (NOT
// ambiguity), and a visible control beside a ZERO-BOX duplicate (ambiguity). Each drives the REAL
// function, not a restatement of it — a self-test that re-implements the rule verifies a copy.
//
// The last two are not decoration. They are the only assertions on the ⚠ in `resolveTrigger`'s
// doc comment, which states what is counted and in what order; the count and the order are each a
// separate decision, and each has its own mutation here. Keep this number in step with the tests
// below — a comment that says FOUR beside five tests is the same defect class as the one this unit
// closes, and nothing but a reader catches it.
//
// Their BODIES reach for no app, no database and no seeded org: `page.setContent` is the entire
// fixture, and nothing here calls `auditContext`, `materialize` or `record`. That is a property of
// the tests, NOT of the leg they ride in — `audit-interaction` declares `dependencies: ["setup"]`
// and the config's `webServer` boots the console for the controls above, so in CI these five start
// after it like everything else in the file. What the property buys is that they can be driven
// against a bare chromium with a config that declares neither, which is how #4639's fix was
// mutation-tested in both directions before it was written.

/** A registry-shaped entry for the self-tests. Never recorded: `record()` is not reached from here. */
function selfTestEntry(name: string): ControlEntry {
	return {
		id: "self-test.trigger",
		route: "/self-test",
		surface: "apps/console/e2e/audit/destructive.spec.ts",
		mutation: "",
		control: { role: "button", name },
	};
}

test("self-test — `resolveTrigger` withholds on AMBIGUITY rather than picking one of N", async ({ page }) => {
	// Two danger rows, both named "Delete" — the `SettingsDangerRow` shape the comment on
	// `resolveTrigger` names. A `.first()` anywhere upstream of the count makes this case
	// indistinguishable from the single-control one.
	await page.setContent(`
		<main>
			<div><span>Production</span><button>Delete</button></div>
			<div><span>Staging</span><button>Delete</button></div>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("withhold" in resolved, "two identically-named controls must NOT resolve to a locator — that is the mis-attribution #4639 records").toBe(true);
	if (!("withhold" in resolved)) return;
	expect(resolved.withhold).toContain("matches 2 controls");
	expect(resolved.withhold).toContain("ambiguous, so no verdict can be attributed");
});

test("self-test — `resolveTrigger` resolves a SINGLE match, and the template's prefix is what matches", async ({ page }) => {
	await page.setContent(`
		<main>
			<div><span>Production</span><button>Delete</button></div>
			<div><span>Staging</span><button>Keep</button></div>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("locator" in resolved, "one match is not ambiguous and must be driven").toBe(true);
	if (!("locator" in resolved)) return;
	await expect(resolved.locator).toHaveText("Delete");
});

test("self-test — an A11Y-HIDDEN duplicate is NOT a candidate, so one visible control still resolves", async ({ page }) => {
	// First half of the ⚠ on `resolveTrigger`. `getByRole` defaults to `includeHidden: false`, so the
	// duplicate behind `hidden` is not in the candidate set at all and the visible control is driven.
	// Flip that default and every page carrying a closed menu with a "Delete" item in it starts
	// withholding for ambiguity — a measurable control lost to a control nobody can press.
	await page.setContent(`
		<main>
			<div hidden><span>Production</span><button>Delete</button></div>
			<div><span>Staging</span><button>Delete</button></div>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("locator" in resolved, "a control the persona cannot activate is not a control the verdict could be mis-attributed to").toBe(true);
	if (!("locator" in resolved)) return;
	await expect(resolved.locator).toBeVisible();
});

test("self-test — a ZERO-BOX duplicate IS counted, so it reports ambiguity rather than `not rendered`", async ({ page }) => {
	// Second half of the ⚠: the count runs BEFORE the visibility gate. This markup is the case that
	// separates the two orders — both buttons are in the accessibility tree, and the first has no
	// box. Gate on visibility first and the zero-box one drops out silently, leaving `.first()` to
	// report a verdict as though the name were unambiguous.
	await page.setContent(`
		<main>
			<button style="width:0;height:0;padding:0;border:0;overflow:hidden">Delete</button>
			<button>Delete</button>
		</main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("withhold" in resolved, "two in-tree controls with one accessible name is a collision, whatever their boxes").toBe(true);
	if (!("withhold" in resolved)) return;
	expect(resolved.withhold).toContain("matches 2 controls");
	expect(resolved.withhold).not.toContain("is not rendered");
});

test("self-test — `resolveTrigger` withholds `not rendered` when NOTHING matches", async ({ page }) => {
	await page.setContent(`<main><button>Keep</button></main>`);
	const resolved = await resolveTrigger(page, selfTestEntry("Delete <environment>"), "about:self-test");
	expect("withhold" in resolved).toBe(true);
	if (!("withhold" in resolved)) return;
	expect(resolved.withhold).toContain("is not rendered at about:self-test");
	// The two withholding branches must stay DISTINGUISHABLE: "not rendered" and "ambiguous" are
	// different findings with different fixes, and a shared reason is how #4639's collisions were
	// reported as a missing fixture for as long as they were.
	expect(resolved.withhold).not.toContain("ambiguous");
});
