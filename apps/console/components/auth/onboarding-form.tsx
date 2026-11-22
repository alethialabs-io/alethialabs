"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Post-signup onboarding (/onboarding): ONE screen, Vercel-style (WIZ-W6, #6929). The maintainer's
// bar: "as little input from the user as possible, as much as we can deduce."
//
//   - The plan defaults to Hobby; the Pro trial is one click.
//   - The org name defaults to the one sign-up provisioned; the URL and the logo sit behind
//     "Customize".
//   - On the Pro trial, the purchase gate's facts are DEDUCED by the page and shown as editable
//     defaults: the billing country (never a blank field when anything said where the person is)
//     and the payer capacity as one switch. Only the role behind a business purchase is asked,
//     because nothing can say it for the person.
//   - The terms are one unticked box on this form, worded by `terms-acceptance-copy.ts`. There is no
//     separate `/accept-terms` stop for a new account.
//
// One submit, one server call (`finishOnboarding`): it decides on the server where setup stands,
// records what was declared, starts the trial, and marks setup complete. The form never marks
// completion itself and never writes from an effect. On success it goes to `/{slug}/~/new` (or the
// `next` it was given), replacing this page in history so Back does not return to a finished form.

import { ArrowRight, Building2, Check, User } from "lucide-react";
import { Fragment, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Controller, type UseFormReturn, useFormState } from "react-hook-form";
import { useRouter } from "next/navigation";
import type { PayerCapacity } from "@repo/legal/commerce";
import { Button } from "@repo/ui/button";
import { Checkbox } from "@repo/ui/checkbox";
import { CountrySelect } from "@repo/ui/country-select";
import { Input } from "@repo/ui/input";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import { WizardFormError, WizardRestoredNotice } from "@repo/ui/wizard";
import {
	type FinishOnboardingInput,
	finishOnboarding,
} from "@/app/server/actions/onboarding";
import {
	type OnboardingOutput,
	type OnboardingValues,
	onboardingWizard,
} from "@/app/(public)/onboarding/onboarding.wizard";
import { FormRootError } from "@/components/forms/form-root-error";
import {
	type AcceptanceDocument,
	type CopySegment,
	checkboxLabel,
	noticeLine,
	requiredMessage,
} from "@/components/legal/terms-acceptance-copy";
import { OrgLogoUpload } from "@/components/org/org-logo-upload";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { ROOT_SERVER_ERROR } from "@/lib/actions/form-errors";
import { track } from "@/lib/analytics/track";
import type { BillingCountrySource, DeducedCountry, PrimaryOrg } from "@/lib/auth/onboarding";
import { orgHost } from "@/lib/org-url";
import { finishSlugDraft, slugifyDraft, slugifyOrEmpty } from "@/lib/utils/slugify";
import type { WizardEnvironment, WizardLocation } from "@/lib/wizard/types";
import { useWizardEngine } from "@/lib/wizard/use-wizard";

/** Whether this account can start the Pro trial here, and if not, the reason the tile says. */
export type OnboardingTrial =
	| { readonly kind: "available"; readonly days: number }
	| { readonly kind: "unavailable"; readonly reason: string };

/** Props of {@link OnboardingForm}; every default is the page's server-side answer. */
export interface OnboardingFormProps {
	/** The primary organization sign-up provisioned, configured in place. */
	org: PrimaryOrg;
	/** The signed-in person's id, which keys the tab draft. */
	viewerId: string;
	trial: OnboardingTrial;
	/** The documents awaiting acceptance at their current version; empty when nothing is pending. */
	terms: readonly AcceptanceDocument[];
	/** The deduced billing country and its evidence, or null when nothing said anything. */
	country: DeducedCountry | null;
	/** The suggested payer capacity (a company-domain email suggests `organization`). */
	capacity: PayerCapacity;
	/** Where to go once setup is finished, when the person arrived with a `next`; else `/{slug}/~/new`. */
	destination: string | null;
}

/**
 * The page holds nothing in the URL: onboarding is one step, so the engine's step param has nowhere
 * to go, and a finished setup has nothing there to clear.
 */
const NO_URL: WizardLocation = {
	read: () => null,
	push: () => undefined,
	replace: () => undefined,
	leave: () => undefined,
};

/** Why the billing country shows the value it does — one short line under the field. */
const COUNTRY_SOURCE_HINT: Record<BillingCountrySource, string> = {
	declared: "The country you gave before.",
	location: "Based on where you're signing in from.",
	email: "Based on your email address.",
	language: "Based on your browser's language.",
};

/** The eyebrow label every field on this screen wears. */
const FIELD_LABEL = "font-mono text-ui-2xs uppercase tracking-[0.14em] text-text-tertiary";

/**
 * Builds what `finishOnboarding` takes from the parsed values: the finished slug, the documents the
 * box named (only when it was shown and ticked) and — on the Pro trial — the payer facts.
 */
export function onboardingSubmission(
	values: OnboardingOutput,
	terms: readonly AcceptanceDocument[],
	clientTimestamp: string,
): FinishOnboardingInput {
	const business = values.business;
	return {
		name: values.name.trim(),
		slug: finishSlugDraft(values.slug),
		plan: values.plan,
		acceptedDocuments:
			values.acceptTerms && terms.length > 0
				? terms.map((d) => ({ id: d.id, version: d.version }))
				: [],
		clientTimestamp,
		payer:
			values.plan === "team"
				? {
						capacity: business ? "organization" : "consumer",
						billingCountry: values.billingCountry.trim().toUpperCase(),
						authorityAttestation: business ? values.role.trim() : null,
					}
				: null,
	};
}

/**
 * The /onboarding form. Renders inside AuthShell without a boxed card — an open,
 * hairline-sectioned composition.
 */
export function OnboardingForm({
	org,
	viewerId,
	trial,
	terms,
	country,
	capacity,
	destination,
}: OnboardingFormProps) {
	const router = useRouter();
	const trialAvailable = trial.kind === "available";
	// The engine calls this once every field passes; it points at the mutation after each render.
	const send = useRef<(values: OnboardingOutput) => void>(() => undefined);
	const env: WizardEnvironment = { location: NO_URL, viewerId };
	const wizard = useWizardEngine<OnboardingValues, OnboardingOutput>(
		onboardingWizard,
		{
			defaultValues: {
				plan: "community",
				name: org.name,
				slug: org.slug,
				billingCountry: country?.code ?? "",
				business: capacity === "organization",
				role: "",
				acceptTerms: false,
				termsRequired: terms.length > 0,
			},
			scope: org.id,
			onSubmit: (values) => send.current(values),
		},
		env,
	);
	const { form } = wizard;
	const { errors } = useFormState({ control: form.control });
	const values = form.getValues();
	const plan = values.plan === "team" && trialAvailable ? "team" : "community";
	const [customizing, setCustomizing] = useState(false);
	// The URL editor opens by itself when the slug is what failed (on submit, and on a server refusal),
	// so the sentence and the field it is about are on screen together — and stays open while the
	// person fixes it: the error clears on the first keystroke, and a disclosure that closed then
	// would take the field away mid-word.
	const urlOpen = customizing || Boolean(errors.slug);
	const [logo, setLogo] = useState<string | null>(org.logo);

	const finish = useActionMutation(finishOnboarding, {
		invalidates: [],
		onValidationError: (fields) => {
			if (fields.slug?.[0]) setCustomizing(true);
			wizard.applyFieldErrors(fields);
		},
		// A refusal that is about no field — the trial the gate refused, a payment still being
		// confirmed — is shown above the button, where the person decides what to do next.
		onRefusal: (error) => form.setError(ROOT_SERVER_ERROR, { type: "server", message: error.message }),
		onSuccess: (data, variables) => {
			wizard.complete();
			track("org_created", { plan: variables.plan });
			if (variables.plan === "team") track("trial_started", { plan: "team" });
			const slug = data.slug || variables.slug;
			router.replace(destination ?? `/${slug}/~/new`);
		},
	});

	useEffect(() => {
		send.current = (parsed) =>
			finish.submit(
				onboardingSubmission(
					trialAvailable ? parsed : { ...parsed, plan: "community" },
					terms,
					new Date().toISOString(),
				),
			);
	});

	// A draft can bring back "Pro" for an account that can no longer start the trial here; the tile
	// is disabled, so the value goes back to Hobby rather than failing a check nobody can see.
	const restoredPlan = values.plan;
	useEffect(() => {
		if (!trialAvailable && restoredPlan === "team") form.setValue("plan", "community");
	}, [trialAvailable, restoredPlan, form]);

	const pending = finish.isPending || finish.isSuccess;

	/** Enter or the button: validates every field, then finishes setup once. */
	function onSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending) return;
		void wizard.submit().then(() => {
			if (form.getFieldState("slug").error) setCustomizing(true);
		});
	}

	return (
		<form onSubmit={onSubmit} noValidate className="mx-auto w-full max-w-[560px]">
			<div className="mb-8 flex flex-col gap-2.5">
				<p className="vx-eyebrow">Get started</p>
				<h1 className="font-grotesk text-display-sm font-semibold leading-[1.04] tracking-display text-text-primary">
					Create your organization
				</h1>
				<p className="text-ui-lg leading-[1.55] text-text-secondary">
					An organization holds your projects and team. You can change the plan at any time.
				</p>
			</div>

			{wizard.restored ? (
				<div className="mb-4">
					<WizardRestoredNotice onStartOver={wizard.discard} />
				</div>
			) : null}

			<PlanChoice
				value={plan}
				disabled={pending}
				trial={trial}
				onChange={(next) => {
					form.setValue("plan", next, { shouldDirty: true });
					track("onboarding_plan_selected", { plan: next });
				}}
			/>

			<div className="my-7 h-px bg-border" />

			<div className="flex flex-col gap-2.5">
				<label htmlFor="org-name" className={FIELD_LABEL}>
					Organization name
				</label>
				<Controller
					control={form.control}
					name="name"
					render={({ field }) => (
						<Input
							id="org-name"
							ref={field.ref}
							value={field.value}
							autoComplete="organization"
							placeholder="Acme Cloud"
							disabled={pending}
							aria-invalid={Boolean(errors.name)}
							aria-describedby={errors.name ? "org-name-error" : undefined}
							className="h-[46px] border-border-strong bg-surface-sunken text-ui-lg"
							onBlur={field.onBlur}
							onChange={(e) => {
								field.onChange(e.target.value);
								// The slug follows the name until the person edits the slug itself.
								if (!form.getFieldState("slug").isDirty) {
									form.setValue("slug", slugifyOrEmpty(e.target.value));
								}
							}}
						/>
					)}
				/>
				<FieldError id="org-name-error" message={errors.name?.message} />
				<div className="flex items-center justify-between gap-3">
					<span className="min-w-0 truncate font-mono text-ui-sm text-text-tertiary">
						{orgHost()}/<span className="text-text-secondary">{values.slug || "org"}</span>
					</span>
					<button
						type="button"
						aria-expanded={urlOpen}
						aria-controls="onboarding-customize"
						onClick={() => setCustomizing((open) => !open)}
						className="shrink-0 font-mono text-ui-xs text-text-tertiary transition-colors hover:text-text-primary focus-visible:text-text-primary"
					>
						{urlOpen ? "Done" : "Customize"}
					</button>
				</div>
				{urlOpen ? (
					<div id="onboarding-customize" className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<div className="flex h-[40px] items-center overflow-hidden border border-border-strong bg-surface-sunken">
								<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
									{orgHost()}/
								</span>
								<Controller
									control={form.control}
									name="slug"
									render={({ field }) => (
										<input
											ref={field.ref}
											aria-label="URL slug"
											aria-invalid={Boolean(errors.slug)}
											aria-describedby={errors.slug ? "org-slug-error" : undefined}
											className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
											value={field.value}
											autoComplete="off"
											disabled={pending}
											// A draft, so a hyphen can be typed (#5453); the trailing one is trimmed on
											// blur and on submit.
											onChange={(e) =>
												form.setValue("slug", slugifyDraft(e.target.value), { shouldDirty: true })
											}
											onBlur={() => {
												form.setValue("slug", finishSlugDraft(field.value), { shouldDirty: true });
												field.onBlur();
											}}
										/>
									)}
								/>
							</div>
							<FieldError id="org-slug-error" message={errors.slug?.message} />
						</div>
						<div className="flex flex-col gap-2.5">
							<span className={FIELD_LABEL}>Logo</span>
							<OrgLogoUpload name={values.name} logo={logo} onChange={setLogo} size={48} />
						</div>
					</div>
				) : null}
			</div>

			{plan === "team" ? <PayerFacts form={form} country={country} capacity={capacity} disabled={pending} /> : null}

			{terms.length > 0 ? <TermsBox form={form} documents={terms} disabled={pending} /> : null}

			<div className="mt-8 flex flex-col gap-3">
				<FormRootError form={form} />
				<WizardFormError message={wizard.formError} />
				<Button type="submit" disabled={pending} className="group h-[46px] w-full text-sm">
					{pending ? "Creating…" : "Create organization"}
					{!pending && (
						<ArrowRight className="size-4 transition-transform group-hover:translate-x-[3px]" />
					)}
				</Button>
				<p className="text-center font-mono text-ui-2xs text-text-tertiary">
					{plan === "team" && trial.kind === "available"
						? `${trial.days}-day Pro trial · no card required · cancel anytime`
						: "Free forever · upgrade whenever you’re ready"}
				</p>
			</div>
		</form>
	);
}

/** The form instance the field groups below write to. */
type OnboardingFormInstance = UseFormReturn<OnboardingValues, unknown, OnboardingOutput>;

/** A field's message, or nothing. Announced as an alert when it appears. */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
	if (!message) return null;
	return (
		<p id={id} role="alert" className="text-ui-xs text-destructive">
			{message}
		</p>
	);
}

/**
 * The plan, as a labelled radio group of two tiles (A-24). Hobby is the default; the Pro tile is
 * disabled with its reason written on it when the account cannot start the trial here.
 */
function PlanChoice({
	value,
	disabled,
	trial,
	onChange,
}: {
	value: "community" | "team";
	disabled: boolean;
	trial: OnboardingTrial;
	onChange: (plan: "community" | "team") => void;
}) {
	const labelId = useId();
	const name = useId();
	return (
		<div className="flex flex-col gap-2.5">
			<span id={labelId} className={FIELD_LABEL}>
				Plan
			</span>
			<div role="radiogroup" aria-labelledby={labelId} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<PlanTile
					name={name}
					checked={value === "community"}
					disabled={disabled}
					onSelect={() => onChange("community")}
					icon={<User className="size-4" />}
					useCase="Personal projects"
					planName="Hobby"
					price="Free"
					blurb="Your own projects — just you."
				/>
				<PlanTile
					name={name}
					checked={value === "team"}
					disabled={disabled || trial.kind === "unavailable"}
					onSelect={() => onChange("team")}
					icon={<Building2 className="size-4" />}
					useCase="Commercial projects"
					planName="Pro"
					price={trial.kind === "available" ? `${trial.days}-day trial` : "Unavailable"}
					blurb={
						trial.kind === "available"
							? "Organizations and teams. No card to start."
							: trial.reason
					}
				/>
			</div>
		</div>
	);
}

/** One plan tile: a native radio, visually hidden, inside a label that draws the tile. */
function PlanTile({
	name,
	checked,
	disabled,
	onSelect,
	icon,
	useCase,
	planName,
	price,
	blurb,
}: {
	name: string;
	checked: boolean;
	disabled: boolean;
	onSelect: () => void;
	icon: ReactNode;
	useCase: string;
	planName: string;
	price: string;
	blurb: string;
}) {
	return (
		<label
			className={cn(
				"relative flex flex-col gap-2 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
				disabled && !checked
					? "cursor-not-allowed border-border"
					: checked
						? "cursor-pointer border-text-primary bg-surface-muted ring-1 ring-text-primary"
						: "cursor-pointer border-border hover:border-border-strong hover:bg-surface-muted",
			)}
		>
			<input
				type="radio"
				name={name}
				className="sr-only"
				checked={checked}
				disabled={disabled}
				onChange={onSelect}
			/>
			<div className="flex items-center justify-between">
				<span className="flex size-7 items-center justify-center rounded-md border border-border-strong text-text-secondary">
					{icon}
				</span>
				<span
					aria-hidden="true"
					className={cn(
						"flex size-[18px] items-center justify-center rounded-full border",
						checked ? "border-ink bg-ink text-ink-foreground" : "border-border-strong text-transparent",
					)}
				>
					<Check size={11} strokeWidth={3} />
				</span>
			</div>
			<div className="mt-1">
				<div
					className={cn(
						"text-ui-lg font-medium",
						disabled && !checked ? "text-text-tertiary" : "text-text-primary",
					)}
				>
					{useCase}
				</div>
				<div className="mt-0.5 flex items-baseline gap-1.5">
					<span className="font-grotesk text-ui-md font-semibold text-text-secondary">{planName}</span>
					<span className="font-mono text-ui-2xs text-text-tertiary">· {price}</span>
				</div>
			</div>
			<p className="text-ui-xs leading-snug text-text-tertiary">{blurb}</p>
		</label>
	);
}

/**
 * What the purchase gate needs before a trial: the billing country (deduced, editable) and who is
 * buying (one switch, defaulted from the email). A business purchase also asks the person's role —
 * the one fact nothing can deduce.
 */
function PayerFacts({
	form,
	country,
	capacity,
	disabled,
}: {
	form: OnboardingFormInstance;
	country: DeducedCountry | null;
	capacity: PayerCapacity;
	disabled: boolean;
}) {
	const { errors } = useFormState({ control: form.control });
	const business = form.getValues("business");
	const countryLabelId = useId();
	const switchLabelId = useId();
	const switchHintId = useId();
	const chosen = form.getValues("billingCountry");
	const hint =
		country !== null && chosen === country.code
			? COUNTRY_SOURCE_HINT[country.source]
			: "The country this organization is billed in.";
	return (
		<div className="mt-6 flex flex-col gap-5">
			<div className="flex flex-col gap-2.5">
				<span id={countryLabelId} className={FIELD_LABEL}>
					Billing country
				</span>
				<Controller
					control={form.control}
					name="billingCountry"
					render={({ field }) => (
						<div aria-labelledby={countryLabelId} role="group">
							<CountrySelect
								id="billing-country"
								value={field.value}
								onChange={field.onChange}
								disabled={disabled}
								invalid={Boolean(errors.billingCountry)}
							/>
						</div>
					)}
				/>
				{errors.billingCountry?.message ? (
					<FieldError id="billing-country-error" message={errors.billingCountry.message} />
				) : (
					<p className="text-ui-xs text-text-tertiary">{hint}</p>
				)}
			</div>

			<div className="flex flex-col gap-2.5">
				<div className="flex items-start justify-between gap-4">
					<div className="flex min-w-0 flex-col gap-0.5">
						<span id={switchLabelId} className="text-ui-sm font-medium text-text-primary">
							Buying for a company
						</span>
						<span id={switchHintId} className="text-ui-xs leading-snug text-text-tertiary">
							{business
								? "Business terms apply, not consumer law."
								: "You're buying for yourself, and consumer law applies."}
							{capacity === "organization" && business ? " Suggested by your work email." : ""}
						</span>
					</div>
					<Controller
						control={form.control}
						name="business"
						render={({ field }) => (
							<Switch
								ref={field.ref}
								checked={field.value}
								onCheckedChange={(next) => field.onChange(next === true)}
								disabled={disabled}
								aria-labelledby={switchLabelId}
								aria-describedby={switchHintId}
							/>
						)}
					/>
				</div>
				{business ? (
					<div className="flex flex-col gap-1.5">
						<label htmlFor="payer-role" className={FIELD_LABEL}>
							Your role
						</label>
						<Controller
							control={form.control}
							name="role"
							render={({ field }) => (
								<Input
									id="payer-role"
									ref={field.ref}
									value={field.value}
									onChange={field.onChange}
									onBlur={field.onBlur}
									placeholder="Founder"
									autoComplete="organization-title"
									disabled={disabled}
									aria-invalid={Boolean(errors.role)}
									aria-describedby={errors.role ? "payer-role-error" : undefined}
									className="h-9"
								/>
							)}
						/>
						<FieldError id="payer-role-error" message={errors.role?.message} />
					</div>
				) : null}
			</div>
		</div>
	);
}

/**
 * Renders copy segments: plain text, or a link to a legal page that opens in a new tab. Text is a bare
 * text node, never a wrapping element: the box's accessible name is computed from this label, and a
 * wrapper per run drops the spaces at each run's edge ("theTerms of Service(version …)").
 */
function Segments({ segments }: { segments: readonly CopySegment[] }) {
	return (
		<>
			{segments.map((segment, i) =>
				segment.kind === "link" ? (
					<a
						key={`${segment.documentId}-${i}`}
						href={segment.href}
						target="_blank"
						rel="noopener noreferrer"
						className="underline underline-offset-4 hover:text-text-primary"
					>
						{segment.text}
					</a>
				) : (
					<Fragment key={`text-${i}`}>{segment.text}</Fragment>
				),
			)}
		</>
	);
}

/**
 * The terms acceptance, inline: one UNTICKED box whose label names each document with its link and
 * its sealed version, and the Privacy Policy linked underneath as a notice. The wording is the copy
 * module's; this only draws it.
 */
function TermsBox({
	form,
	documents,
	disabled,
}: {
	form: OnboardingFormInstance;
	documents: readonly AcceptanceDocument[];
	disabled: boolean;
}) {
	const { errors } = useFormState({ control: form.control });
	const labelId = useId();
	// The schema's fallback names the Terms in general; the copy module names exactly the documents
	// this box covers, so its sentence is what is shown.
	const message = errors.acceptTerms ? requiredMessage(documents) : undefined;
	const notice = noticeLine();
	return (
		<div className="mt-7 flex flex-col gap-2">
			<label className="flex cursor-pointer items-start gap-3 text-ui-sm text-text-secondary">
				<Controller
					control={form.control}
					name="acceptTerms"
					render={({ field }) => (
						<Checkbox
							ref={field.ref}
							checked={field.value}
							onCheckedChange={(next) => field.onChange(next === true)}
							disabled={disabled}
							aria-labelledby={labelId}
							aria-invalid={Boolean(errors.acceptTerms)}
							aria-describedby={message ? "accept-terms-error" : undefined}
							className="mt-0.5"
						/>
					)}
				/>
				<span id={labelId}>
					<Segments segments={checkboxLabel(documents)} />
				</span>
			</label>
			{notice.length > 0 ? (
				<p className="pl-7 text-ui-xs text-text-tertiary">
					<Segments segments={notice} />
				</p>
			) : null}
			<div className="pl-7">
				<FieldError id="accept-terms-error" message={message} />
			</div>
		</div>
	);
}
