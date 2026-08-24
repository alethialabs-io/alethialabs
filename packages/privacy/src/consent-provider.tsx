// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useForm } from "react-hook-form";
import {
	analyticsAllowed,
	CONSENT_EVENT,
	consentPreferencesSchema,
	type ConsentPreferences,
	type ConsentRecord,
	globalPrivacyControlEnabled,
	purgePostHogStorage,
	readConsent,
	writeConsent,
} from "./consent";

interface ConsentContextValue {
	consent: ConsentRecord | null;
	hasDecision: boolean;
	/**
	 * Whether optional analytics may actually run. Consumers read THIS, never `consent.analytics` —
	 * it folds in Global Privacy Control, which a stored `analytics: true` must not override.
	 */
	analyticsAllowed: boolean;
	/** The browser is asserting Global Privacy Control, so the optional choice is not offered. */
	gpc: boolean;
	openPreferences: () => void;
	save: (preferences: ConsentPreferences) => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

/** Return the current consent decision and controls for privacy-aware clients. */
export function useConsent(): ConsentContextValue {
	const context = useContext(ConsentContext);
	if (!context) {
		throw new Error("useConsent must be used inside ConsentProvider.");
	}
	return context;
}

interface ConsentProviderProps {
	children: ReactNode;
	/** Deployment-aware destination for the cookie notice. */
	cookieNoticeHref?: string;
}

/**
 * Shared consent state, the first-visit notice, and the preferences dialog.
 *
 * There is deliberately no floating launcher: it covered the console's sidebar
 * profile. Consent stays withdrawable from a real control in each surface — the
 * account menu in the console (`components/shell/sidebar-profile.tsx`) and the
 * footer on the marketing site — both of which call `openPreferences()`.
 */
export function ConsentProvider({
	children,
	cookieNoticeHref = "/cookies",
}: ConsentProviderProps) {
	const [consent, setConsent] = useState<ConsentRecord | null>(null);
	const [ready, setReady] = useState(false);
	const [gpc, setGpc] = useState(false);
	const [preferencesOpen, setPreferencesOpen] = useState(false);

	useEffect(() => {
		setConsent(readConsent());
		// Read after mount, never during render: navigator is absent server-side, and a value that
		// differed between the server and client render would hydrate inconsistently.
		setGpc(globalPrivacyControlEnabled());
		setReady(true);

		/** Synchronize consumers after a choice changes in this document. */
		const onConsent = (event: Event) => {
			if (event instanceof CustomEvent) {
				const parsed = consentPreferencesSchema.safeParse(event.detail);
				if (parsed.success) setConsent(readConsent());
			}
		};
		window.addEventListener(CONSENT_EVENT, onConsent);
		return () => window.removeEventListener(CONSENT_EVENT, onConsent);
	}, []);

	const save = useCallback((preferences: ConsentPreferences) => {
		const previous = readConsent();
		setConsent(writeConsent(preferences));
		setPreferencesOpen(false);
		// Withdrawal deletes the identifiers HERE, synchronously, before the reload below.
		// Relying on the effect cleanup does not work: `save` reloads in the same tick, so React
		// never commits the state change and the cleanup that would have called reset() is not
		// reached. The AnalyticsProvider purges again after the reload; both are cheap and
		// idempotent, and the failure mode of doing it once is identifiers that never go.
		if (!preferences.analytics) purgePostHogStorage();
		// A reload is how an already-initialised analytics SDK stops: posthog-js cannot be fully
		// unloaded in place. The identifiers are deleted by the AnalyticsProvider, which watches the
		// same decision — doing it here too would duplicate the rule in two files.
		if (previous && previous.analytics !== preferences.analytics) {
			window.location.reload();
		}
	}, []);

	const value = useMemo<ConsentContextValue>(
		() => ({
			consent,
			hasDecision: consent !== null,
			analyticsAllowed: analyticsAllowed(consent),
			gpc,
			openPreferences: () => setPreferencesOpen(true),
			save,
		}),
		[consent, gpc, save],
	);

	return (
		<ConsentContext.Provider value={value}>
			{children}
			{ready && consent === null ? (
				<ConsentNotice
					// Under GPC the accept path still records a decision — so the notice stops
					// reappearing — but it cannot turn analytics on. `analyticsAllowed` is what the
					// SDKs read, and it refuses regardless of what is stored.
					onAccept={() => save({ analytics: !gpc })}
					onReject={() => save({ analytics: false })}
					onCustomize={() => setPreferencesOpen(true)}
					cookieNoticeHref={cookieNoticeHref}
					gpc={gpc}
				/>
			) : null}
			{preferencesOpen ? (
				<ConsentPreferencesDialog
					initial={consent ?? { analytics: false }}
					gpc={gpc}
					onClose={() => setPreferencesOpen(false)}
					onSave={save}
				/>
			) : null}
		</ConsentContext.Provider>
	);
}

interface ConsentNoticeProps {
	onAccept: () => void;
	onReject: () => void;
	onCustomize: () => void;
	cookieNoticeHref: string;
	gpc: boolean;
}

/**
 * First-visit notice with equally prominent accept, reject, and customize controls.
 *
 * Right-anchored and width-capped at every breakpoint. It used to be `inset-x-4`
 * with only an `sm:` escape, so below 640px it spanned the viewport and covered
 * the console's sidebar profile.
 */
function ConsentNotice({
	onAccept,
	onReject,
	onCustomize,
	cookieNoticeHref,
	gpc,
}: ConsentNoticeProps) {
	return (
		<section
			aria-label="Privacy choices"
			className="fixed inset-x-4 bottom-4 z-[90] ml-auto max-w-[28rem] rounded-lg border border-border bg-background p-5 shadow-xl sm:left-auto sm:w-[28rem] sm:p-6"
		>
			<div className="grid gap-5">
				<div>
					<p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
						Your privacy
					</p>
					<h2 className="mt-2 font-[family-name:var(--font-space-grotesk)] text-lg font-semibold text-foreground">
						Non-essential telemetry is off until you choose.
					</h2>
					<p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
						{gpc
							? "Essential cookies keep the service secure. Your browser is sending Global Privacy Control, so optional analytics stays off — we honour that signal and it overrides the choice below."
							: "Essential cookies keep the service secure. With permission, product analytics helps us improve Alethia. You can change your choice at any time."}
					</p>
					<a
						href={cookieNoticeHref}
						className="mt-3 inline-block text-xs text-foreground underline underline-offset-4"
					>
						Cookie notice
					</a>
				</div>
				{/*
				  * Accept and reject share one row, the same component and the same width, so neither
				  * reads as the expected answer. "Equally visible" is a requirement, not a nicety:
				  * a reject that is smaller, greyer or further down is a dark pattern, and a stacked
				  * list makes whichever is on top the default-looking one.
				  */}
				<div className="grid gap-2">
					<div className="grid grid-cols-2 gap-2">
						<ChoiceButton onClick={onAccept}>Accept analytics</ChoiceButton>
						<ChoiceButton onClick={onReject}>Reject analytics</ChoiceButton>
					</div>
					<ChoiceButton onClick={onCustomize}>Customize</ChoiceButton>
				</div>
			</div>
		</section>
	);
}

/** Consistent neutral action used by the consent surfaces. */
function ChoiceButton({
	children,
	onClick,
	type = "button",
}: {
	children: ReactNode;
	onClick?: () => void;
	type?: "button" | "submit";
}) {
	return (
		<button
			type={type}
			onClick={onClick}
			className="min-h-10 rounded-md border border-border-strong bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			{children}
		</button>
	);
}

interface ConsentPreferencesDialogProps {
	initial: ConsentPreferences;
	gpc: boolean;
	onClose: () => void;
	onSave: (preferences: ConsentPreferences) => void;
}

/** Modal editor for the one optional purpose. */
function ConsentPreferencesDialog({
	initial,
	gpc,
	onClose,
	onSave,
}: ConsentPreferencesDialogProps) {
	const form = useForm<ConsentPreferences>({
		resolver: zodResolver(consentPreferencesSchema),
		defaultValues: initial,
	});

	return (
		<div
			className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4"
			role="presentation"
			onMouseDown={(event) => {
				if (event.currentTarget === event.target) onClose();
			}}
		>
			<section
				role="dialog"
				aria-modal="true"
				aria-labelledby="privacy-preferences-title"
				className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl"
			>
				<p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
					Privacy controls
				</p>
				<h2
					id="privacy-preferences-title"
					className="mt-2 font-[family-name:var(--font-space-grotesk)] text-xl font-semibold text-foreground"
				>
					Choose what Alethia may collect.
				</h2>
				<form
					className="mt-6 space-y-3"
					onSubmit={form.handleSubmit(onSave)}
				>
					<PreferenceRow
						title="Essential storage"
						description="Authentication, security, load balancing, and this consent record."
						checked
						disabled
					/>
					{/*
					  * Under GPC the control is shown DISABLED and off rather than hidden. Hiding it
					  * would leave someone unable to see why analytics is off, or that a signal they
					  * set is being honoured at all.
					  */}
					<PreferenceRow
						title="Product analytics"
						description={
							gpc
								? "Off: your browser is sending Global Privacy Control, which we honour as a standing opt-out."
								: "Pseudonymous usage, page events, performance, and error diagnostics. No prompt or model-output content."
						}
						{...(gpc
							? { checked: false, disabled: true }
							: form.register("analytics"))}
					/>
					<div className="flex flex-col-reverse gap-2 pt-3 sm:flex-row sm:justify-end">
						<ChoiceButton onClick={onClose}>Cancel</ChoiceButton>
						<ChoiceButton type="submit">Save choices</ChoiceButton>
					</div>
				</form>
			</section>
		</div>
	);
}

interface PreferenceRowProps {
	title: string;
	description: string;
	checked?: boolean;
	disabled?: boolean;
	name?: string;
	onBlur?: React.FocusEventHandler<HTMLInputElement>;
	onChange?: React.ChangeEventHandler<HTMLInputElement>;
	ref?: React.Ref<HTMLInputElement>;
}

/** Accessible checkbox row for one consent purpose. */
function PreferenceRow({
	title,
	description,
	checked,
	disabled,
	...input
}: PreferenceRowProps) {
	return (
		<label className="flex cursor-pointer gap-4 rounded-md border border-border p-4">
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				className="mt-1 size-4 accent-foreground"
				{...input}
			/>
			<span>
				<span className="block text-sm font-medium text-foreground">{title}</span>
				<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
					{description}
				</span>
			</span>
		</label>
	);
}
