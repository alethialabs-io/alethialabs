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
	useSyncExternalStore,
} from "react";
import { useForm } from "react-hook-form";
import {
	analyticsAllowed,
	CONSENT_EVENT,
	CONSENT_LABELS,
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

/** The browser-only facts the provider learns after mount. */
interface ConsentSnapshot {
	consent: ConsentRecord | null;
	gpc: boolean;
}

/**
 * Where the consent decision lives, OUTSIDE React context.
 *
 * WHY NOT `useState` IN THE PROVIDER (#5786). The decision is a cookie, so the server renders
 * "no decision" and the browser learns the real one after mount. When that answer was provider
 * state, learning it changed the CONTEXT VALUE — and this provider sits at the root of every app,
 * with consumers (the console's `AnalyticsProvider`) wrapping the whole page below it. The change
 * propagated through those consumers into every Suspense boundary still waiting for its streamed
 * HTML, and React's rule for a dehydrated boundary that receives an update before its content has
 * arrived is to stop waiting and render it on the client, silently, throwing the server's streamed
 * copy away. Every returning visitor (anyone who answered the notice, every e2e session) therefore
 * lost the server render of whatever the page streamed — measured on the connectors board as a
 * second, hidden filter bar on 19 of 20 loads (#5777, #5784).
 *
 * So the context carries only this store, which never changes identity, and each consumer
 * subscribes to it with `useSyncExternalStore`. A changed decision re-renders exactly the
 * components that read it, and reaches no boundary that has not hydrated yet.
 */
interface ConsentStore {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => ConsentSnapshot;
	set: (next: ConsentSnapshot) => void;
}

/** What the server renders with, and what every consumer hydrates against: no decision, no GPC. */
const SERVER_SNAPSHOT: ConsentSnapshot = { consent: null, gpc: false };

/** The server (and hydration) snapshot, shared so React sees one stable value. */
function getServerSnapshot(): ConsentSnapshot {
	return SERVER_SNAPSHOT;
}

/** A store holding one snapshot; `set` replaces it and notifies every subscriber. */
function createConsentStore(): ConsentStore {
	let snapshot = SERVER_SNAPSHOT;
	const listeners = new Set<() => void>();
	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
		set(next) {
			snapshot = next;
			for (const listener of listeners) listener();
		},
	};
}

/** The store a hook reads when no provider is mounted: it never changes. */
const DETACHED_STORE = createConsentStore();

/** What the context carries. Every field is referentially stable for the provider's lifetime. */
interface ConsentHandle {
	store: ConsentStore;
	openPreferences: () => void;
	save: (preferences: ConsentPreferences) => void;
}

const ConsentContext = createContext<ConsentHandle | null>(null);

/** Subscribe to `handle`'s store and assemble the public value; `null` when there is no handle. */
function useConsentValue(handle: ConsentHandle | null): ConsentContextValue | null {
	const store = handle?.store ?? DETACHED_STORE;
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
	return useMemo(
		() =>
			handle
				? {
						consent: snapshot.consent,
						hasDecision: snapshot.consent !== null,
						analyticsAllowed: analyticsAllowed(snapshot.consent),
						gpc: snapshot.gpc,
						openPreferences: handle.openPreferences,
						save: handle.save,
					}
				: null,
		[handle, snapshot],
	);
}

/** Return the current consent decision and controls for privacy-aware clients. */
export function useConsent(): ConsentContextValue {
	const value = useConsentValue(useContext(ConsentContext));
	if (!value) {
		throw new Error("useConsent must be used inside ConsentProvider.");
	}
	return value;
}

/**
 * The same value, or `null` where no provider is mounted.
 *
 * Shared chrome cannot assume its host mounted a specific provider. The site
 * footer carries the consent control, and the moment that footer was shared with
 * `apps/blog` — which had no `ConsentProvider` — the strict hook threw during
 * prerender and took the whole build down. Neither tsc nor eslint can see that;
 * only a production build did. A component that may render anywhere reads consent
 * through this and degrades instead of exploding.
 */
/**
 * The ONE Node global this browser package touches, declared rather than pulled in.
 *
 * `packages/email` reaches for `@types/node` for the same identifier, but it runs on a server.
 * This package renders in a browser, and `@types/node` would also make `fs.readFileSync` and
 * friends typecheck inside a client component — a much bigger door than the one identifier
 * needs. Bundlers (Next, webpack, Vite) statically replace this expression, so the `typeof`
 * check folds and the warning below is dropped from production builds entirely.
 */
declare const process: { env: { NODE_ENV?: string } };

/** Module-scoped so the dev warning below fires ONCE. It sits in a render body, and a missing
 * provider means every consent-reading component on the page warns on every render — under
 * StrictMode's double-invoke that is a wall of identical lines nobody reads to the end of. */
let warnedNoProvider = false;

export function useOptionalConsent(): ConsentContextValue | null {
	const handle = useContext(ConsentContext);
	const context = useConsentValue(handle);
	// DEGRADING IS NOT THE SAME AS SAYING NOTHING.
	//
	// The strict hook threw, which is how the blog's missing provider was found at all — as the
	// comment above says, neither tsc nor eslint could see it and only a production build did.
	// Removing the throw was right, but it turned a LOUD failure into a SILENT one: a host that
	// forgets the provider now renders no consent control and every gate stays green. For a control
	// the design calls legally load-bearing, silently absent is a worse outcome than a broken build,
	// because nothing surfaces it until somebody looks at the rendered page.
	//
	// So the net stays and the silence does not. Dev-only: the warning is for whoever is wiring a
	// new host, and a production bundle should not carry it.
	if (
		context === null &&
		!warnedNoProvider &&
		typeof process !== "undefined" &&
		process.env.NODE_ENV !== "production"
	) {
		warnedNoProvider = true;
		console.warn(
			"[@repo/privacy] useOptionalConsent: no ConsentProvider above this component. " +
				"Consent-dependent UI (including the cookie-settings control in the shared site footer) " +
				"will render nothing. If this host is meant to offer consent, wrap it in <ConsentProvider>.",
		);
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
	// Created once per provider; its identity is what keeps the context value stable (see
	// `ConsentStore` for why that matters).
	const [store] = useState(createConsentStore);
	// The provider renders the notice and the dialog from the same store its consumers read.
	const { consent, gpc } = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		getServerSnapshot,
	);
	const [ready, setReady] = useState(false);
	const [preferencesOpen, setPreferencesOpen] = useState(false);

	useEffect(() => {
		// Read after mount, never during render: the cookie and navigator are browser facts, and a
		// value that differed between the server and client render would hydrate inconsistently.
		store.set({ consent: readConsent(), gpc: globalPrivacyControlEnabled() });
		setReady(true);

		/** Synchronize consumers after a choice changes in this document. */
		const onConsent = (event: Event) => {
			if (event instanceof CustomEvent) {
				const parsed = consentPreferencesSchema.safeParse(event.detail);
				if (parsed.success) store.set({ ...store.getSnapshot(), consent: readConsent() });
			}
		};
		window.addEventListener(CONSENT_EVENT, onConsent);
		return () => window.removeEventListener(CONSENT_EVENT, onConsent);
	}, [store]);

	const save = useCallback(
		(preferences: ConsentPreferences) => {
			const previous = readConsent();
			store.set({ ...store.getSnapshot(), consent: writeConsent(preferences) });
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
		},
		[store],
	);

	const openPreferences = useCallback(() => setPreferencesOpen(true), []);

	// Stable for the provider's lifetime: a decision learnt or changed after mount must not change
	// the context value (see `ConsentStore`).
	const value = useMemo<ConsentHandle>(
		() => ({ store, openPreferences, save }),
		[store, openPreferences, save],
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
						<ChoiceButton onClick={onAccept}>{CONSENT_LABELS.accept}</ChoiceButton>
						<ChoiceButton onClick={onReject}>{CONSENT_LABELS.reject}</ChoiceButton>
					</div>
					<ChoiceButton onClick={onCustomize}>
						{CONSENT_LABELS.customize}
					</ChoiceButton>
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
