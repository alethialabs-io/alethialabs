// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create-a-team sheet's transition table (WIZ-W7, #6930).
//
// Two tables, both exhaustive by construction:
//   - SCREENS: one row per `CreateOrgScreen` member, each a state that `screenOf` must map to it.
//     The last test checks the rows against `CREATE_ORG_SCREENS`, so a screen added to the union
//     without a row here fails.
//   - EVENTS: one row per `CreateOrgEvent` type, each a (from, event, expected change) triple. The
//     rows are keyed by event type in a `Record`, so an event added to the union without a row is a
//     type error, not a silent gap.
// The money-path rules the reducer keeps (refs survive Back, a confirmed charge is dropped only by
// a reset, invite only after a finished setup) each have their own case below the tables.

import { describe, expect, it } from "vitest";
import {
	CREATE_ORG_SCREENS,
	type CreateOrgEvent,
	type CreateOrgScreen,
	type CreateOrgState,
	type CreateOrgView,
	backEventFor,
	CREATE_ORG_STEPS,
	closeNeedsConfirmation,
	createOrgReducer,
	isCreateOrgView,
	settlementOf,
	SETUP_IN_FLIGHT_MESSAGE,
	INITIAL_CREATE_ORG_STATE,
	knownCurrency,
	type OpenedIntent,
	screenOf,
	setupUnfinished,
} from "@/components/org/create-org-machine";
import type { PaidSetupOutcome, PendingPaidSetup } from "@/components/org/pending-paid-setup";
import type { PayerDeclaration } from "@/components/billing/payer-declaration-form";
import type { NewOrgSetupState } from "@/lib/billing/new-org-setup";

const DECLARATION: PayerDeclaration = {
	capacity: "organization",
	billingCountry: "DE",
	authorityAttestation: "Director",
};

const RECORD: PendingPaidSetup = {
	subscriptionId: "sub_1",
	customerId: "cus_1",
	name: "Acme",
	slug: "acme",
	currency: "eur",
	declaration: { ...DECLARATION },
	billing: null,
	customerDetailsSaved: true,
	createdOrgId: null,
	createdSlug: "",
	linked: false,
	slugRefusal: null,
};

const INTENT: OpenedIntent = {
	subscriptionId: "sub_2",
	customerId: "cus_2",
	clientSecret: "pi_secret",
	currency: "eur",
	notice: null,
};

/** A server-side setup found with no record in this tab. */
function foundSetup(overrides: Partial<NewOrgSetupState> = {}): NewOrgSetupState {
	return {
		subscriptionId: "sub_9",
		customerId: "cus_9",
		paid: true,
		planState: "active",
		paymentUrl: null,
		hold: null,
		ended: null,
		name: "Found team",
		slug: "found-team",
		currency: "eur",
		billing: null,
		org: null,
		linked: false,
		declared: false,
		...overrides,
	};
}

/** The initial state with `patch` applied. */
function at(patch: Partial<CreateOrgState>): CreateOrgState {
	return { ...INITIAL_CREATE_ORG_STATE, ...patch };
}

/** Runs `events` from `from`, in order. */
function run(from: CreateOrgState, ...events: CreateOrgEvent[]): CreateOrgState {
	return events.reduce(createOrgReducer, from);
}

const SCREENS: ReadonlyArray<readonly [CreateOrgScreen["kind"], CreateOrgState]> = [
	["name", at({})],
	["declare-recovered", at({ view: "declare", recovered: foundSetup() })],
	["declare", at({ view: "declare" })],
	["invite", at({ view: "invite" })],
	["confirm-close", at({ view: "pay", pending: RECORD, confirmingClose: true, stopped: "x" })],
	["stopped", at({ view: "pay", stopped: "Held.", pending: RECORD, slugClaimedAfterPayment: true })],
	["retry-new-slug", at({ view: "pay", pending: RECORD, slugClaimedAfterPayment: true })],
	["retry-setup", at({ view: "pay", pending: RECORD, offer: { kind: "trial" }, clientSecret: "s" })],
	["trial", at({ view: "pay", offer: { kind: "trial" }, clientSecret: "s" })],
	["checkout", at({ view: "pay", offer: { kind: "none" }, clientSecret: "s" })],
	["no-intent", at({ view: "pay" })],
];

describe("screenOf — one row per screen, in the sheet's precedence order", () => {
	it.each(SCREENS)("%s", (kind, state) => {
		expect(screenOf(state).kind).toBe(kind);
	});

	it("has a row for every screen the union names", () => {
		expect(SCREENS.map(([kind]) => kind).sort()).toEqual([...CREATE_ORG_SCREENS].sort());
	});

	it("says whether a running setup failed", () => {
		const running = screenOf(at({ view: "pay", pending: RECORD }));
		const failed = screenOf(at({ view: "pay", pending: RECORD, needsSetupRetry: true }));
		expect(running).toEqual({ kind: "retry-setup", pending: RECORD, failed: false });
		expect(failed).toEqual({ kind: "retry-setup", pending: RECORD, failed: true });
	});
});

const DONE: PaidSetupOutcome = {
	kind: "done",
	orgId: "org_1",
	slug: "acme",
	planState: "processing",
	paymentUrl: null,
	subscriptionId: "sub_1",
	customerId: "cus_1",
};

type Row = {
	readonly from: CreateOrgState;
	readonly event: CreateOrgEvent;
	readonly expect: Partial<CreateOrgState>;
	readonly screen: CreateOrgScreen["kind"];
};

/** One row per event type; the mapped type makes a missing one a compile error. */
const EVENTS: { readonly [K in CreateOrgEvent["type"]]: Row } = {
	"open-changed": {
		from: at({}),
		event: { type: "open-changed", key: "u1", finding: { kind: "nothing" } },
		expect: { openedFor: "u1", resume: null, recoverFrom: null },
		screen: "name",
	},
	"offer-resolved": {
		from: at({}),
		event: { type: "offer-resolved", offer: { kind: "trial", trialDays: 30 } },
		expect: { offer: { kind: "trial", trialDays: 30 } },
		screen: "name",
	},
	"slug-edited": {
		from: at({}),
		event: { type: "slug-edited" },
		expect: { slugTouched: true },
		screen: "name",
	},
	"url-editor-set": {
		from: at({}),
		event: { type: "url-editor-set", open: true },
		expect: { showUrl: true },
		screen: "name",
	},
	"busy-set": {
		from: at({}),
		event: { type: "busy-set", busy: true },
		expect: { busy: true },
		screen: "name",
	},
	"recovery-found": {
		from: at({ refusal: "old" }),
		event: { type: "recovery-found", state: foundSetup() },
		expect: {
			view: "declare",
			slugTouched: true,
			checkoutOrgName: "Found team",
			subscriptionId: "sub_9",
			customerId: "cus_9",
			currency: "eur",
			refusal: null,
		},
		screen: "declare-recovered",
	},
	"recovery-held": {
		from: at({}),
		event: { type: "recovery-held", notice: "A hold refuses this." },
		expect: { view: "pay", stopped: "A hold refuses this." },
		screen: "stopped",
	},
	"recovery-asked": {
		from: at({ recoverFrom: { kind: "none" } }),
		event: { type: "recovery-asked" },
		expect: { recoverFrom: null },
		screen: "name",
	},
	"refusal-set": {
		from: at({ view: "declare" }),
		event: { type: "refusal-set", message: "Not permitted." },
		expect: { refusal: "Not permitted." },
		screen: "declare",
	},
	"name-accepted": {
		from: at({ refusal: "old" }),
		event: { type: "name-accepted", name: "Acme", trial: false },
		expect: { view: "declare", checkoutOrgName: "Acme", refusal: null },
		screen: "declare",
	},
	"declare-started": {
		from: at({ view: "declare", refusal: "old" }),
		event: { type: "declare-started" },
		expect: { declaring: true, refusal: null },
		screen: "declare",
	},
	"declare-ended": {
		from: at({ view: "declare", declaring: true }),
		event: { type: "declare-ended" },
		expect: { declaring: false },
		screen: "declare",
	},
	"intent-opened": {
		from: at({ view: "declare", offer: { kind: "none" } }),
		event: { type: "intent-opened", intent: { ...INTENT, notice: "Earlier checkout." }, declaration: DECLARATION },
		expect: {
			view: "pay",
			subscriptionId: "sub_2",
			customerId: "cus_2",
			clientSecret: "pi_secret",
			currency: "eur",
			intentNotice: "Earlier checkout.",
			declaration: DECLARATION,
		},
		screen: "checkout",
	},
	"currency-switch-started": {
		from: at({ view: "pay", clientSecret: "s" }),
		event: { type: "currency-switch-started" },
		expect: { switchingCurrency: true },
		screen: "checkout",
	},
	"currency-switch-ended": {
		from: at({ view: "pay", clientSecret: "s", switchingCurrency: true }),
		event: { type: "currency-switch-ended" },
		expect: { switchingCurrency: false },
		screen: "checkout",
	},
	"currency-switched": {
		from: at({ view: "pay", clientSecret: "s", declaration: DECLARATION, intentNotice: "old" }),
		event: { type: "currency-switched", intent: { ...INTENT, currency: "usd", clientSecret: "pi_usd" } },
		expect: { clientSecret: "pi_usd", currency: "usd", intentNotice: null, declaration: DECLARATION, view: "pay" },
		screen: "checkout",
	},
	"back-to-name": {
		from: at({ view: "declare" }),
		event: { type: "back-to-name" },
		expect: { view: "name" },
		screen: "name",
	},
	"back-to-declare": {
		from: at({ view: "pay", clientSecret: "s", subscriptionId: "sub_2", customerId: "cus_2" }),
		event: { type: "back-to-declare" },
		expect: { view: "declare", clientSecret: null, subscriptionId: "sub_2", customerId: "cus_2" },
		screen: "declare",
	},
	"recovered-setup-adopted": {
		from: at({ view: "declare", recovered: foundSetup(), clientSecret: "s" }),
		event: { type: "recovered-setup-adopted", record: RECORD },
		expect: {
			view: "pay",
			recovered: null,
			pending: RECORD,
			clientSecret: null,
			subscriptionId: "sub_1",
			customerId: "cus_1",
			currency: "eur",
			checkoutOrgName: "Acme",
			declaration: RECORD.declaration,
		},
		screen: "retry-setup",
	},
	"trial-org-created": {
		from: at({ view: "pay", offer: { kind: "trial" } }),
		event: { type: "trial-org-created", orgId: "org_t", slug: "acme" },
		expect: { createdOrgId: "org_t", createdSlug: "acme" },
		screen: "trial",
	},
	"trial-org-rolled-back": {
		from: at({ view: "pay", offer: { kind: "trial" }, createdOrgId: "org_t", createdSlug: "acme" }),
		event: { type: "trial-org-rolled-back" },
		expect: { createdOrgId: null, createdSlug: "" },
		screen: "trial",
	},
	"trial-started": {
		from: at({ view: "pay", offer: { kind: "trial" }, paidPlan: { ...DONE, paymentUrl: null } }),
		event: { type: "trial-started" },
		expect: { view: "invite", isTrialOrg: true, paidPlan: null },
		screen: "invite",
	},
	// A Paddle checkout completed on the org created first (O2): a paid org, so not the trial's invite copy.
	"provider-paid": {
		from: at({ view: "declare", isTrialOrg: true, paidPlan: { ...DONE, paymentUrl: null } }),
		event: { type: "provider-paid" },
		expect: { view: "invite", isTrialOrg: false, paidPlan: null },
		screen: "invite",
	},
	"charge-confirmed": {
		from: at({ view: "pay", clientSecret: "s" }),
		event: { type: "charge-confirmed", record: RECORD },
		expect: { pending: RECORD },
		screen: "retry-setup",
	},
	"setup-started": {
		from: at({ view: "pay", pending: RECORD, needsSetupRetry: true, slugClaimedAfterPayment: true }),
		event: { type: "setup-started" },
		expect: { busy: true, needsSetupRetry: false, stopped: null, slugClaimedAfterPayment: false },
		screen: "retry-setup",
	},
	"setup-progressed": {
		from: at({ view: "pay", pending: RECORD, busy: true }),
		event: { type: "setup-progressed", record: { ...RECORD, customerDetailsSaved: true, createdOrgId: "org_1" } },
		expect: { pending: { ...RECORD, customerDetailsSaved: true, createdOrgId: "org_1" }, busy: true },
		screen: "retry-setup",
	},
	"setup-ended": {
		from: at({ view: "pay", pending: RECORD, busy: true }),
		event: { type: "setup-ended", outcome: DONE },
		expect: {
			view: "invite",
			busy: false,
			pending: null,
			createdOrgId: "org_1",
			createdSlug: "acme",
			isTrialOrg: false,
			paidPlan: { planState: "processing", paymentUrl: null, subscriptionId: "sub_1", customerId: "cus_1" },
		},
		screen: "invite",
	},
	"plan-reported": {
		from: at({ view: "invite", paidPlan: { planState: "processing", paymentUrl: null, subscriptionId: "sub_1", customerId: "cus_1" } }),
		event: { type: "plan-reported", subscriptionId: "sub_1", report: { planState: "active", paymentUrl: null } },
		expect: { paidPlan: { planState: "active", paymentUrl: null, subscriptionId: "sub_1", customerId: "cus_1" } },
		screen: "invite",
	},
	"close-requested": {
		from: at({ view: "pay", pending: RECORD }),
		event: { type: "close-requested" },
		expect: { confirmingClose: true },
		screen: "confirm-close",
	},
	"close-cancelled": {
		from: at({ view: "pay", pending: RECORD, confirmingClose: true }),
		event: { type: "close-cancelled" },
		expect: { confirmingClose: false },
		screen: "retry-setup",
	},
	"invite-email-changed": {
		from: at({ view: "invite" }),
		event: { type: "invite-email-changed", email: "a@b.co" },
		expect: { inviteEmail: "a@b.co" },
		screen: "invite",
	},
	"invite-role-changed": {
		from: at({ view: "invite" }),
		event: { type: "invite-role-changed", role: "admin" },
		expect: { inviteRole: "admin" },
		screen: "invite",
	},
	"invite-sent": {
		from: at({ view: "invite", inviteEmail: "a@b.co", sent: [{ email: "x@y.co", role: "operator" }] }),
		event: { type: "invite-sent", invite: { email: "a@b.co", role: "admin" } },
		expect: {
			inviteEmail: "",
			sent: [
				{ email: "x@y.co", role: "operator" },
				{ email: "a@b.co", role: "admin" },
			],
		},
		screen: "invite",
	},
	reset: {
		from: at({ view: "pay", pending: RECORD, busy: true, slugTouched: true, showUrl: true, inviteEmail: "a" }),
		event: { type: "reset" },
		expect: { view: "name", pending: null, busy: false, slugTouched: false, showUrl: false, inviteEmail: "" },
		screen: "name",
	},
};

describe("createOrgReducer — one row per event", () => {
	it.each(Object.entries(EVENTS))("%s", (_type, row) => {
		const next = createOrgReducer(row.from, row.event);
		expect(next).toMatchObject(row.expect);
		expect(screenOf(next).kind).toBe(row.screen);
	});

	it("never mutates the state it is given", () => {
		for (const row of Object.values(EVENTS)) {
			const before = structuredClone({ ...row.from, resume: null });
			createOrgReducer({ ...row.from, resume: null }, row.event);
			expect({ ...row.from, resume: null }).toEqual(before);
		}
	});
});

describe("open transition", () => {
	it("restores a record into the pay step, offering a retry when no run is in flight", () => {
		const next = run(
			at({}),
			{ type: "open-changed", key: "u1", finding: { kind: "record", resume: { record: RECORD, running: undefined } } },
		);
		expect(next).toMatchObject({
			view: "pay",
			slugTouched: true,
			pending: RECORD,
			subscriptionId: "sub_1",
			customerId: "cus_1",
			currency: "eur",
			needsSetupRetry: true,
			busy: false,
		});
		expect(screenOf(next)).toEqual({ kind: "retry-setup", pending: RECORD, failed: true });
	});

	it("attaches to a run still in flight: busy, and no retry offered", () => {
		const running = Promise.resolve(DONE);
		const next = run(at({}), {
			type: "open-changed",
			key: "u1",
			finding: { kind: "record", resume: { record: RECORD, running } },
		});
		expect(next).toMatchObject({ busy: true, needsSetupRetry: false });
		expect(next.resume?.running).toBe(running);
	});

	it("restarts a record a run stopped for support, without replaying its sentence", () => {
		const stoppedRecord = { ...RECORD, stopped: "Contact support.", slugRefusal: "Taken." };
		const next = run(at({}), {
			type: "open-changed",
			key: "u1",
			finding: { kind: "record", resume: { record: stoppedRecord, running: undefined } },
		});
		expect(next).toMatchObject({ busy: true, needsSetupRetry: false, stopped: null, slugClaimedAfterPayment: false });
	});

	it("asks for a new slug when the record says the slug was refused after payment", () => {
		const next = run(at({}), {
			type: "open-changed",
			key: "u1",
			finding: { kind: "record", resume: { record: { ...RECORD, slugRefusal: "Taken." }, running: undefined } },
		});
		expect(screenOf(next).kind).toBe("retry-new-slug");
	});

	it("hands what the tab held to the recovery effect when no record is usable", () => {
		const next = run(at({}), {
			type: "open-changed",
			key: "u1",
			finding: { kind: "no-record", stored: { kind: "unreadable", ids: null } },
		});
		expect(next).toMatchObject({ view: "name", recoverFrom: { kind: "unreadable", ids: null }, resume: null });
	});

	it("a later open transition drops the previous one's resume and recovery", () => {
		const opened = run(at({}), {
			type: "open-changed",
			key: "u1",
			finding: { kind: "no-record", stored: { kind: "none" } },
		});
		const closed = run(opened, { type: "open-changed", key: null, finding: { kind: "nothing" } });
		expect(closed).toMatchObject({ openedFor: null, recoverFrom: null, resume: null });
	});
});

describe("setup-ended — every outcome", () => {
	const running = at({ view: "pay", pending: RECORD, busy: true });

	it("a slug refused after payment asks for a new slug, keeping the record", () => {
		const record = { ...RECORD, createdSlug: "", slugRefusal: "Taken." };
		const next = createOrgReducer(running, {
			type: "setup-ended",
			outcome: { kind: "slug-refused", message: "Taken.", record },
		});
		expect(next).toMatchObject({ busy: false, pending: record, slugClaimedAfterPayment: true, needsSetupRetry: true });
		expect(screenOf(next).kind).toBe("retry-new-slug");
	});

	it("a retryable failure offers the retry, with the org the run got as far as creating", () => {
		const record = { ...RECORD, createdOrgId: "org_1", createdSlug: "acme" };
		const next = createOrgReducer(running, {
			type: "setup-ended",
			outcome: { kind: "failed", message: "x", record, retryable: true, recordCleared: false },
		});
		expect(next).toMatchObject({ pending: record, createdOrgId: "org_1", createdSlug: "acme", needsSetupRetry: true });
		expect(screenOf(next)).toEqual({ kind: "retry-setup", pending: record, failed: true });
	});

	it("a final failure stops with its sentence and no retry; a cleared record needs no close confirmation", () => {
		const next = createOrgReducer(running, {
			type: "setup-ended",
			outcome: { kind: "failed", message: "Refused.", record: RECORD, retryable: false, recordCleared: true },
		});
		expect(next).toMatchObject({ pending: null, stopped: "Refused.", needsSetupRetry: false, busy: false });
		expect(screenOf(next).kind).toBe("stopped");
		expect(closeNeedsConfirmation(next)).toBe(false);
	});

	it("a final failure that kept its record still needs no close confirmation — it is stopped", () => {
		const next = createOrgReducer(running, {
			type: "setup-ended",
			outcome: { kind: "failed", message: "Support.", record: RECORD, retryable: false, recordCleared: false },
		});
		expect(next.pending).toEqual(RECORD);
		expect(closeNeedsConfirmation(next)).toBe(false);
		expect(setupUnfinished(next)).toBe(false);
	});
});

describe("money-path rules", () => {
	it("the payment refs survive Back to the declaration and to the name, so a retry re-uses them", () => {
		const paying = run(
			at({ offer: { kind: "none" } }),
			{ type: "name-accepted", name: "Acme", trial: false },
			{ type: "intent-opened", intent: INTENT, declaration: DECLARATION },
			{ type: "back-to-declare" },
			{ type: "back-to-name" },
		);
		expect(paying).toMatchObject({ subscriptionId: "sub_2", customerId: "cus_2", clientSecret: null });
	});

	it("a declaration refusal keeps the refs too", () => {
		const refused = run(
			at({ view: "declare", subscriptionId: "sub_2", customerId: "cus_2" }),
			{ type: "declare-started" },
			{ type: "refusal-set", message: "No." },
			{ type: "declare-ended" },
		);
		expect(refused).toMatchObject({ subscriptionId: "sub_2", customerId: "cus_2", refusal: "No.", declaring: false });
	});

	it("a confirmed charge is dropped only by a finished setup, a final stop or a reset", () => {
		const charged = run(at({ view: "pay", clientSecret: "s" }), { type: "charge-confirmed", record: RECORD });
		const keeping: CreateOrgEvent[] = [
			{ type: "back-to-declare" },
			{ type: "back-to-name" },
			{ type: "close-requested" },
			{ type: "close-cancelled" },
			{ type: "setup-started" },
			{ type: "busy-set", busy: false },
			{ type: "currency-switched", intent: INTENT },
			{ type: "open-changed", key: "u1", finding: { kind: "nothing" } },
		];
		const kept = keeping.map((event) => [event.type, createOrgReducer(charged, event).pending]);
		expect(kept).toEqual(keeping.map((event) => [event.type, RECORD]));
		expect(createOrgReducer(charged, { type: "reset" }).pending).toBeNull();
	});

	it("a close asks first while a setup is unfinished, and only once", () => {
		const charged = at({ view: "pay", pending: RECORD });
		expect(closeNeedsConfirmation(charged)).toBe(true);
		expect(setupUnfinished(charged)).toBe(true);
		expect(closeNeedsConfirmation(createOrgReducer(charged, { type: "close-requested" }))).toBe(false);
		expect(closeNeedsConfirmation(at({}))).toBe(false);
	});

	it("invite is reached only from a finished setup", () => {
		const reached = Object.entries(EVENTS).flatMap(([type, row]) => {
			const from: CreateOrgState = { ...row.from, view: row.from.view === "invite" ? "pay" : row.from.view };
			return createOrgReducer(from, row.event).view === "invite" ? [type] : [];
		});
		// `provider-paid`: Paddle reported the checkout complete on an org that already exists (O2) — the
		// merchant of record's own "finished", with no setup steps of ours left to run.
		expect(reached.sort()).toEqual(["provider-paid", "setup-ended", "trial-started"]);
	});

	it("a trial-eligible account skips the declaration", () => {
		const next = run(at({ offer: { kind: "trial" } }), { type: "name-accepted", name: "Acme", trial: true });
		expect(next.view).toBe("pay");
		expect(screenOf(next).kind).toBe("trial");
		expect(next.checkoutOrgName).toBe("");
	});

	it("a plan report for another charge is ignored", () => {
		const paid = at({ paidPlan: { planState: "processing", paymentUrl: null, subscriptionId: "sub_1", customerId: "cus_1" } });
		const next = createOrgReducer(paid, {
			type: "plan-reported",
			subscriptionId: "sub_other",
			report: { planState: "active", paymentUrl: null },
		});
		expect(next).toBe(paid);
	});

	it("reset keeps the open bookkeeping, the offer and the intent's currency and name, and clears everything typed or paid", () => {
		const used = at({
			view: "invite",
			openedFor: "u1",
			offer: { kind: "trial" },
			currency: "eur",
			checkoutOrgName: "Acme",
			subscriptionId: "sub_1",
			customerId: "cus_1",
			clientSecret: "s",
			declaration: DECLARATION,
			createdOrgId: "org_1",
			createdSlug: "acme",
			isTrialOrg: true,
			sent: [{ email: "a@b.co", role: "admin" }],
			inviteRole: "admin",
		});
		expect(createOrgReducer(used, { type: "reset" })).toEqual({
			...INITIAL_CREATE_ORG_STATE,
			openedFor: "u1",
			offer: { kind: "trial" },
			currency: "eur",
			checkoutOrgName: "Acme",
		});
	});
});

describe("knownCurrency", () => {
	it("passes a currency this console sells in and refuses anything else", () => {
		expect(knownCurrency("eur")).toBe("eur");
		expect(knownCurrency("jpy")).toBeNull();
		expect(knownCurrency(null)).toBeNull();
	});
});

describe("recovery-found", () => {
	it("keeps the current currency when the server's is not one this console sells in", () => {
		const next = createOrgReducer(at({ currency: "eur" }), {
			type: "recovery-found",
			state: foundSetup({ currency: "jpy" }),
		});
		expect(next.currency).toBe("eur");
	});
});

describe("settlementOf — what the payment gate can say from the machine alone", () => {
	it("is done once the sheet is on invite, so the URL may follow it there", () => {
		expect(settlementOf(at({ view: "invite" }))).toEqual({ kind: "done", continueAt: "invite" });
	});

	it("is in flight while a paid setup is unfinished", () => {
		expect(settlementOf(at({ view: "pay", pending: RECORD }))).toEqual({
			kind: "in-flight",
			message: SETUP_IN_FLIGHT_MESSAGE,
		});
	});

	it("is stopped with the run's or the hold's sentence", () => {
		expect(settlementOf(at({ view: "pay", stopped: "Held.", pending: RECORD }))).toEqual({
			kind: "stopped",
			message: "Held.",
		});
	});

	it("knows nothing before a charge — the sheet asks the tab and the server", () => {
		expect(settlementOf(at({}))).toBeNull();
		expect(settlementOf(at({ view: "pay", clientSecret: "s" }))).toBeNull();
	});
});

const PAY_AND_INVITE: readonly CreateOrgView[] = ["pay", "invite"];

describe("backEventFor — which Backs the URL may make", () => {
	const ALLOWED: ReadonlyArray<readonly [CreateOrgScreen["kind"], CreateOrgState, string, string]> = [
		["declare", at({ view: "declare" }), "name", "back-to-name"],
		["checkout", at({ view: "pay", clientSecret: "s" }), "declare", "back-to-declare"],
		["checkout", at({ view: "pay", clientSecret: "s" }), "name", "back-to-name"],
		["no-intent", at({ view: "pay" }), "declare", "back-to-declare"],
		["trial", at({ view: "pay", offer: { kind: "trial" } }), "name", "back-to-name"],
		["trial", at({ view: "pay", offer: { kind: "trial" } }), "declare", "back-to-name"],
	];

	it.each(ALLOWED)("%s → %s on Back to %s", (kind, state, step, event) => {
		expect(screenOf(state).kind).toBe(kind);
		if (!isCreateOrgView(step)) throw new Error(step);
		expect(backEventFor(screenOf(state), step)?.type).toBe(event);
	});

	it("refuses every Back once a charge is confirmed, a setup is recovered or stopped, or from invite", () => {
		const refusing = SCREENS.filter(([kind]) =>
			["declare-recovered", "invite", "confirm-close", "stopped", "retry-new-slug", "retry-setup", "name"].includes(kind),
		);
		const allowed = refusing.flatMap(([kind, state]) =>
			CREATE_ORG_STEPS.flatMap((step) => (backEventFor(screenOf(state), step) === null ? [] : [`${kind}>${step}`])),
		);
		expect(allowed).toEqual([]);
	});

	it("never moves forward: no Back reaches pay or invite", () => {
		const forward = SCREENS.flatMap(([kind, state]) =>
			PAY_AND_INVITE.flatMap((step) =>
				backEventFor(screenOf(state), step) === null ? [] : [`${kind}>${step}`],
			),
		);
		expect(forward).toEqual([]);
	});
});
