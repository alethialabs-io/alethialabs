"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";
import Link from "next/link";
import { MailQuestion } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { authClient } from "@/lib/auth/client";
import { useViewer } from "@/components/providers/viewer-provider";
import { hardNavigate } from "@/components/shell/hard-navigate";
import { signOutOfConsole } from "@/components/shell/sign-out";
import { AUTH } from "@/lib/copy/vocabulary";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";
import { clearAllWizardDrafts } from "@/lib/wizard/draft";
import {
	type InvitationRead,
	invitationActionFailure,
	readInvitation,
} from "./invitation";

/** The heading every card on this route shares its type with. */
const HEADING =
	"font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary";

/**
 * `/invites/accept?token=…&email=…` — what an invitation email links to.
 *
 * The invitation is READ before anything is offered (A-20): the card names the organization and
 * who invited you, an invitation addressed to another account says so (with the way to switch)
 * instead of offering an Accept that can only be refused, and an expired or used one says that
 * instead of failing on the press. Accepting lands in the inviting organization (A-02) — not in
 * `/dashboard`, which would send a brand-new invitee through creating an organization of their
 * own first.
 */
function AcceptInvite({ completeSetup }: { completeSetup: () => Promise<void> }) {
	const router = useRouter();
	const params = useSearchParams();
	const token = params.get("token");
	const invitedEmail = invitedAddressFrom(params.get("email"));
	const { viewer, isPending } = useViewer();

	// Not signed in → the sign-in page, returning here afterwards (?next=), with the invited
	// address filled in. An address with no account yet is offered "Create an account" there,
	// which carries the same `next` — and a new account whose `next` is an invitation comes
	// straight back here rather than through onboarding (components/auth/auth-form.tsx).
	useEffect(() => {
		if (isPending || viewer || !token) return;
		const next = `/invites/accept?${new URLSearchParams({ token, ...(invitedEmail ? { email: invitedEmail } : {}) }).toString()}`;
		const qs = new URLSearchParams({ next });
		if (invitedEmail) qs.set("email", invitedEmail);
		router.replace(`/login?${qs.toString()}`);
	}, [isPending, viewer, token, invitedEmail, router]);

	const invitation = useQuery({
		queryKey: ["invitation", token, viewer?.id ?? null],
		queryFn: () => readInvitation(token ?? ""),
		enabled: token !== null && viewer !== null,
		retry: false,
		staleTime: Infinity,
	});

	if (!token) {
		return (
			<Message
				title="Invalid invitation"
				body="This invitation link is incomplete. Open the link in your invitation email again, or ask the person who invited you to send a new one."
				action={<GoToConsole />}
			/>
		);
	}
	if (isPending || !viewer || invitation.isPending) return <InviteSkeleton />;

	// `readInvitation` answers every failure as a value; a throw past it is still "failed".
	const read: InvitationRead = invitation.data ?? { kind: "failed" };
	switch (read.kind) {
		case "ready":
			return (
				<InvitationCard
					token={token}
					invitation={read.invitation}
					viewerEmail={viewer.email}
					completeSetup={completeSetup}
				/>
			);
		case "not-recipient":
			return <WrongAccount viewerEmail={viewer.email} invitedEmail={invitedEmail} token={token} />;
		case "unavailable":
			return (
				<Message
					title="This invitation is no longer valid"
					body="It has expired, been used, or been withdrawn. Ask the person who invited you to send a new one."
					action={<GoToConsole />}
				/>
			);
		case "verify-email":
			return (
				<Message
					title="Verify your email first"
					body={`This organization only admits verified addresses. Verify ${viewer.email}, then open the invitation link again.`}
					action={<GoToConsole />}
				/>
			);
		case "failed":
			return (
				<Message
					title="We couldn’t load this invitation"
					body="Something went wrong on our side or with the connection. Your invitation is unchanged."
					action={
						<Button onClick={() => void invitation.refetch()} pending={invitation.isFetching}>
							Try again
						</Button>
					}
				/>
			);
	}
}

/**
 * The `email` the invitation link carries, when it is an email address — otherwise null. It is
 * only ever used to prefill sign-in and to NAME the invited address on the wrong-account card, and
 * a link is anybody's to edit, so nothing that is not an address is put on screen as one.
 */
function invitedAddressFrom(raw: string | null): string | null {
	if (raw === null || raw.length > 254) return null;
	return z.email().safeParse(raw).success ? raw : null;
}

/** The read invitation, as the card needs it. */
type ReadyInvitation = Extract<InvitationRead, { kind: "ready" }>["invitation"];

/** The invitation, named, with Accept and Decline. */
function InvitationCard({
	token,
	invitation,
	viewerEmail,
	completeSetup,
}: {
	token: string;
	invitation: ReadyInvitation;
	viewerEmail: string;
	completeSetup: () => Promise<void>;
}) {
	const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [declined, setDeclined] = useState(false);

	/** Accepts, completes setup and lands in the inviting organization. */
	const accept = async () => {
		if (busy) return;
		setBusy("accept");
		setError(null);
		const failure = await invitationActionFailure("accept", () =>
			authClient.organization.acceptInvitation({ invitationId: token }),
		);
		if (failure) {
			setError(failure);
			setBusy(null);
			return;
		}
		// Joining an organization IS this account's setup: without this, the next visit to
		// /dashboard would send an invitee to /onboarding to create an organization they never
		// wanted. Best-effort — the membership exists either way, and the org is where they go.
		await completeSetup().catch(() => undefined);
		// A full document load, so the console starts with the new membership in every store.
		hardNavigate(`/${invitation.organizationSlug}`);
	};

	/** Declines; a refusal is shown, never swallowed into a redirect. */
	const decline = async () => {
		if (busy) return;
		setBusy("decline");
		setError(null);
		const failure = await invitationActionFailure("decline", () =>
			authClient.organization.rejectInvitation({ invitationId: token }),
		);
		setBusy(null);
		if (failure) {
			setError(failure);
			return;
		}
		setDeclined(true);
	};

	if (declined) {
		return (
			<Message
				title="Invitation declined"
				body={`You won’t join ${invitation.organizationName}. ${invitation.inviterEmail} can invite you again if this was a mistake.`}
				action={<GoToConsole />}
			/>
		);
	}

	return (
		<Centered>
			<AuthCard className="text-center">
				<div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-text-tertiary">
					<MailQuestion className="h-5 w-5" aria-hidden="true" />
				</div>
				<h1 className={`mt-4 ${HEADING}`}>
					You&apos;ve been invited to join {invitation.organizationName}
				</h1>
				<p className="mt-1.5 text-sm text-text-secondary">
					<span className="font-medium text-text-primary">{invitation.inviterEmail}</span>{" "}
					invited you as {invitation.role}. You&apos;ll join signed in as{" "}
					<span className="font-medium text-text-primary">{viewerEmail}</span>.
				</p>
				{/* `role="alert"`: the refusal appears in place, with no navigation and no focus move —
				    a sighted user sees a red box arrive under the heading, and without a live region a
				    screen-reader user was told nothing at all. The e2e spec also locates the refusal
				    as the live region rather than by text, which this card is full of. */}
				{error && (
					<p
						role="alert"
						className="mt-4 border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
					>
						{error}
					</p>
				)}
				{/* `pending` keeps the label beside the loader, so a pending button keeps its name and
				    its width. */}
				<div className="mt-6 flex gap-3">
					<Button
						variant="outline"
						className="flex-1"
						onClick={decline}
						disabled={busy !== null}
						pending={busy === "decline"}
					>
						Decline
					</Button>
					<Button className="flex-1" onClick={accept} disabled={busy !== null} pending={busy === "accept"}>
						Accept invitation
					</Button>
				</div>
			</AuthCard>
		</Centered>
	);
}

/**
 * An invitation addressed to somebody else. Accept could only be refused, so it is not offered;
 * the way on is to sign in as the invited address, which comes straight back here.
 */
function WrongAccount({
	viewerEmail,
	invitedEmail,
	token,
}: {
	viewerEmail: string;
	invitedEmail: string | null;
	token: string;
}) {
	const [signingOut, setSigningOut] = useState(false);
	const [failed, setFailed] = useState(false);

	/** Signs out, then returns to sign-in with this invitation as `next`. */
	const switchAccount = async () => {
		if (signingOut) return;
		setSigningOut(true);
		setFailed(false);
		const back = new URLSearchParams({ token, ...(invitedEmail ? { email: invitedEmail } : {}) });
		const signIn = new URLSearchParams({ next: `/invites/accept?${back.toString()}` });
		if (invitedEmail) signIn.set("email", invitedEmail);
		const outcome = await signOutOfConsole({
			endSession: () => authClient.signOut(),
			forgetAccount: () => useAuthPrefsStore.getState().forget(),
			clearWizardDrafts: clearAllWizardDrafts,
			// Not the console root: the person is switching accounts to answer THIS invitation.
			leave: () => hardNavigate(`/login?${signIn.toString()}`),
		});
		if (outcome === "failed") {
			setSigningOut(false);
			setFailed(true);
		}
	};

	return (
		<Message
			title="This invitation is for another account"
			body={
				invitedEmail
					? `It was sent to ${invitedEmail}, and you’re signed in as ${viewerEmail}. Sign out and sign in as ${invitedEmail} to accept it.`
					: `You’re signed in as ${viewerEmail}, which is not the address it was sent to. Sign out and sign in with the invited address to accept it.`
			}
			alert={failed ? "Couldn't sign you out. You are still signed in. Try again." : null}
			action={
				<Button onClick={switchAccount} pending={signingOut}>
					{AUTH.signOut} and switch account
				</Button>
			}
		/>
	);
}

/** The way back into the console from a card that has nothing left to do here. */
function GoToConsole() {
	return (
		<Button variant="outline" nativeButton={false} render={<Link href="/dashboard" />}>
			Go to Alethia
		</Button>
	);
}

/**
 * The shell, not a copy of it. This drew its own unlinked logo at `left-10 top-10`
 * and no footer — one of three public routes that each reimplemented `AuthShell`
 * slightly differently.
 */
function Centered({ children }: { children: React.ReactNode }) {
	return <AuthShell cardWidth="wide">{children}</AuthShell>;
}

/** A card that says what happened and offers the one next step. */
function Message({
	title,
	body,
	action,
	alert = null,
}: {
	title: string;
	body: string;
	action?: React.ReactNode;
	alert?: string | null;
}) {
	return (
		<Centered>
			<AuthCard className="text-center">
				<h1 className={HEADING}>{title}</h1>
				<p className="mt-1.5 text-sm text-text-secondary">{body}</p>
				{alert ? (
					<p
						role="alert"
						className="mt-4 border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive"
					>
						{alert}
					</p>
				) : null}
				{action ? <div className="mt-6 flex justify-center">{action}</div> : null}
			</AuthCard>
		</Centered>
	);
}

/**
 * The invitation card's shape while the session and the invitation are read: icon, heading,
 * sentence, two buttons. One picture from the first paint to the card, where there used to be an
 * empty shell, then a spinner, then the card (A-19).
 */
export function InviteSkeleton() {
	return (
		<Centered>
			<AuthCard>
				<SkeletonRoot className="flex flex-col items-center">
					<Skeleton className="h-11 w-11 rounded-full" />
					<Skeleton className="mt-4 h-7 w-4/5" />
					<Skeleton className="mt-3 h-3.5 w-full" />
					<Skeleton className="mt-1.5 h-3.5 w-3/5" />
					<div className="mt-6 flex w-full gap-3">
						<Skeleton className="h-9 flex-1 rounded-none" />
						<Skeleton className="h-9 flex-1 rounded-none" />
					</div>
				</SkeletonRoot>
			</AuthCard>
		</Centered>
	);
}

/**
 * The invitation screen. `completeSetup` marks the account's onboarding finished; the route's
 * server page passes the server action in, so this client module never imports server code.
 * The search params suspend, and the fallback is the same skeleton.
 */
export function AcceptInviteScreen({ completeSetup }: { completeSetup: () => Promise<void> }) {
	return (
		<Suspense fallback={<InviteSkeleton />}>
			<AcceptInvite completeSetup={completeSetup} />
		</Suspense>
	);
}
