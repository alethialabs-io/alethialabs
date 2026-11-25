// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create-a-team sheet's state, as ONE pure reducer (WIZ-W7, #6930).
//
// The sheet used to hold 31 `useState` and decide which of seven panels its pay step showed from a
// nested ternary over nine of them. Its `reset()` hand-cleared 27 of those, so a field added without
// a matching line there survived a close. Everything is now a `CreateOrgState`; every change is a
// `CreateOrgEvent` named for what happened; and what is on screen is `screenOf(state)`, a union with
// one member per panel. `tests/components/org/create-org-machine.test.ts` holds the transition table:
// every screen, and every event from the states it is sent in.
//
// What stays OUT of this file, on purpose:
//   - the form (react-hook-form owns name and slug; the sheet resets it next to the events here);
//   - every server call, every storage read, every toast — the sheet does them and dispatches what
//     came back, so this file can be tested with no mock at all;
//   - the run of the post-payment steps itself. Its progress is persisted by `finishPaidSetup`
//     whether or not the sheet is open; this file only records how a run ENDED.
//
// Money-path rules the reducer keeps, each one a test:
//   - the payment refs (subscription, customer) survive "← Back" and a declaration retry, so a
//     second intent re-uses them and Stripe never holds two customers or two incomplete subscriptions;
//   - once a charge is confirmed (`pending` set), only `reset` drops the record from the state, and a
//     close asks first (`closeNeedsConfirmation`) unless a run stopped it for good;
//   - `invite` is reachable only from a finished setup (`trial-started`, a `done` outcome).

import type { ProOffer } from "@/app/server/actions/billing";
import type { PayerDeclaration } from "@/components/billing/payer-declaration-form";
import type { Role, SentInvite } from "@/components/org/org-purchase-ui";
import type {
	PaidSetupOutcome,
	PendingPaidSetup,
	StoredPaidSetup,
} from "@/components/org/pending-paid-setup";
import type { NewOrgPlanReport } from "@/lib/billing/new-org-plan-state";
import type { NewOrgSetupState } from "@/lib/billing/new-org-setup";
import type { Settlement } from "@/lib/wizard/types";
import { SUPPORTED_CURRENCIES, type SupportedCurrency } from "@repo/plan-catalog";

/** The four steps of the sheet. `pay` has seven panels of its own (`screenOf`). */
export type CreateOrgView = "name" | "declare" | "pay" | "invite";

/** The plan a PAID setup finished on, with the charge's ids so a settling state can be re-read. */
export type PaidPlan = NewOrgPlanReport & { subscriptionId: string; customerId: string };

/** A record this tab holds for a paid setup, and the run (if any) still in flight for it. */
export interface ResumeRequest {
	readonly record: PendingPaidSetup;
	readonly running: Promise<PaidSetupOutcome> | undefined;
}

/** Everything the sheet remembers besides its form. */
export interface CreateOrgState {
	readonly view: CreateOrgView;
	/** The slug was edited by hand (or restored), so typing a name no longer re-derives it. */
	readonly slugTouched: boolean;
	/** The URL editor under the name is open. */
	readonly showUrl: boolean;
	/** The account's Pro offer: null until it has resolved. */
	readonly offer: ProOffer | null;
	readonly busy: boolean;
	// The deferred-create payment refs, carried across a Back → retry so neither the customer nor
	// the incomplete subscription is duplicated in Stripe.
	readonly clientSecret: string | null;
	readonly customerId: string | null;
	readonly subscriptionId: string | null;
	/** The open intent's currency (Stripe locks it). */
	readonly currency: SupportedCurrency;
	readonly switchingCurrency: boolean;
	/** The validated team name the open intent was made for. */
	readonly checkoutOrgName: string;
	/** The payer facts. Null until the customer answers — nothing is defaulted. */
	readonly declaration: PayerDeclaration | null;
	readonly declaring: boolean;
	/** The gate's own sentence for a refused declaration, shown on the declaration step. */
	readonly refusal: string | null;
	readonly createdSlug: string;
	/** The org this sheet created (paid or trial). Invites NAME it, never the session's active org. */
	readonly createdOrgId: string | null;
	/** A paid setup the SERVER says is unfinished, found with no usable record in this tab. */
	readonly recovered: NewOrgSetupState | null;
	/** The paid setup this sheet is finishing, from the confirmed charge until its last step succeeds. */
	readonly pending: PendingPaidSetup | null;
	/** A post-payment step failed: offer a retry (no second charge), not the payment form. */
	readonly needsSetupRetry: boolean;
	/** The sentence a run ended with when retrying cannot help. */
	readonly stopped: string | null;
	/** The intent's notice about an earlier checkout that does not block this one. */
	readonly intentNotice: string | null;
	/** Paid, then the slug was refused at the create: the retry asks for a new slug. */
	readonly slugClaimedAfterPayment: boolean;
	/** A close was asked for while a paid setup is unfinished; the sheet asks first. */
	readonly confirmingClose: boolean;
	readonly isTrialOrg: boolean;
	readonly paidPlan: PaidPlan | null;
	readonly inviteEmail: string;
	readonly inviteRole: Role;
	/** Mutable in the type only because `InviteView` takes `SentInvite[]`; the reducer always copies it. */
	readonly sent: SentInvite[];
	/** The viewer the last open transition was handled for; null while closed. */
	readonly openedFor: string | null;
	/** A record restored on open, for the resume effect to attach to or restart. */
	readonly resume: ResumeRequest | null;
	/** What the tab held when it had no usable record, for the recovery effect to ask the server about. */
	readonly recoverFrom: StoredPaidSetup | null;
}

/** The state of a closed, never-used sheet — and of every sheet after `reset`. */
export const INITIAL_CREATE_ORG_STATE: CreateOrgState = {
	view: "name",
	slugTouched: false,
	showUrl: false,
	offer: null,
	busy: false,
	clientSecret: null,
	customerId: null,
	subscriptionId: null,
	currency: "usd",
	switchingCurrency: false,
	checkoutOrgName: "",
	declaration: null,
	declaring: false,
	refusal: null,
	createdSlug: "",
	createdOrgId: null,
	recovered: null,
	pending: null,
	needsSetupRetry: false,
	stopped: null,
	intentNotice: null,
	slugClaimedAfterPayment: false,
	confirmingClose: false,
	isTrialOrg: false,
	paidPlan: null,
	inviteEmail: "",
	inviteRole: "operator",
	sent: [],
	openedFor: null,
	resume: null,
	recoverFrom: null,
};

/** What the sheet found in this tab when it opened. */
export type OpenFinding =
	/** Closed, signed out, or an intent of this session is already open: nothing to restore. */
	| { readonly kind: "nothing" }
	/** A usable record, and the run (if any) still in flight for it. */
	| { readonly kind: "record"; readonly resume: ResumeRequest }
	/** No usable record: what the tab held instead, for the server to be asked about. */
	| { readonly kind: "no-record"; readonly stored: StoredPaidSetup };

/** A purchase intent the server opened. */
export interface OpenedIntent {
	readonly subscriptionId: string;
	readonly customerId: string;
	readonly clientSecret: string;
	readonly currency: SupportedCurrency;
	readonly notice: string | null;
}

/** Everything that can happen to the sheet. Each is named for what happened, not for what it sets. */
export type CreateOrgEvent =
	/** The open state changed to `key` (the viewer id while open, else null). */
	| { readonly type: "open-changed"; readonly key: string | null; readonly finding: OpenFinding }
	| { readonly type: "offer-resolved"; readonly offer: ProOffer }
	| { readonly type: "slug-edited" }
	| { readonly type: "url-editor-set"; readonly open: boolean }
	/** Some work started or ended that disables the step's buttons. */
	| { readonly type: "busy-set"; readonly busy: boolean }
	/** The server found an unfinished paid setup with no record in this tab. */
	| { readonly type: "recovery-found"; readonly state: NewOrgSetupState }
	/** The server found one, and an open hold refuses it. */
	| { readonly type: "recovery-held"; readonly notice: string }
	/** The server has been asked about what the tab held; it is not asked twice per open. */
	| { readonly type: "recovery-asked" }
	| { readonly type: "refusal-set"; readonly message: string | null }
	/** Name and slug passed; `trial` sends a trial-eligible account to the trial panel. */
	| { readonly type: "name-accepted"; readonly name: string; readonly trial: boolean }
	| { readonly type: "declare-started" }
	| { readonly type: "declare-ended" }
	/** The gate allowed the declaration and the intent opened. */
	| { readonly type: "intent-opened"; readonly intent: OpenedIntent; readonly declaration: PayerDeclaration }
	| { readonly type: "currency-switch-started" }
	| { readonly type: "currency-switch-ended" }
	/** The intent was re-opened in another currency for the same team. */
	| { readonly type: "currency-switched"; readonly intent: OpenedIntent }
	| { readonly type: "back-to-name" }
	/** "← Back" from the payment form: to the declaration, dropping the client secret only. */
	| { readonly type: "back-to-declare" }
	/** A setup found on the server (recovered, or found paid) is about to be finished under this record. */
	| { readonly type: "recovered-setup-adopted"; readonly record: PendingPaidSetup }
	| { readonly type: "trial-org-created"; readonly orgId: string; readonly slug: string }
	| { readonly type: "trial-org-rolled-back" }
	| { readonly type: "trial-started" }
	/** A merchant-of-record (Paddle) checkout completed on the org created first (O2). */
	| { readonly type: "provider-paid" }
	/** The card was confirmed and the record written: the setup is now unfinished until its last step. */
	| { readonly type: "charge-confirmed"; readonly record: PendingPaidSetup }
	/** A run of the post-payment steps starts. */
	| { readonly type: "setup-started" }
	| { readonly type: "setup-progressed"; readonly record: PendingPaidSetup }
	| { readonly type: "setup-ended"; readonly outcome: PaidSetupOutcome }
	/** A later read of a settling plan, for the charge it was armed for. */
	| { readonly type: "plan-reported"; readonly subscriptionId: string; readonly report: NewOrgPlanReport }
	| { readonly type: "close-requested" }
	| { readonly type: "close-cancelled" }
	| { readonly type: "invite-email-changed"; readonly email: string }
	| { readonly type: "invite-role-changed"; readonly role: Role }
	| { readonly type: "invite-sent"; readonly invite: SentInvite }
	/** The sheet closed: back to the initial state, keeping only what the open transition tracks. */
	| { readonly type: "reset" };

/** The currency a server-side setup names, when it is one this console sells in. */
export function knownCurrency(currency: string | null | undefined): SupportedCurrency | null {
	return SUPPORTED_CURRENCIES.find((c) => c === currency) ?? null;
}

/** The state restored from a record this tab holds, on the open transition. */
function restoredFrom(state: CreateOrgState, resume: ResumeRequest): CreateOrgState {
	const { record, running } = resume;
	const base: CreateOrgState = {
		...state,
		resume,
		recoverFrom: null,
		slugTouched: true,
		checkoutOrgName: record.name,
		subscriptionId: record.subscriptionId,
		customerId: record.customerId,
		currency: record.currency,
		declaration: record.declaration,
		createdSlug: record.createdSlug,
		createdOrgId: record.createdOrgId,
		pending: record,
		slugClaimedAfterPayment: record.slugRefusal ? true : state.slugClaimedAfterPayment,
		view: "pay",
	};
	if (running) return { ...base, busy: true };
	// A record a run stopped for support is run again (it asks the server first): the state a run
	// starts from, set now so the panel never shows a retry for it.
	if (record.stopped) return { ...base, ...SETUP_START };
	return { ...base, needsSetupRetry: true };
}

/** What every run of the post-payment steps starts from: busy, with no retry, stop or slug ask. */
const SETUP_START: Pick<CreateOrgState, "busy" | "needsSetupRetry" | "stopped" | "slugClaimedAfterPayment"> = {
	busy: true,
	needsSetupRetry: false,
	stopped: null,
	slugClaimedAfterPayment: false,
};

/** The state after a run of the post-payment steps ended with `outcome`. */
function afterSetup(state: CreateOrgState, outcome: PaidSetupOutcome): CreateOrgState {
	const idle = { ...state, busy: false };
	if (outcome.kind === "done") {
		return {
			...idle,
			pending: null,
			createdSlug: outcome.slug,
			createdOrgId: outcome.orgId,
			isTrialOrg: false,
			paidPlan: {
				planState: outcome.planState,
				paymentUrl: outcome.paymentUrl,
				subscriptionId: outcome.subscriptionId,
				customerId: outcome.customerId,
			},
			view: "invite",
		};
	}
	if (outcome.kind === "failed" && !outcome.retryable) {
		// Final. A refused setup's record was cleared by the run, so nothing is left to resume and a
		// close needs no confirmation.
		return {
			...idle,
			pending: outcome.recordCleared ? null : outcome.record,
			needsSetupRetry: false,
			stopped: outcome.message,
		};
	}
	return {
		...idle,
		pending: outcome.record,
		createdSlug: outcome.record.createdSlug,
		createdOrgId: outcome.record.createdOrgId,
		slugClaimedAfterPayment: outcome.kind === "slug-refused" ? true : state.slugClaimedAfterPayment,
		needsSetupRetry: true,
	};
}

/** The payment refs of an intent the server opened. */
function withIntent(state: CreateOrgState, intent: OpenedIntent): CreateOrgState {
	return {
		...state,
		subscriptionId: intent.subscriptionId,
		customerId: intent.customerId,
		clientSecret: intent.clientSecret,
		currency: intent.currency,
		intentNotice: intent.notice,
	};
}

/** The one transition function. Pure: no I/O, no clock, no randomness. */
export function createOrgReducer(state: CreateOrgState, event: CreateOrgEvent): CreateOrgState {
	switch (event.type) {
		case "open-changed": {
			const opened = { ...state, openedFor: event.key, resume: null, recoverFrom: null };
			if (event.finding.kind === "record") return restoredFrom(opened, event.finding.resume);
			if (event.finding.kind === "no-record") return { ...opened, recoverFrom: event.finding.stored };
			return opened;
		}
		case "offer-resolved":
			return { ...state, offer: event.offer };
		case "slug-edited":
			return { ...state, slugTouched: true };
		case "url-editor-set":
			return { ...state, showUrl: event.open };
		case "busy-set":
			return { ...state, busy: event.busy };
		case "recovery-found": {
			const found = event.state;
			const currency = knownCurrency(found.currency);
			return {
				...state,
				slugTouched: true,
				checkoutOrgName: found.name,
				subscriptionId: found.subscriptionId,
				customerId: found.customerId,
				currency: currency ?? state.currency,
				recovered: found,
				refusal: null,
				view: "declare",
			};
		}
		case "recovery-held":
			return { ...state, stopped: event.notice, view: "pay" };
		case "recovery-asked":
			return { ...state, recoverFrom: null };
		case "refusal-set":
			return { ...state, refusal: event.message };
		case "name-accepted":
			if (event.trial) return { ...state, view: "pay" };
			return { ...state, checkoutOrgName: event.name, refusal: null, view: "declare" };
		case "declare-started":
			return { ...state, declaring: true, refusal: null };
		case "declare-ended":
			return { ...state, declaring: false };
		case "intent-opened":
			return { ...withIntent(state, event.intent), declaration: event.declaration, view: "pay" };
		case "currency-switch-started":
			return { ...state, switchingCurrency: true };
		case "currency-switch-ended":
			return { ...state, switchingCurrency: false };
		case "currency-switched":
			return withIntent(state, event.intent);
		case "back-to-name":
			return { ...state, view: "name" };
		case "back-to-declare":
			return { ...state, view: "declare", clientSecret: null };
		case "recovered-setup-adopted": {
			const { record } = event;
			return {
				...state,
				checkoutOrgName: record.name,
				subscriptionId: record.subscriptionId,
				customerId: record.customerId,
				clientSecret: null,
				currency: record.currency,
				declaration: record.declaration,
				recovered: null,
				pending: record,
				view: "pay",
			};
		}
		case "trial-org-created":
			return { ...state, createdSlug: event.slug, createdOrgId: event.orgId };
		case "trial-org-rolled-back":
			return { ...state, createdSlug: "", createdOrgId: null };
		case "trial-started":
			return { ...state, isTrialOrg: true, paidPlan: null, view: "invite" };
		case "provider-paid":
			return { ...state, isTrialOrg: false, paidPlan: null, view: "invite" };
		case "charge-confirmed":
			return { ...state, pending: event.record };
		case "setup-started":
			return { ...state, ...SETUP_START };
		case "setup-progressed":
			return { ...state, pending: event.record };
		case "setup-ended":
			return afterSetup(state, event.outcome);
		case "plan-reported":
			if (state.paidPlan === null || state.paidPlan.subscriptionId !== event.subscriptionId) return state;
			return { ...state, paidPlan: { ...state.paidPlan, ...event.report } };
		case "close-requested":
			return { ...state, confirmingClose: true };
		case "close-cancelled":
			return { ...state, confirmingClose: false };
		case "invite-email-changed":
			return { ...state, inviteEmail: event.email };
		case "invite-role-changed":
			return { ...state, inviteRole: event.role };
		case "invite-sent":
			return { ...state, sent: [...state.sent, event.invite], inviteEmail: "" };
		case "reset":
			// Kept: the open-transition bookkeeping (`openedFor`, `resume`, `recoverFrom`) and the offer,
			// which track the `open` prop rather than what was typed; and the three intent fields the
			// sheet's reset never cleared (`currency`, `checkoutOrgName`, `switchingCurrency`) — the next
			// intent sets them, and a currency switch still in flight clears its own flag when it ends.
			return {
				...INITIAL_CREATE_ORG_STATE,
				offer: state.offer,
				currency: state.currency,
				checkoutOrgName: state.checkoutOrgName,
				switchingCurrency: state.switchingCurrency,
				openedFor: state.openedFor,
				resume: state.resume,
				recoverFrom: state.recoverFrom,
			};
	}
}

/** Whether a close must be confirmed first: a paid setup is unfinished and no run stopped it for good. */
export function closeNeedsConfirmation(state: CreateOrgState): boolean {
	return state.pending !== null && !state.confirmingClose && state.stopped === null;
}

/** Whether leaving the page must be confirmed: a paid setup is unfinished, running or failed. */
export function setupUnfinished(state: CreateOrgState): boolean {
	return state.pending !== null && state.stopped === null;
}

/** What the sheet shows. One member per panel; the pay step's seven are the last seven. */
export type CreateOrgScreen =
	| { readonly kind: "name" }
	/** The server found a paid setup with no record here: declare again to finish it. */
	| { readonly kind: "declare-recovered"; readonly recovered: NewOrgSetupState }
	| { readonly kind: "declare" }
	| { readonly kind: "invite" }
	| { readonly kind: "confirm-close"; readonly pending: PendingPaidSetup }
	| { readonly kind: "stopped"; readonly message: string }
	| { readonly kind: "retry-new-slug"; readonly pending: PendingPaidSetup }
	/** `failed` false: the steps are running; true: one failed and a retry is offered. */
	| { readonly kind: "retry-setup"; readonly pending: PendingPaidSetup; readonly failed: boolean }
	| { readonly kind: "trial" }
	| { readonly kind: "checkout"; readonly clientSecret: string }
	/** The pay step with no intent open yet: nothing to show. */
	| { readonly kind: "no-intent" };

/** The panel `state` shows, decided in the order the sheet always decided it. */
export function screenOf(state: CreateOrgState): CreateOrgScreen {
	switch (state.view) {
		case "name":
			return { kind: "name" };
		case "invite":
			return { kind: "invite" };
		case "declare":
			return state.recovered !== null
				? { kind: "declare-recovered", recovered: state.recovered }
				: { kind: "declare" };
		case "pay":
			return payScreenOf(state);
	}
}

/** The pay step's seven panels, in precedence order. */
function payScreenOf(state: CreateOrgState): CreateOrgScreen {
	const { pending } = state;
	if (pending !== null && state.confirmingClose) return { kind: "confirm-close", pending };
	if (state.stopped !== null) return { kind: "stopped", message: state.stopped };
	if (pending !== null && state.slugClaimedAfterPayment) return { kind: "retry-new-slug", pending };
	if (pending !== null) return { kind: "retry-setup", pending, failed: state.needsSetupRetry };
	if (state.offer?.kind === "trial") return { kind: "trial" };
	if (state.clientSecret) return { kind: "checkout", clientSecret: state.clientSecret };
	return { kind: "no-intent" };
}

/** Every screen kind, for the transition table to prove it reaches each one. */
export const CREATE_ORG_SCREENS: readonly CreateOrgScreen["kind"][] = [
	"name",
	"declare-recovered",
	"declare",
	"invite",
	"confirm-close",
	"stopped",
	"retry-new-slug",
	"retry-setup",
	"trial",
	"checkout",
	"no-intent",
];

/** The steps in the order the wizard shows them (`create-org.wizard.ts`). */
export const CREATE_ORG_STEPS: readonly CreateOrgView[] = ["name", "declare", "pay", "invite"];

/** Whether a wizard step id is one of the sheet's four steps. */
export function isCreateOrgView(step: string): step is CreateOrgView {
	return CREATE_ORG_STEPS.some((view) => view === step);
}

/** What the payment step's gate says while a setup is finishing. */
export const SETUP_IN_FLIGHT_MESSAGE = "Your payment went through — setting up your team now.";

/**
 * What the payment gate can say from the machine alone: done once a setup finished (the sheet is on
 * `invite`), in flight while a paid setup is unfinished, stopped when a run or a hold ended it.
 * `null` when the machine knows nothing — the sheet then asks the server about what the tab held.
 */
export function settlementOf(state: CreateOrgState): Settlement | null {
	if (state.view === "invite") return { kind: "done", continueAt: "invite" };
	if (state.stopped !== null) return { kind: "stopped", message: state.stopped };
	if (state.pending !== null) return { kind: "in-flight", message: SETUP_IN_FLIGHT_MESSAGE };
	return null;
}

/**
 * The event a Back to `step` stands for on `screen`, or `null` when the URL may not move the sheet
 * there — after a charge, on a recovered or stopped setup, or past the screen in front. A Back the
 * machine refuses is undone in the URL; `pay` and `invite` are never reached this way.
 */
export function backEventFor(screen: CreateOrgScreen, step: CreateOrgView): CreateOrgEvent | null {
	switch (screen.kind) {
		case "declare":
			return step === "name" ? { type: "back-to-name" } : null;
		case "checkout":
		case "no-intent":
			if (step === "declare") return { type: "back-to-declare" };
			return step === "name" ? { type: "back-to-name" } : null;
		case "trial":
			// The trial skips the declaration, so a Back from its panel lands on the name.
			return step === "name" || step === "declare" ? { type: "back-to-name" } : null;
		default:
			return null;
	}
}
