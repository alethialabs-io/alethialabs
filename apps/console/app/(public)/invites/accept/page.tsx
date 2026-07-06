"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Loader2, MailQuestion } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { Button } from "@repo/ui/button";
import { authClient } from "@/lib/auth/client";

function AcceptInvite() {
	const router = useRouter();
	const params = useSearchParams();
	const token = params.get("token");
	const invitedEmail = params.get("email");
	const { data: session, isPending } = authClient.useSession();
	const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Not signed in → send them to sign-in, returning here afterwards (?next=).
	// OTP sign-in doubles as sign-up, so this also covers "no account yet".
	useEffect(() => {
		if (isPending || session?.user || !token) return;
		const next = `/invites/accept?token=${encodeURIComponent(token)}`;
		const qs = new URLSearchParams({ next });
		// Prefill the invitee's email on the sign-in/sign-up form.
		if (invitedEmail && /.+@.+/.test(invitedEmail)) qs.set("email", invitedEmail);
		router.replace(`/login?${qs.toString()}`);
	}, [isPending, session, token, invitedEmail, router]);

	if (!token) {
		return <Message title="Invalid invitation" body="This invite link is missing its token." />;
	}
	if (isPending || !session?.user) {
		return <Centered>{<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}</Centered>;
	}

	const accept = async () => {
		setBusy("accept");
		setError(null);
		const { error } = await authClient.organization.acceptInvitation({
			invitationId: token,
		});
		if (error) {
			setError(error.message ?? "Couldn't accept this invitation.");
			setBusy(null);
			return;
		}
		// Membership now exists; the active scope resolves to it on the next request.
		router.push("/dashboard");
	};

	const decline = async () => {
		setBusy("decline");
		setError(null);
		await authClient.organization.rejectInvitation({ invitationId: token });
		router.push("/");
	};

	return (
		<Centered>
			<div className="w-full max-w-[400px] rounded-lg border border-border/50 bg-card p-8 text-center shadow-sm">
				<div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
					<MailQuestion className="h-5 w-5" />
				</div>
				<h1 className="mt-4 text-lg font-semibold text-foreground">
					You&apos;ve been invited to an organization
				</h1>
				<p className="mt-1.5 text-sm text-muted-foreground">
					Accept to join and start collaborating, signed in as{" "}
					<span className="font-medium text-foreground">{session.user.email}</span>.
				</p>
				{error && (
					<p className="mt-4 rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						{error}
					</p>
				)}
				<div className="mt-6 flex gap-3">
					<Button
						variant="outline"
						className="flex-1"
						onClick={decline}
						disabled={busy !== null}
					>
						{busy === "decline" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Decline"}
					</Button>
					<Button className="flex-1" onClick={accept} disabled={busy !== null}>
						{busy === "accept" ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							"Accept invitation"
						)}
					</Button>
				</div>
			</div>
		</Centered>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="relative min-h-screen bg-background">
			<div className="absolute left-10 top-10">
				<AlethiaLogo withText className="h-6 w-auto text-foreground" />
			</div>
			<div className="flex min-h-screen items-center justify-center px-6">
				{children}
			</div>
		</div>
	);
}

function Message({ title, body }: { title: string; body: string }) {
	return (
		<Centered>
			<div className="max-w-[400px] text-center">
				<h1 className="text-lg font-semibold text-foreground">{title}</h1>
				<p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
			</div>
		</Centered>
	);
}

export default function AcceptInvitePage() {
	return (
		<Suspense fallback={null}>
			<AcceptInvite />
		</Suspense>
	);
}
