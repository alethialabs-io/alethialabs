"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The consent screen (AGT-L2, SPEC §5b), every state of it: the form, and the pages with nothing
// left to decide — opened directly, expired, already answered, no Alethia permissions asked for,
// switching account, denied and allowed.
//
// NOTHING IS GRANTED HERE. Allow and Deny call `answerAgentConsent`, which checks the signed request,
// the org's kill switch and allow-list, the role and the projects, hands the narrowed answer to Better
// Auth and writes the grant — and only then returns the redirect back to the app. Leaving the page,
// switching account or a failed call grants nothing; the request stays answerable until it expires.

import { LogIn, TriangleAlert } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { AUTH_SHELL_SIGN_OUT_FAILED } from "@/components/auth/auth-shell";
import { hardNavigate } from "@/components/shell/hard-navigate";
import { signOutOfConsole } from "@/components/shell/sign-out";
import { answerAgentConsent, type ConsentAnswer } from "@/app/server/actions/agents/consent";
import type { ActionResult } from "@/lib/actions/result";
import { authClient } from "@/lib/auth/client";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";
import { clearAllWizardDrafts } from "@/lib/wizard/draft";
import { COPY, EYEBROW, EYEBROW_CONNECTED, MESSAGES } from "./consent-copy";
import { type ConsentAccount, type ConsentChoice, ConsentForm } from "./consent-form";
import { ConsentHeading } from "./consent-heading";
import type { ConsentView, ReadyConsent } from "./consent-model";

/** How long "You denied {App}" stays up before the redirect back to the app (SPEC §5b, case 17). */
export const DENIED_REDIRECT_MS = 1500;

/** Where the screen is. `form` covers submitting, a network error and a refusal. */
type ConsentPhase =
	| { kind: "form" }
	| { kind: "switch" }
	| { kind: "denied"; url: string }
	| { kind: "allowed"; url: string; orgName: string }
	| { kind: "ended"; why: "expired" | "answered" | "invalid" };

/** The answer an action gave, as the phase to show next (or null to stay on the form). */
function phaseForAnswer(answer: ConsentAnswer, accept: boolean, orgName: string): ConsentPhase {
	switch (answer.outcome) {
		case "redirect":
			return accept ? { kind: "allowed", url: answer.url, orgName } : { kind: "denied", url: answer.url };
		case "expired":
			return { kind: "ended", why: "expired" };
		case "answered":
			return { kind: "ended", why: "answered" };
		case "invalid":
			return { kind: "ended", why: "invalid" };
	}
}

interface ConsentScreenProps {
	view: ConsentView;
	account: ConsentAccount;
	/** The signed request, handed back to Better Auth on submit. */
	oauthQuery: string;
	/** Where "Manage connections" goes. */
	manageHref: string;
}

/** The consent screen. */
export function ConsentScreen({ view, account, oauthQuery, manageHref }: ConsentScreenProps) {
	if (view.state !== "ready") {
		if (view.state === "missing") return <Message title={MESSAGES.none.title} body={MESSAGES.none.body} />;
		return <Ended why={view.state === "malformed" ? "invalid" : view.state} />;
	}
	return <ReadyScreen consent={view} account={account} oauthQuery={oauthQuery} manageHref={manageHref} />;
}

/** The request is readable: decide it, or one of the states that follow a decision. */
function ReadyScreen({
	consent,
	account,
	oauthQuery,
	manageHref,
}: {
	consent: ReadyConsent;
	account: ConsentAccount;
	oauthQuery: string;
	manageHref: string;
}) {
	const appName = consent.identity.name;
	const [phase, setPhase] = useState<ConsentPhase>({ kind: "form" });
	const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);
	const [networkError, setNetworkError] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [switching, setSwitching] = useState(false);

	// Allowed: back to the app at once. Denied: say so briefly, then go back.
	useEffect(() => {
		if (phase.kind === "allowed") hardNavigate(phase.url);
		if (phase.kind !== "denied") return;
		const timer = window.setTimeout(() => hardNavigate(phase.url), DENIED_REDIRECT_MS);
		return () => window.clearTimeout(timer);
	}, [phase]);

	/** Sends the answer; a call that never reaches Alethia keeps the form and its choices. */
	const answer = async (accept: boolean, choice?: ConsentChoice) => {
		if (submitting) return;
		setSubmitting(accept ? "allow" : "deny");
		setNetworkError(false);
		setRefusal(null);
		let result: ActionResult<ConsentAnswer>;
		try {
			result = await answerAgentConsent({ oauthQuery, accept, ...choice });
		} catch {
			setNetworkError(true);
			setSubmitting(null);
			return;
		}
		setSubmitting(null);
		if (!result.ok) {
			// A refusal says why in its own words (the org changed under the person, a project went
			// away); anything else is reported as the call failing, with nothing granted.
			if (result.error.kind === "conflict") setRefusal(result.error.message);
			else setNetworkError(true);
			return;
		}
		const orgName = consent.orgs.find((o) => o.id === choice?.orgId)?.name ?? "";
		setPhase(phaseForAnswer(result.data, accept, orgName));
	};

	/** Signs out and comes back to this request after signing in as someone else. */
	const switchAccount = async () => {
		if (switching) return;
		setSwitching(true);
		const back = `/auth/oauth/consent?${oauthQuery}`;
		const outcome = await signOutOfConsole({
			endSession: () => authClient.signOut(),
			forgetAccount: () => useAuthPrefsStore.getState().forget(),
			clearWizardDrafts: clearAllWizardDrafts,
			leave: () => hardNavigate(`/login?next=${encodeURIComponent(back)}`),
		});
		if (outcome === "failed") {
			setSwitching(false);
			toast.error(AUTH_SHELL_SIGN_OUT_FAILED);
		}
	};

	if (phase.kind === "ended") return <Ended why={phase.why} />;
	if (phase.kind === "denied") {
		const m = MESSAGES.denied(appName);
		return <Message title={m.title} body={m.body} closable />;
	}
	if (phase.kind === "allowed") {
		const m = MESSAGES.allowed(appName, phase.orgName);
		return (
			<Message eyebrow={EYEBROW_CONNECTED} title={m.title} body={m.body}>
				<div className="flex flex-wrap gap-2">
					<Button nativeButton={false} render={<a href={phase.url} />}>
						{m.ret}
					</Button>
					<Button variant="outline" nativeButton={false} render={<a href={manageHref} />}>
						{m.manage}
					</Button>
				</div>
			</Message>
		);
	}
	if (phase.kind === "switch") {
		const m = MESSAGES.switchAccount(appName);
		return (
			<Message title={m.title} body={m.body}>
				<div className="flex flex-wrap gap-2">
					<Button onClick={() => void switchAccount()} pending={switching}>
						<LogIn aria-hidden />
						{m.action}
					</Button>
					<Button variant="outline" onClick={() => setPhase({ kind: "form" })} disabled={switching}>
						{COPY.back}
					</Button>
				</div>
			</Message>
		);
	}

	if (consent.requested.agent.length === 0) {
		const m = MESSAGES.noScopes(appName);
		const guide = consent.verified ? consent.identity.app?.docsPath : undefined;
		return (
			<Message title={m.title} body={m.body}>
				<div className="flex flex-wrap gap-2">
					<Button onClick={() => void answer(false)} pending={submitting === "deny"}>
						{COPY.deny}
					</Button>
					{guide ? (
						<Button variant="outline" nativeButton={false} render={<a href={guide} />}>
							{COPY.setupGuide}
						</Button>
					) : null}
				</div>
				{networkError ? <NetworkAlert /> : null}
			</Message>
		);
	}

	return (
		<ConsentForm
			consent={consent}
			account={account}
			submitting={submitting !== null}
			allowing={submitting === "allow"}
			networkError={networkError}
			refusal={refusal}
			onAllow={(choice) => void answer(true, choice)}
			onDeny={() => void answer(false)}
			onSwitchAccount={() => setPhase({ kind: "switch" })}
		/>
	);
}

/** "Couldn't reach Alethia": the answer never arrived, so nothing was granted (SPEC §5b, case 16). */
function NetworkAlert() {
	return (
		<Alert role="alert" className="border-foreground">
			<TriangleAlert aria-hidden />
			<AlertTitle>{COPY.networkTitle}</AlertTitle>
			<AlertDescription>{COPY.networkBody}</AlertDescription>
		</Alert>
	);
}

/** A request that can no longer be answered. */
function Ended({ why }: { why: "expired" | "answered" | "invalid" }) {
	const m = MESSAGES[why];
	return <Message title={m.title} body={m.body} closable />;
}

/** A page with nothing to decide: heading, sentence, and its actions. */
function Message({
	eyebrow = EYEBROW,
	title,
	body,
	closable = false,
	children,
}: {
	eyebrow?: string;
	title: string;
	body: string;
	closable?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<div className="space-y-6">
			<ConsentHeading eyebrow={eyebrow} title={title}>
				{body}
			</ConsentHeading>
			{children}
			{closable ? (
				<Button variant="outline" onClick={() => window.close()}>
					{COPY.close}
				</Button>
			) : null}
		</div>
	);
}
