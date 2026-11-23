"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Create a paid Pro organization — a two-column purchase modal:
//   • LEFT (persistent): the "What's included" checklist (PlanChecklist).
//   • RIGHT (progressive): State 1 = team name → State 2 = the payer declaration → State 3 =
//     the shared BillingCheckoutForm (split-card payment). Then a fourth "invite" view after
//     the org exists.
//
// THE DECLARATION STEP EXISTS BECAUSE THIS PATH HAS NO ROW TO READ IT FROM (#4633). Every other
// conversion reads `organization_billing.payer_capacity`; here the organization does not exist
// yet, so `createNewOrgSubscriptionIntent` takes the payer facts as a PARAMETER — one this sheet
// never passed, which refused every create-a-paid-team attempt at the eligibility gate. They are
// declared before the intent, carried through payment, persisted by `linkSubscriptionToNewOrg`,
// and completed with the authority attestation by `declarePayer` once the org exists.
//
// The TRIAL branch is deliberately untouched: a card-less trial is not a paid conversion, does
// not pass the gate, and has no purchase for a declaration to be made at the moment of.
// The org is created ONLY after the card is confirmed (deferred create:
// createNewOrgSubscriptionIntent → confirmCardPayment → linkSubscriptionToNewOrg), so a
// Stripe failure can never orphan an org. If the account still holds its one trial, a
// card-less "Start trial" path creates a solo trial org instead (trials can't invite).
// The two-column shell, invite view, and small form primitives are shared with the
// upgrade-org sheet via ./org-purchase-ui. Everything the sheet remembers besides its form is one
// pure reducer, ./create-org-machine.ts, and which panel is on screen is that file's `screenOf`.

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useReducer, useRef } from "react";
import { type UseFormReturn, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	createNewOrgSubscriptionIntent,
	getProOffer,
	isOrgSlugAvailable,
	saveNewOrgSetupDetails,
	startProTrial,
} from "@/app/server/actions/billing";
import { payerConversionStatus } from "@/app/server/actions/legal";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import {
	BillingCheckoutForm,
	type CheckoutRefusal,
	type CollectedBilling,
	checkoutFieldOf,
} from "@/components/billing/billing-checkout-form";
import {
	PayerDeclarationForm,
	type PayerDeclaration,
} from "@/components/billing/payer-declaration-form";
import {
	type CreateOrgEvent,
	type CreateOrgScreen,
	type CreateOrgState,
	closeNeedsConfirmation,
	createOrgReducer,
	INITIAL_CREATE_ORG_STATE,
	knownCurrency,
	type OpenFinding,
	screenOf,
	setupUnfinished,
} from "@/components/org/create-org-machine";
import {
	Field,
	InviteView,
	isValidInviteEmail,
	PurchaseLayout,
} from "@/components/org/org-purchase-ui";
import {
	finishPaidSetup,
	type PaidSetupOutcome,
	paidSetupInFlight,
	pendingPaidSetupInPageOnly,
	type PendingPaidSetup,
	readStoredPaidSetup,
	recoverUnfinishedPaidSetup,
	SLUG_TAKEN,
	pollSettlingPlanState,
	watchPaidSetup,
	writePendingPaidSetup,
} from "@/components/org/pending-paid-setup";
import type { NewOrgSetupState } from "@/lib/billing/new-org-setup";
import { ORG_SLUG_MAX, tooLongMessage } from "@/lib/billing/billing-field-caps";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { CurrencyToggle } from "@/components/billing/currency-toggle";
import { authClient } from "@/lib/auth/client";
import { useViewer } from "@/components/providers/viewer-provider";
import { track } from "@/lib/analytics/track";
import { useLivePlanPrice } from "@/lib/billing/use-live-plan-price";
import { orgHost } from "@/lib/org-url";
import {
	ORG_SLUG_RESERVED_CODE,
	ORG_SLUG_RESERVED_MESSAGE,
	globalHref,
	RESERVED_SLUGS,
} from "@/lib/routing";
import { finishSlugDraft, slugifyDraft, slugifyOrEmpty } from "@/lib/utils/slugify";
import { ORG_SLUG_PATTERN } from "@repo/org-slug";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { type SupportedCurrency, planMeta } from "@repo/plan-catalog";
import { Alert, AlertDescription } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@repo/ui/sheet";

/** The sentence for a slug a console route or sibling app owns — `configureOnboardingOrg`'s, the
 *  Settings rename's and the server-side organization hooks' too (one constant, lib/routing.ts). */
const SLUG_RESERVED = ORG_SLUG_RESERVED_MESSAGE;

const schema = z.object({
	name: z.string().trim().min(2, "Give your team a name."),
	slug: z
		.string()
		.trim()
		// The field holds a DRAFT while it is typed into (`slugifyDraft`, #5453): `acme-` is the state
		// it is in between `acme` and `acme-cloud`. The checks below judge the slug that draft will be
		// submitted as, so a half-typed hyphen is not refused mid-word. `commitSlug` writes the same
		// finished value back into the form before anything reads it with `getValues`.
		.transform(finishSlugDraft)
		.pipe(
			z
				.string()
				.min(1, "Pick a slug.")
				// The server's cap for the slug it records with a paid setup (billing-field-caps.ts).
				.max(ORG_SLUG_MAX, tooLongMessage(ORG_SLUG_MAX))
				.regex(ORG_SLUG_PATTERN, "Lowercase letters, numbers and hyphens.")
				// Checked HERE, not left to `isOrgSlugAvailable`: that action answers one boolean for both
				// "reserved" and "taken", so a reserved slug ("docs") used to be refused as TAKEN — a
				// sentence that sends the user looking for an organization that does not exist (#5442).
				// RESERVED_SLUGS is the same set the action and `configureOnboardingOrg` consult, so the
				// two cannot disagree.
				.refine((s) => !RESERVED_SLUGS.has(s), SLUG_RESERVED),
		),
});
type FormData = z.infer<typeof schema>;

/**
 * Writes the finished slug — the typed draft without a dash at either end (#5453) — back into the
 * form. The schema judges that finished value, but `getValues` returns what is stored, and several
 * steps send `getValues().slug` to the server (the availability check, the intent, the saved setup).
 * Run on the slug field's blur and before every validation that precedes one of those reads.
 */
function commitSlug(form: UseFormReturn<FormData>) {
	const draft = form.getValues("slug");
	const finished = finishSlugDraft(draft.trim());
	if (finished !== draft) form.setValue("slug", finished, { shouldValidate: true });
}

interface CreateOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/** The fields the sheet renders from. */
const WATCHED = ["name", "slug"] as const;

/** The create-a-team sheet: name, payer declaration, payment or trial, then invites. */
export function CreateOrgSheet({ open, onOpenChange }: CreateOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const { viewer } = useViewer();
	const ownerEmail = viewer?.email ?? "";
	const viewerId = viewer?.id ?? "";

	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", slug: "" },
		mode: "onChange",
	});
	const [name, slug] = useWatch({ control: form.control, name: WATCHED });

	// Everything but the form, as one reducer (create-org-machine.ts): the steps, the payment refs,
	// the post-payment run's outcome and the invite list. What is on screen is `screenOf(state)`.
	const [state, dispatch] = useReducer(createOrgReducer, INITIAL_CREATE_ORG_STATE);
	const {
		view,
		offer,
		busy,
		clientSecret,
		customerId,
		subscriptionId,
		currency,
		switchingCurrency,
		checkoutOrgName,
		declaration,
		declaring,
		recovered,
		pending,
		createdSlug,
		createdOrgId,
		paidPlan,
		inviteEmail,
		inviteRole,
	} = state;
	const screen = screenOf(state);
	// A refusal is about the declaration that produced it; an edit to any declared fact drops it (F031).
	const clearRefusal = useCallback(() => dispatch({ type: "refusal-set", message: null }), []);
	/**
	 * Bumped by every `reset()`. A run of the post-payment steps outlives a closed sheet on purpose
	 * (its progress is persisted either way); this is what stops it writing its OUTCOME into a sheet
	 * that has since been closed or reopened — a reopened sheet attaches to the run instead.
	 */
	const generation = useRef(0);

	const meta = planMeta("team");
	const teamPrice = useLivePlanPrice("team", currency);

	// Resolve the account's Pro offer (trial vs pay) when the sheet opens.
	useEffect(() => {
		if (!open) return;
		let active = true;
		getProOffer()
			.then((o) => active && dispatch({ type: "offer-resolved", offer: o }))
			.catch(() => active && dispatch({ type: "offer-resolved", offer: { kind: "none" } }));
		return () => {
			active = false;
		};
	}, [open]);

	// Reopening the sheet resumes a pending paid setup instead of starting a new purchase — at the
	// first step the record says has not completed (each run re-checks that with the server). Only
	// when nothing is in flight in memory: an open intent of this session wins. A run still in flight
	// from before the close is ATTACHED to, never started a second time beside it.
	//
	// The open transition is handled while rendering, against the viewer it was last handled for
	// (`null` while closed, so a mount that is already open is handled too). The sheet is closed on the
	// server render, so the storage read here only ever runs in the browser. With a usable record the
	// sheet's state is restored at once and `resume` hands the record to the resume effect; without
	// one, `recoverFrom` hands what the tab holds to the recovery effect, which asks the SERVER whether
	// this user has a paid setup that never finished — a charge must not be offered a second purchase
	// because one tab lost its copy.
	const openedKey = open && viewerId ? viewerId : null;
	// The resume whose run (or attach) has started — see the resume effect.
	const startedFor = useRef<typeof state.resume>(null);
	if (openedKey !== state.openedFor) {
		let finding: OpenFinding = { kind: "nothing" };
		if (openedKey !== null && !subscriptionId) {
			const stored = readStoredPaidSetup(openedKey);
			finding =
				stored.kind === "ok"
					? {
							kind: "record",
							resume: {
								record: stored.record,
								running: paidSetupInFlight(stored.record.subscriptionId),
							},
						}
					: { kind: "no-record", stored };
		}
		dispatch({ type: "open-changed", key: openedKey, finding });
	}

	/**
	 * Opens the recovery step for a paid setup the server found with no record in this tab — with the
	 * slug the customer chose, from the server's record, on screen to confirm or change.
	 */
	function beginRecovery(found: NewOrgSetupState) {
		const slugIntent = found.org?.slug || found.slug || slugifyOrEmpty(found.name);
		form.reset({ name: found.name, slug: slugIntent });
		dispatch({ type: "recovery-found", state: found });
	}

	/**
	 * The recovered setup, declared again: checks the URL (when the team does not exist yet) and asks
	 * the gate about the new declaration — exactly as a purchase would — then builds the record from
	 * the server's state and runs the steps. The billing details the server kept (tax id, "use as the
	 * team's address") are re-sent to the Stripe customer; that write replaces, so a repeat is harmless.
	 */
	async function finishRecovered(next: PayerDeclaration) {
		if (!recovered || busy) return;
		dispatch({ type: "busy-set", busy: true });
		dispatch({ type: "refusal-set", message: null });
		try {
			// The URL is the one field on screen when the team does not exist yet; the name is the
			// server's and is not re-checked here.
			if (!recovered.org) {
				commitSlug(form);
				if (!(await form.trigger("slug"))) return;
				if (!(await isOrgSlugAvailable(form.getValues().slug))) {
					form.setError("slug", { message: SLUG_TAKEN });
					return;
				}
			}
			const verdict = await payerConversionStatus(next);
			if (!verdict.allowed) {
				dispatch({ type: "refusal-set", message: verdict.message });
				return;
			}
		} catch (e) {
			dispatch({
				type: "refusal-set",
				message: e instanceof Error ? e.message : "Couldn't check the declaration — try again.",
			});
			return;
		} finally {
			dispatch({ type: "busy-set", busy: false });
		}
		await runRecovered(recovered, next);
	}

	/**
	 * Builds the record for a setup the SERVER found (recovered on open, or found paid when this sheet
	 * asked to replace it) from the server's state and this declaration, and runs the steps on it.
	 *
	 * The team's NAME is the server's — the one the charge was taken under and the Stripe customer
	 * carries — never what the form holds now: after "← Back" the form may hold an edited name, and a
	 * team created under it would disagree with its own customer. The form is reset to it so the screen
	 * says what is being created. The slug is the form's: the customer may have chosen another since,
	 * and one the create refuses comes back as a field error for them to change.
	 */
	async function runRecovered(found: NewOrgSetupState, next: PayerDeclaration) {
		const values = form.getValues();
		if (values.name !== found.name) form.setValue("name", found.name);
		const record: PendingPaidSetup = {
			subscriptionId: found.subscriptionId,
			customerId: found.customerId,
			name: found.name,
			slug: values.slug,
			currency: knownCurrency(found.currency) ?? currency,
			declaration: next,
			billing: found.billing,
			customerDetailsSaved: found.billing === null,
			createdOrgId: found.org?.id ?? null,
			createdSlug: found.org?.slug ?? "",
			linked: found.linked,
			slugRefusal: null,
		};
		writePendingPaidSetup(viewerId, record);
		dispatch({ type: "recovered-setup-adopted", record });
		await runSetup(record);
	}

	/**
	 * The server found the attempt this sheet asked to replace already PAID — Stripe took the charge,
	 * and the confirmation never reached this page. Nothing new was minted; the setup is finished on
	 * that charge, and the customer is told so rather than being asked to pay again.
	 */
	async function resumePaidPrior(found: NewOrgSetupState, next: PayerDeclaration) {
		toast.info(
			`Your earlier payment for "${found.name}" went through. Finishing the setup of that team with it.`,
		);
		await runRecovered(found, next);
	}

	/**
	 * Saves the slug and the billing details on the server's record of this setup BEFORE the card is
	 * confirmed (#5445), so a crash or a closed tab after the charge cannot lose them. A refusal is
	 * returned to the checkout form, which shows it and does not charge.
	 */
	async function saveDetailsBeforeCharge(billing: CollectedBilling): Promise<CheckoutRefusal | null> {
		if (!subscriptionId) {
			return { field: null, message: "This checkout lost its reference — go back and try again." };
		}
		const saved = await saveNewOrgSetupDetails({
			subscriptionId,
			slug: form.getValues().slug,
			billing,
		});
		if (saved.ok) return null;
		const [first] = saved.refused;
		if (!first) return null;
		const field = checkoutFieldOf(first.field);
		return {
			field,
			message: field ? first.message : `Team URL: ${first.message}`,
		};
	}

	// Closing the TAB is outside the sheet's reach and outside sessionStorage's scope, so while a paid
	// setup is unfinished — running or failed — the browser is asked to confirm leaving the page. Not
	// while a final stop is shown (`stopped`, which a held recovery also sets): nothing in this tab can
	// finish that setup, so leaving loses nothing.
	const unfinished = setupUnfinished(state);
	useEffect(() => {
		if (!unfinished) return;
		/** Asks the browser to confirm leaving while a paid setup is unfinished. */
		const warn = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [unfinished]);

	// While this sheet is open on a paid setup, it is the one that renders the setup's outcome; a run
	// that ends with no sheet watching toasts it instead (`finishPaidSetup`).
	const unwatch = useRef<(() => void) | null>(null);
	const watchedSubscription = open ? pending?.subscriptionId : undefined;
	useEffect(() => {
		if (!watchedSubscription) return;
		const stop = watchPaidSetup(watchedSubscription);
		unwatch.current = stop;
		return () => {
			stop();
			if (unwatch.current === stop) unwatch.current = null;
		};
	}, [watchedSubscription]);

	// A paid setup that finished while its payment was still settling re-reads the server for a
	// minute, so the badge flips to active when Stripe settles the invoice (#5522). Armed once per
	// charge — the poll follows later answers itself, so its one-minute bound is never re-started.
	const settlingSub = open && paidPlan ? paidPlan.subscriptionId : null;
	const settlingCustomer = paidPlan?.customerId ?? null;
	const armedState = useRef(paidPlan?.planState ?? null);
	// Kept current after commit, never during render; this effect runs before the poll's below.
	useEffect(() => {
		armedState.current = paidPlan?.planState ?? null;
	});
	useEffect(() => {
		const initial = armedState.current;
		if (!settlingSub || !settlingCustomer || !initial) return;
		return pollSettlingPlanState(
			{ subscriptionId: settlingSub, customerId: settlingCustomer },
			initial,
			(report) => dispatch({ type: "plan-reported", subscriptionId: settlingSub, report }),
		);
	}, [settlingSub, settlingCustomer]);

	/** Clears the sheet for its next open: the form, and the reducer back to its initial state. */
	function reset() {
		generation.current += 1;
		// Unregistered NOW, not on the next render: a run ending in between must see no sheet
		// watching, or its outcome would be dropped instead of toasted.
		unwatch.current?.();
		unwatch.current = null;
		form.reset({ name: "", slug: "" });
		dispatch({ type: "reset" });
	}

	/**
	 * Opens or closes the sheet. A close while a paid setup is unfinished is held for confirmation
	 * (see `confirmingClose`), unless a run stopped it for good (`stopped`): the confirmation says the
	 * setup picks up where it left off, which is not true then. Every other close resets the sheet.
	 */
	function handleOpenChange(next: boolean) {
		if (!next && closeNeedsConfirmation(state)) {
			dispatch({ type: "close-requested" });
			return;
		}
		if (!next) reset();
		onOpenChange(next);
	}

	/**
	 * The confirmed close of an unfinished paid setup. The record stays in sessionStorage (written
	 * before the first step and after each one), and a run still in flight keeps running and keeps
	 * writing it, so reopening the sheet in this tab resumes at the first unfinished step.
	 */
	function closeKeepingPaidSetup() {
		reset();
		onOpenChange(false);
	}

	/** Close the sheet and drop the user into their new organization. */
	function goToOrg() {
		fetchWorkspace();
		handleOpenChange(false);
		if (createdSlug) router.push(`/${createdSlug}`);
		else router.refresh();
	}

	/**
	 * Validate the form + slug availability before any Stripe / org work. A refused slug opens the
	 * URL editor, so the field the sentence is about is on screen to change — an auto-derived slug
	 * is otherwise only a line of preview text under the name.
	 */
	async function validate(): Promise<FormData | null> {
		commitSlug(form);
		if (!(await form.trigger())) {
			if (form.getFieldState("slug").invalid) dispatch({ type: "url-editor-set", open: true });
			return null;
		}
		const data = form.getValues();
		if (!(await isOrgSlugAvailable(data.slug))) {
			form.setError("slug", { message: SLUG_TAKEN });
			dispatch({ type: "url-editor-set", open: true });
			return null;
		}
		return data;
	}

	/**
	 * Creates the TRIAL org (with the chosen slug) and scopes the session to it. Returns the
	 * id + persisted slug, or null when the slug collided (error surfaced inline). The paid path
	 * creates its org in `finishPaidSetup`, which persists the id before anything else runs.
	 */
	async function createOrg(
		data: FormData,
	): Promise<{ id: string; slug: string } | null> {
		const { data: org, error } = await authClient.organization.create({
			name: data.name,
			slug: data.slug,
		});
		if (error || !org) {
			// The server's reserved-slug hook (ee/) answers with its own code: say RESERVED, not taken.
			// Checked first because its sentence contains "slug", which the pattern below would read
			// as a collision.
			if (error?.code === ORG_SLUG_RESERVED_CODE) {
				form.setError("slug", { message: SLUG_RESERVED });
				dispatch({ type: "url-editor-set", open: true });
				return null;
			}
			if (/slug|unique|exist|taken/i.test(error?.message ?? "")) {
				form.setError("slug", { message: SLUG_TAKEN });
				dispatch({ type: "url-editor-set", open: true });
				return null;
			}
			throw new Error(error?.message ?? "Couldn't create the organization");
		}
		const persisted = org.slug ?? data.slug;
		dispatch({ type: "trial-org-created", orgId: org.id, slug: persisted });
		await setActiveOrganization(org.id);
		return { id: org.id, slug: persisted };
	}

	/**
	 * Step 1 → step 2. Trial-eligible accounts go straight to the card-less trial panel (no
	 * Stripe intent, and no declaration — a trial is not a purchase); everyone else goes to the
	 * payer declaration, which is what the intent needs. Validation (name + slug availability)
	 * runs before either branch.
	 *
	 * NO INTENT IS OPENED HERE ANY MORE. It used to be, without payer facts, and the eligibility
	 * gate refused every one of them.
	 */
	async function continueToCheckout() {
		if (busy) return;
		dispatch({ type: "busy-set", busy: true });
		try {
			const data = await validate();
			if (!data) return;
			// Card-less trial — the trial panel confirms; no payment intent needed.
			dispatch({ type: "name-accepted", name: data.name, trial: offer?.kind === "trial" });
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			dispatch({ type: "busy-set", busy: false });
		}
	}

	/**
	 * Step 2 → step 3. Asks the gate whether a sale under these declared facts is permitted, then
	 * opens the subscription intent CARRYING them.
	 *
	 * The verdict is asked for over a return value rather than inferred from a thrown intent,
	 * because `createNewOrgSubscriptionIntent` refuses by throwing and the reason does not survive
	 * the server-action boundary — the customer would get "Something went wrong" for a decision the
	 * product made on purpose and can explain.
	 *
	 * The facts are NOT written here. There is no organization yet, so there is no row to write
	 * them on; `linkSubscriptionToNewOrg` persists the capacity and country at the moment one
	 * exists, and `declarePayer` completes the record with the attestation.
	 */
	async function handleDeclare(next: PayerDeclaration) {
		if (declaring) return;
		dispatch({ type: "declare-started" });
		try {
			const verdict = await payerConversionStatus(next);
			if (!verdict.allowed) {
				dispatch({ type: "refusal-set", message: verdict.message });
				return;
			}
			const intent = await createNewOrgSubscriptionIntent("team", {
				orgName: checkoutOrgName,
				slug: form.getValues().slug,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
				payer: {
					capacity: next.capacity,
					billingCountry: next.billingCountry,
				},
			});
			if (intent.kind === "resume") {
				await resumePaidPrior(intent.setup, next);
				return;
			}
			if (intent.kind === "refused") {
				dispatch({ type: "refusal-set", message: intent.message });
				return;
			}
			dispatch({
				type: "intent-opened",
				intent: {
					subscriptionId: intent.subscriptionId,
					customerId: intent.customerId,
					clientSecret: intent.clientSecret,
					currency: intent.currency,
					notice: intent.notice ?? null,
				},
				declaration: next,
			});
		} catch (e) {
			dispatch({
				type: "refusal-set",
				message: e instanceof Error ? e.message : "Couldn't start the purchase — try again.",
			});
		} finally {
			dispatch({ type: "declare-ended" });
		}
	}

	/** Switch the checkout currency by re-creating the intent for the same org (Stripe locks
	 *  a sub's currency). Reuses the customer + cancels the prior incomplete sub. The declared
	 *  payer rides along: the new intent passes the same gate the first one did. */
	async function changeCurrency(next: SupportedCurrency) {
		if (next === currency || switchingCurrency || !checkoutOrgName || !declaration) return;
		dispatch({ type: "currency-switch-started" });
		try {
			const intent = await createNewOrgSubscriptionIntent("team", {
				orgName: checkoutOrgName,
				slug: form.getValues().slug,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
				currency: next,
				payer: {
					capacity: declaration.capacity,
					billingCountry: declaration.billingCountry,
				},
			});
			if (intent.kind === "resume") {
				await resumePaidPrior(intent.setup, declaration);
				return;
			}
			if (intent.kind === "refused") {
				toast.error(intent.message);
				return;
			}
			dispatch({
				type: "currency-switched",
				intent: {
					subscriptionId: intent.subscriptionId,
					customerId: intent.customerId,
					clientSecret: intent.clientSecret,
					currency: intent.currency,
					notice: intent.notice ?? null,
				},
			});
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't switch currency.");
		} finally {
			dispatch({ type: "currency-switch-ended" });
		}
	}

	/** Trial path: create the org now (card-less) and burn the account's one trial. If the
	 *  trial fails AFTER the org was created, roll the org back so we never leave an orphan
	 *  (no billing) behind. */
	async function startTrial() {
		if (busy) return;
		dispatch({ type: "busy-set", busy: true });
		try {
			// A slug refused here (claimed since Continue, or at the create itself) is a field error on
			// the NAME step, so go back to it — on the trial panel it rendered nowhere, and the button
			// simply stopped doing anything.
			const data = await validate();
			if (!data) {
				dispatch({ type: "back-to-name" });
				return;
			}
			const org = await createOrg(data);
			if (!org) {
				dispatch({ type: "back-to-name" });
				return;
			}
			try {
				// The org just created, NOT the ambient one — this sheet is open on a page inside the
				// CURRENT org, so ambient would burn the account's one trial on the wrong org and then
				// delete the new org in the catch below.
				await startProTrial({ orgId: org.id });
				track("trial_started", { plan: "team", context: "create_org" });
			} catch (trialErr) {
				// Roll back the just-created org — a failed trial must not orphan it.
				await authClient.organization
					.delete({ organizationId: org.id })
					.catch(() => {});
				dispatch({ type: "trial-org-rolled-back" });
				throw trialErr;
			}
			await fetchWorkspace();
			dispatch({ type: "trial-started" });
			toast.success("Trial started — your organization is ready.");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't start the trial");
		} finally {
			dispatch({ type: "busy-set", busy: false });
		}
	}

	/**
	 * Card confirmed. The pending record is written HERE, before any post-payment step runs, so a
	 * close from this moment on — while the steps are still in flight — is confirmed and resumable.
	 * The steps themselves (customer details → create → link → declare) run in `finishPaidSetup`,
	 * which persists the record after each one and clears it only after the declaration.
	 */
	async function handlePaid(billing: CollectedBilling) {
		if (!subscriptionId || !customerId || !declaration) {
			// Unreachable from the UI: the declaration is what opened the intent, and the intent is
			// what rendered the payment form. Said rather than skipped, because a skip here would be a
			// charge with nothing tied to it.
			toast.error(
				"Your payment went through, but this page lost its reference to it. Contact support with the time of the payment.",
			);
			return;
		}
		if (!viewerId) {
			// The record is keyed by the viewer; without one it would be written nowhere and the
			// steps would run with no resumable copy. The server still knows the charge, and the sheet
			// asks it on open (`recoverUnfinishedPaidSetup`) — so a reload is the way back.
			toast.error(
				"Your payment went through, but this page hasn't finished loading your account. Reload, then open Create a team to finish.",
				{ duration: Number.POSITIVE_INFINITY },
			);
			return;
		}
		const values = form.getValues();
		const record: PendingPaidSetup = {
			subscriptionId,
			customerId,
			name: values.name,
			slug: values.slug,
			currency,
			declaration,
			billing,
			customerDetailsSaved: false,
			createdOrgId: null,
			createdSlug: "",
			linked: false,
			slugRefusal: null,
		};
		writePendingPaidSetup(viewerId, record);
		dispatch({ type: "charge-confirmed", record });
		await runSetup(record);
	}

	/**
	 * Runs (or resumes) the post-payment steps for `record`. Their progress is persisted whether or
	 * not this sheet is still open; only the OUTCOME is applied here, and only if the sheet has not
	 * been reset since the run started.
	 */
	async function runSetup(record: PendingPaidSetup) {
		dispatch({ type: "setup-started" });
		await runSetupSteps(record);
	}

	/** Runs the post-payment steps and shows how they ended, unless the sheet was reset meanwhile. */
	async function runSetupSteps(record: PendingPaidSetup) {
		const gen = generation.current;
		const outcome = await finishPaidSetup(viewerId, record, {
			onProgress: (next) => {
				if (generation.current === gen) dispatch({ type: "setup-progressed", record: next });
			},
			fetchWorkspace,
		});
		if (generation.current === gen) applyOutcome(outcome);
	}

	/**
	 * Shows how a run of the post-payment steps ended: the invite view, a new-slug ask, the retry, or —
	 * when retrying cannot help — the run's final sentence with no retry. The reducer decides the
	 * panel; the form's slug error is set here, beside it.
	 */
	function applyOutcome(outcome: PaidSetupOutcome) {
		if (outcome.kind === "slug-refused") {
			// Paid, and the slug was refused at the create. Asked for in place — the refusal used to be
			// written to a field on the NAME step, which is not rendered here.
			form.setError("slug", { message: outcome.message });
		}
		dispatch({ type: "setup-ended", outcome });
	}

	/**
	 * The retry after a post-payment slug refusal: re-check the NEW slug (format, reserved, taken)
	 * and finish setup with it. A slug still refused stays on screen under the field and nothing is
	 * re-run; no new charge is ever made — the confirmed subscription is reused.
	 */
	async function retryWithNewSlug() {
		if (busy || !pending) return;
		dispatch({ type: "busy-set", busy: true });
		let data: FormData | null = null;
		try {
			data = await validate();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't check that slug — try again.");
		} finally {
			dispatch({ type: "busy-set", busy: false });
		}
		if (data) await runSetup({ ...pending, name: data.name, slug: data.slug });
	}

	/** Send one invite into the created (paid) org. Trials are solo (see beforeCreate). */
	async function addInvite() {
		const email = inviteEmail.trim();
		if (!isValidInviteEmail(email)) {
			toast.error("Enter a valid email to invite.");
			return;
		}
		if (!createdOrgId) {
			// Never fall back to the session's active org: that is the team the customer was in
			// before, not the one just made.
			toast.error("Couldn't tell which team to invite into — open the team and invite from Members.");
			return;
		}
		try {
			const { error } = await authClient.organization.inviteMember({
				email,
				role: inviteRole,
				organizationId: createdOrgId,
			});
			if (error) {
				toast.error(error.message ?? "Couldn't send the invite");
				return;
			}
			dispatch({ type: "invite-sent", invite: { email, role: inviteRole } });
			toast.success(`Invitation sent to ${email}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't send the invite");
		}
	}

	const heading =
		view === "pay" || view === "declare" ? `Create ${name || "team"}` : "Create a team";

	// The resume effect: the record's form values (an external store) and the run it attaches to, or
	// restarts when an earlier run stopped it for support. That sentence may no longer be true (support
	// can have fixed it), so it is not replayed: the run asks the server again, first, and either stops
	// with what is true now or finishes. No retry is offered for it (§5.6 rule 4). A layout effect, so
	// the restored view never paints with the form still blank. Declared below the functions it calls
	// (the React Compiler's immutability rule).
	const resume = state.resume;
	useLayoutEffect(() => {
		if (!resume) return;
		const { record, running } = resume;
		form.reset({ name: record.name, slug: record.slug });
		if (record.slugRefusal) form.setError("slug", { message: record.slugRefusal });
		// At most one attach or run per resume: StrictMode mounts effects twice in development, and a
		// second `runSetupSteps` would be a second pass at a paid setup. Keyed by the resume (one per
		// open transition over a record), so a later reopen over the same record still resumes it.
		if (startedFor.current === resume) return;
		startedFor.current = resume;
		if (running) {
			const gen = generation.current;
			void running.then((outcome) => {
				if (generation.current === gen) applyOutcome(outcome);
			});
		} else if (record.stopped) {
			void runSetupSteps(record);
		}
		// Once per resumed record: re-running it on any other change would attach twice or start a
		// second run beside the first. `form` is stable for the component's life.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [resume]);

	// The recovery effect: with no usable record in this tab, ask the server.
	const recoverFrom = state.recoverFrom;
	useEffect(() => {
		if (!recoverFrom) return;
		const stored = recoverFrom;
		let active = true;
		void recoverUnfinishedPaidSetup(stored.kind === "unreadable" ? stored.ids : null).then(
			(found) => {
				if (!active) return;
				if (found.kind === "found") {
					beginRecovery(found.state);
				} else if (found.kind === "held") {
					// A hold refuses this setup (ADR 0002 §5.6): its sentence, and no step to finish it.
					dispatch({ type: "recovery-held", notice: found.notice });
				} else if (found.kind === "unavailable") {
					// Not "nothing to finish": the check failed, and it may be hiding a payment. Said, so
					// a customer who just paid does not pay again.
					toast.error(
						"We couldn't check whether you have a team setup to finish. If you just paid for a team, don't pay again — reopen Create a team in a moment, or contact support.",
					);
				} else if (stored.kind === "unreadable") {
					// Unreadable, and the server has nothing unfinished under it (or could not be
					// asked). Said, not dropped: the customer may still hold a receipt for it.
					toast.error(
						"We found an unfinished team setup in this tab that we couldn't read. If you were charged for a team that doesn't exist, contact support with the time of the payment.",
					);
				}
			},
		);
		return () => {
			active = false;
		};
		// Once per open with no usable record (`recoverFrom` is reset on every open transition): the
		// question is for the moment the sheet opens, not for every later render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [recoverFrom]);

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[92vw] gap-0 overflow-hidden p-0 sm:max-w-3xl"
			>
				<SheetTitle className="sr-only">Create a team</SheetTitle>
				<SheetDescription className="sr-only">
					Create a Pro team, pay, and invite your teammates.
				</SheetDescription>

				{screen.kind !== "invite" && (
					<PurchaseLayout
						meta={meta}
						heading={heading}
						onClose={() => handleOpenChange(false)}
					>
						<PurchasePanel
							screen={screen}
							form={form}
							slug={slug}
							state={state}
							dispatch={dispatch}
							viewerId={viewerId}
							ownerEmail={ownerEmail}
							meta={meta}
							teamPrice={teamPrice}
							clearRefusal={clearRefusal}
							onClose={() => handleOpenChange(false)}
							onContinue={() => void continueToCheckout()}
							onFinishRecovered={(d) => void finishRecovered(d)}
							onDeclare={(d) => void handleDeclare(d)}
							onCloseKeepingSetup={closeKeepingPaidSetup}
							onRetryWithNewSlug={() => void retryWithNewSlug()}
							onRetrySetup={(record) => void runSetup(record)}
							onStartTrial={() => void startTrial()}
							onChangeCurrency={changeCurrency}
							onPaid={(b) => handlePaid(b)}
							beforeConfirm={saveDetailsBeforeCharge}
						/>
					</PurchaseLayout>
				)}

				{screen.kind === "invite" && (
					<InviteView
						isTrialOrg={state.isTrialOrg}
						paidPlan={paidPlan}
						ownerEmail={ownerEmail}
						inviteEmail={inviteEmail}
						setInviteEmail={(email) => dispatch({ type: "invite-email-changed", email })}
						inviteRole={inviteRole}
						setInviteRole={(role) => dispatch({ type: "invite-role-changed", role })}
						sent={state.sent}
						onAdd={() => void addInvite()}
						onFinish={goToOrg}
						onAddPayment={() => {
							handleOpenChange(false);
							router.push(
								createdSlug ? globalHref(createdSlug, "settings/billing") : "/dashboard",
							);
						}}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

/**
 * The right-hand column of every screen but `invite`: one panel per `CreateOrgScreen` member, in the
 * order `screenOf` decides them. Holds no state; every action goes back to the sheet.
 */
function PurchasePanel({
	screen,
	form,
	slug,
	state,
	dispatch,
	viewerId,
	ownerEmail,
	meta,
	teamPrice,
	clearRefusal,
	onClose,
	onContinue,
	onFinishRecovered,
	onDeclare,
	onCloseKeepingSetup,
	onRetryWithNewSlug,
	onRetrySetup,
	onStartTrial,
	onChangeCurrency,
	onPaid,
	beforeConfirm,
}: {
	screen: CreateOrgScreen;
	form: UseFormReturn<FormData>;
	slug: string;
	state: CreateOrgState;
	dispatch: (event: CreateOrgEvent) => void;
	viewerId: string;
	ownerEmail: string;
	meta: ReturnType<typeof planMeta>;
	teamPrice: ReturnType<typeof useLivePlanPrice>;
	clearRefusal: () => void;
	onClose: () => void;
	onContinue: () => void;
	onFinishRecovered: (declaration: PayerDeclaration) => void;
	onDeclare: (declaration: PayerDeclaration) => void;
	onCloseKeepingSetup: () => void;
	onRetryWithNewSlug: () => void;
	onRetrySetup: (record: PendingPaidSetup) => void;
	onStartTrial: () => void;
	onChangeCurrency: (currency: SupportedCurrency) => void;
	onPaid: (billing: CollectedBilling) => Promise<void>;
	beforeConfirm: (billing: CollectedBilling) => Promise<CheckoutRefusal | null>;
}) {
	switch (screen.kind) {
		case "name":
			return (
				<NamePanel
					form={form}
					slug={slug}
					showUrl={state.showUrl}
					setShowUrl={(open) => dispatch({ type: "url-editor-set", open })}
					slugTouched={state.slugTouched}
					setSlugTouched={() => dispatch({ type: "slug-edited" })}
					busy={state.busy}
					ready={state.offer !== null}
					onContinue={onContinue}
				/>
			);
		case "declare-recovered":
			return (
				<div className="space-y-3">
					<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
						We found a payment for a team that isn&apos;t set up yet. Confirm who is
						paying to finish setting it up.
						{screen.recovered.billing === null &&
							" The tax ID from checkout didn't reach us — add it in the team's billing settings once it is set up."}
					</p>
					{!screen.recovered.org && <TeamUrlField form={form} slug={slug} />}
					<PayerDeclarationForm
						busy={state.busy}
						refusal={state.refusal}
						onEdit={clearRefusal}
						submitLabel="Finish setup"
						onBack={onClose}
						onDeclare={onFinishRecovered}
					/>
				</div>
			);
		case "declare":
			return (
				<PayerDeclarationForm
					busy={state.declaring}
					refusal={state.refusal}
					onEdit={clearRefusal}
					submitLabel="Continue to payment"
					onBack={() => dispatch({ type: "back-to-name" })}
					onDeclare={onDeclare}
				/>
			);
		case "confirm-close":
			return (
				<ConfirmCloseUnfinished
					running={state.busy}
					inPageOnly={pendingPaidSetupInPageOnly(viewerId)}
					onStay={() => dispatch({ type: "close-cancelled" })}
					onClose={onCloseKeepingSetup}
				/>
			);
		case "stopped":
			return <SetupStoppedPanel message={screen.message} onClose={onClose} />;
		case "retry-new-slug":
			return (
				<RetryWithNewSlug form={form} slug={slug} busy={state.busy} onRetry={onRetryWithNewSlug} />
			);
		case "retry-setup":
			return (
				<RetrySetup
					busy={state.busy}
					failed={screen.failed}
					onRetry={() => onRetrySetup(screen.pending)}
				/>
			);
		case "trial":
			return (
				<TrialPanel
					busy={state.busy}
					priceLabel={teamPrice.label}
					trialDays={state.offer?.trialDays ?? 30}
					onBack={() => dispatch({ type: "back-to-name" })}
					onStart={onStartTrial}
				/>
			);
		case "checkout":
			return (
				<div className="flex min-h-0 flex-1 flex-col gap-4">
					<div className="flex shrink-0 items-center justify-between">
						<button
							type="button"
							onClick={() => {
								// Back to the DECLARATION, not the name: it is the step
								// immediately behind this one, and re-declaring is how a
								// payer corrects a capacity or country they got wrong.
								dispatch({ type: "back-to-declare" });
							}}
							className="text-left text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
						>
							← Back
						</button>
						<CurrencyToggle
							value={state.currency}
							onChange={onChangeCurrency}
							disabled={state.switchingCurrency}
						/>
					</div>
					{state.intentNotice && (
						<Alert className="shrink-0">
							<AlertDescription>{state.intentNotice}</AlertDescription>
						</Alert>
					)}
					<StripeElementsProvider clientSecret={screen.clientSecret}>
						<BillingCheckoutForm
							clientSecret={screen.clientSecret}
							meta={meta}
							unitAmount={teamPrice.unitAmount}
							currency={state.currency}
							ownerEmail={ownerEmail}
							submitLabel="Create"
							scrollable
							onPaid={onPaid}
							beforeConfirm={beforeConfirm}
						/>
					</StripeElementsProvider>
				</div>
			);
		case "no-intent":
		case "invite":
			return null;
	}
}


// ── Create-specific views ──────────────────────────────────────────────────────

/** State 1 — team name (auto-slug) + a single Continue. Trial-vs-pay is decided in step 2. */
function NamePanel({
	form,
	slug,
	showUrl,
	setShowUrl,
	slugTouched,
	setSlugTouched,
	busy,
	ready,
	onContinue,
}: {
	form: UseFormReturn<FormData>;
	slug: string;
	showUrl: boolean;
	setShowUrl: (v: boolean) => void;
	slugTouched: boolean;
	setSlugTouched: (v: boolean) => void;
	busy: boolean;
	/** False until the Pro offer (trial vs pay) has resolved, so step 2 routes correctly. */
	ready: boolean;
	onContinue: () => void;
}) {
	const slugErrorId = useId();
	const slugError = form.formState.errors.slug?.message;
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				onContinue();
			}}
			className="flex flex-col gap-4"
		>
			<Field label="Team name" required error={form.formState.errors.name?.message}>
				{(id) => (
					<>
						<Input
							id={id}
							placeholder="Acme Cloud"
							autoComplete="off"
							autoFocus
							{...form.register("name")}
							onChange={(e) => {
								const v = e.target.value;
								form.setValue("name", v, { shouldValidate: true });
								if (!slugTouched)
									form.setValue("slug", slugifyOrEmpty(v), { shouldValidate: true });
							}}
						/>
						<div className="flex items-center justify-between pt-1">
							<span className="font-mono text-ui-xs text-text-tertiary">
								{orgHost()}/<span className="text-text-secondary">{slug || "org"}</span>
							</span>
							<button
								type="button"
								onClick={() => setShowUrl(!showUrl)}
								className="font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary"
							>
								{showUrl ? "Done" : "Customize URL"}
							</button>
						</div>
						{showUrl && (
							<div className="flex h-9 items-center overflow-hidden rounded-sm border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
								<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
									{orgHost()}/
								</span>
								<input
									aria-label="URL slug"
									// Tied to the sentence below, so a screen reader landing on the field hears
									// why it was refused — the alert is announced once, the description every
									// time the field is focused (#5445).
									aria-invalid={slugError ? true : undefined}
									aria-describedby={slugError ? slugErrorId : undefined}
									className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
									placeholder="acme-cloud"
									autoComplete="off"
									value={slug}
									onChange={(e) => {
										setSlugTouched(true);
										// A draft, so a hyphen can be typed: `slugifyOrEmpty` trimmed it on
										// every keystroke, and `acme-` became `acme` before the next letter
										// arrived (#5453). The dash at the end is trimmed on blur and submit.
										form.setValue("slug", slugifyDraft(e.target.value), {
											shouldValidate: true,
										});
									}}
									onBlur={() => commitSlug(form)}
								/>
							</div>
						)}
						{slugError && (
							<p id={slugErrorId} role="alert" className="text-ui-xs text-destructive">
								{slugError}
							</p>
						)}
					</>
				)}
			</Field>

			<Button type="submit" disabled={busy || !ready} className="w-full">
				{busy ? "Setting up…" : "Continue"}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}

/**
 * Step 2 (trial-eligible) — a card-less 30-day trial. Shows $0 due now / price after, and
 * a single "Start free trial" CTA. No payment form: a free trial has no reason to decline.
 */
function TrialPanel({
	busy,
	priceLabel,
	trialDays,
	onBack,
	onStart,
}: {
	busy: boolean;
	/** Live Stripe price label shown for "after the trial". */
	priceLabel: string;
	trialDays: number;
	onBack: () => void;
	onStart: () => void;
}) {
	return (
		<div className="space-y-4">
			<button
				type="button"
				onClick={onBack}
				className="text-ui-sm text-text-tertiary transition-colors hover:text-text-primary"
			>
				← Back
			</button>

			<div className="rounded-lg border border-border">
				<div className="flex items-center justify-between border-b border-border px-4 py-3">
					<span className="text-ui-md font-medium text-text-primary">Due today</span>
					<span className="font-display text-ui-xl font-semibold text-text-primary">
						$0
					</span>
				</div>
				<div className="flex items-center justify-between px-4 py-3 text-ui-sm text-text-secondary">
					<span>After your {trialDays}-day free trial</span>
					<span className="font-mono text-ui-sm text-text-primary">
						{priceLabel}
					</span>
				</div>
			</div>

			<Button type="button" className="w-full" disabled={busy} onClick={onStart}>
				{busy ? "Setting up…" : `Start ${trialDays}-day free trial`}
				<ArrowRight size={15} />
			</Button>
			<p className="text-center font-mono text-ui-2xs text-text-tertiary">
				No charge during the trial · cancel anytime
			</p>
		</div>
	);
}

/**
 * Paid, and the slug was claimed by another team before the org could be created (#5445). Says so,
 * and asks for a new URL in place — the only field that changes; the name and the payment stand.
 */
function RetryWithNewSlug({
	form,
	slug,
	busy,
	onRetry,
}: {
	form: UseFormReturn<FormData>;
	slug: string;
	busy: boolean;
	onRetry: () => void;
}) {
	return (
		<form
			className="space-y-3"
			onSubmit={(e) => {
				e.preventDefault();
				onRetry();
			}}
		>
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				Your payment went through, but your team couldn&apos;t be created at that URL — the
				reason is below. Choose a different URL to finish setting up.
			</p>
			<TeamUrlField form={form} slug={slug} />
			<Button type="submit" className="w-full" disabled={busy}>
				{busy ? "Finishing…" : "Complete setup"}
				<ArrowRight size={15} />
			</Button>
		</form>
	);
}

/** The "Team URL" field, with the refusal for the slug (if any) under it and tied to it. */
function TeamUrlField({ form, slug }: { form: UseFormReturn<FormData>; slug: string }) {
	const inputId = useId();
	const errorId = useId();
	const slugError = form.formState.errors.slug?.message;
	return (
		<div className="space-y-3">
			<label htmlFor={inputId} className="block text-ui-md font-medium text-text-primary">
				Team URL
			</label>
			<div className="flex h-9 items-center overflow-hidden rounded-sm border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
				<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
					{orgHost()}/
				</span>
				<input
					id={inputId}
					aria-invalid={slugError ? true : undefined}
					aria-describedby={slugError ? errorId : undefined}
					className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
					autoComplete="off"
					value={slug}
					// A draft while typed, finished on blur and submit — see the create step's field (#5453).
					onChange={(e) =>
						form.setValue("slug", slugifyDraft(e.target.value), { shouldValidate: true })
					}
					onBlur={() => commitSlug(form)}
				/>
			</div>
			{slugError && (
				<p id={errorId} role="alert" className="text-ui-xs text-destructive">
					{slugError}
				</p>
			)}
		</div>
	);
}

/**
 * Asked before the sheet closes on an unfinished paid setup. States what happens to the payment and
 * where the setup can be finished. `running` is true while a post-payment step is still in flight —
 * it keeps running after the close. `inPageOnly` is true when this tab's storage refused the record
 * and it lives only in the page, so a reload loses it.
 *
 * What it promises is what holds: in this tab (and, with working storage, across a reload) the
 * setup resumes with everything typed. Without that copy, Create a team finds the payment in the
 * server's own record of the setup — at once, from any tab — and asks who is paying again.
 */
function ConfirmCloseUnfinished({
	running,
	inPageOnly,
	onStay,
	onClose,
}: {
	running: boolean;
	inPageOnly: boolean;
	onStay: () => void;
	onClose: () => void;
}) {
	return (
		<div className="space-y-3">
			<p className="text-ui-md font-medium text-text-primary">
				Close before your team is set up?
			</p>
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				{running
					? "Your payment went through and setup is still running — closing this panel does not stop it. "
					: "Your payment went through and is kept for this team. "}
				To finish later, open Create a team again — it picks up at the step that has not
				finished.{" "}
				{inPageOnly
					? "This browser isn't letting the page keep a copy, so after a reload or in another tab it will ask you again who is paying."
					: "If you close this browser tab first, it will ask you again who is paying."}
			</p>
			<Button className="w-full" onClick={onStay}>
				{running ? "Stay while it finishes" : "Finish setup now"}
				<ArrowRight size={15} />
			</Button>
			<Button variant="outline" className="w-full" onClick={onClose}>
				Close for now
			</Button>
		</div>
	);
}

/**
 * A run of the post-payment steps that ended where retrying cannot help: the server's sentence for it
 * (a hold's clause, the link's refusal, or a case for support), and a way out. No retry is offered.
 */
function SetupStoppedPanel({ message, onClose }: { message: string; onClose: () => void }) {
	return (
		<div className="space-y-3">
			<Alert>
				<AlertDescription>{message}</AlertDescription>
			</Alert>
			<Button variant="outline" className="w-full" onClick={onClose}>
				Done
			</Button>
		</div>
	);
}

/**
 * Paid, and the post-payment steps are running (`failed` false) or one of them failed (`failed`
 * true) — finish setup, no re-charge.
 */
function RetrySetup({
	busy,
	failed,
	onRetry,
}: {
	busy: boolean;
	failed: boolean;
	onRetry: () => void;
}) {
	return (
		<div className="space-y-3">
			<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-ui-sm text-text-secondary">
				{failed
					? "Your payment went through, but we couldn't finish setting up the team. Retry to complete setup."
					: "Your payment went through — setting up your team now."}
			</p>
			<Button className="w-full" disabled={busy} onClick={onRetry}>
				{busy ? "Finishing…" : "Complete setup"}
				<ArrowRight size={15} />
			</Button>
		</div>
	);
}
