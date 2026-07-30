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
	CONSENT_EVENT,
	consentPreferencesSchema,
	type ConsentPreferences,
	type ConsentRecord,
	readConsent,
	writeConsent,
} from "./consent";

interface ConsentContextValue {
	consent: ConsentRecord | null;
	hasDecision: boolean;
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
	/** Show the floating preferences launcher after the visitor has chosen. */
	showPersistentTrigger?: boolean;
	/** Deployment-aware destination for the cookie notice. */
	cookieNoticeHref?: string;
}

/** Shared consent state, first-visit notice, and persistent preferences control. */
export function ConsentProvider({
	children,
	showPersistentTrigger = true,
	cookieNoticeHref = "/cookies",
}: ConsentProviderProps) {
	const [consent, setConsent] = useState<ConsentRecord | null>(null);
	const [ready, setReady] = useState(false);
	const [preferencesOpen, setPreferencesOpen] = useState(false);

	useEffect(() => {
		setConsent(readConsent());
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
		if (
			previous &&
			(previous.analytics !== preferences.analytics ||
				previous.replay !== preferences.replay)
		) {
			window.location.reload();
		}
	}, []);

	const value = useMemo<ConsentContextValue>(
		() => ({
			consent,
			hasDecision: consent !== null,
			openPreferences: () => setPreferencesOpen(true),
			save,
		}),
		[consent, save],
	);

	return (
		<ConsentContext.Provider value={value}>
			{children}
			{ready && consent === null ? (
				<ConsentNotice
					onAccept={() => save({ analytics: true, replay: true })}
					onReject={() => save({ analytics: false, replay: false })}
					onCustomize={() => setPreferencesOpen(true)}
					cookieNoticeHref={cookieNoticeHref}
				/>
			) : null}
			{ready && consent !== null && showPersistentTrigger ? (
				<button
					type="button"
					onClick={() => setPreferencesOpen(true)}
					className="fixed bottom-4 right-4 z-[80] rounded-md border border-border bg-background px-3 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					Privacy choices
				</button>
			) : null}
			{preferencesOpen ? (
				<ConsentPreferencesDialog
					initial={consent ?? { analytics: false, replay: false }}
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
}

/** First-visit notice with equally prominent accept, reject, and customize controls. */
function ConsentNotice({
	onAccept,
	onReject,
	onCustomize,
	cookieNoticeHref,
}: ConsentNoticeProps) {
	return (
		<section
			aria-label="Privacy choices"
			className="fixed inset-x-4 bottom-4 z-[90] rounded-lg border border-border bg-background p-5 shadow-xl sm:left-auto sm:w-[28rem] sm:p-6"
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
						Essential cookies keep the service secure. With permission, analytics
						helps us improve Alethia and replay helps diagnose interface failures.
						You can change either choice at any time.
					</p>
					<a
						href={cookieNoticeHref}
						className="mt-3 inline-block text-xs text-foreground underline underline-offset-4"
					>
						Cookie notice
					</a>
				</div>
				<div className="grid grid-cols-1 gap-2">
					<ChoiceButton onClick={onAccept}>Accept all</ChoiceButton>
					<ChoiceButton onClick={onReject}>Reject non-essential</ChoiceButton>
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
	onClose: () => void;
	onSave: (preferences: ConsentPreferences) => void;
}

/** Modal editor for independent analytics and replay consent. */
function ConsentPreferencesDialog({
	initial,
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
					<PreferenceRow
						title="Product analytics"
						description="Pseudonymous usage, page events, performance, and error diagnostics. No prompt or model-output content."
						{...form.register("analytics")}
					/>
					<PreferenceRow
						title="Session replay"
						description="A masked recording used to reproduce interface failures. Inputs are obscured and replay has its own opt-in."
						{...form.register("replay")}
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
