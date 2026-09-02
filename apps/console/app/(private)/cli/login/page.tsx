"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { Button } from "@repo/ui/button";
import { isValidDeviceCode, isValidUserCode } from "@/lib/auth/cli-device-code";
import { CliLoginBodySkeleton } from "./loading";

type Stage = "confirm" | "approving" | "declining" | "approved" | "declined" | "error";

/**
 * Pulls the `error` string out of what `/api/auth/cli/generate` answered, falling back when the
 * body is not the shape that route documents.
 *
 * `response.json()` is typed `any`, and CLAUDE.md §6 forbids one — so the body is taken as
 * `unknown` and narrowed. It is not merely a style rule here: this string is rendered to the
 * user as the reason their sign-in failed, and reaching through `any` would let `undefined`,
 * a number or an object land in that sentence.
 */
function approvalErrorMessage(body: unknown): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string" &&
		body.error !== ""
	) {
		return body.error;
	}
	return "Failed to approve device.";
}

/**
 * The browser half of the CLI device flow (RFC 8628). It approves NOTHING on mount:
 * it shows the `user_code` the terminal printed and waits for an explicit press.
 *
 * That gesture is the whole security boundary. The device code is client-chosen, so a
 * link like /cli/login?device_code=<attacker-uuid> could be sent to any signed-in user;
 * when this page auto-approved on mount, opening it bound the victim's account to the
 * attacker's code and handed the attacker's polling CLI the victim's access token,
 * 90-day refresh token and raw git-provider OAuth token. The user must be able to see
 * WHAT they are approving and choose to approve it.
 *
 * THE INVARIANT, STATED SO IT SURVIVES THE NEXT REFACTOR: `approveDevice` has exactly one
 * caller — the Approve button's `onClick` below. No `useEffect` may call it, and neither
 * may anything that runs as a consequence of rendering. #2213 was not a bug in the fetch;
 * it was a bug in WHO started it.
 */
function CliLoginContent() {
	const searchParams = useSearchParams();
	const deviceCode = searchParams.get("device_code");
	const userCode = searchParams.get("user_code");
	const linkIsWellFormed =
		isValidDeviceCode(deviceCode) && isValidUserCode(userCode);

	const [stage, setStage] = useState<Stage>(
		linkIsWellFormed ? "confirm" : "error",
	);
	const [error, setError] = useState(
		linkIsWellFormed
			? ""
			: "This link is not a valid CLI login request. Run `alethia login` and open the link it prints.",
	);

	/** Binds this device code to the signed-in account — only ever from the button. */
	async function approveDevice() {
		setStage("approving");
		try {
			const response = await fetch("/api/auth/cli/generate", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
			});

			if (!response.ok) {
				const body: unknown = await response.json().catch(() => null);
				setError(approvalErrorMessage(body));
				setStage("error");
				return;
			}
			setStage("approved");
		} catch {
			setError("Could not reach the control plane. Please try again.");
			setStage("error");
		}
	}

	/**
	 * Records the refusal SERVER-SIDE — only ever from the "This isn't me" button.
	 *
	 * This page used to call `setStage("declined")` and nothing else, and said so honestly in
	 * the declined copy below: the refusal lived in React state, so re-opening the link offered
	 * the prompt again and the polling CLI never learned it had been refused. That was #3887,
	 * which this file's own comment pointed at — and it has since landed, so the button can now
	 * do what the screen always claimed.
	 *
	 * A failure is SURFACED rather than swallowed. Telling somebody their refusal was recorded
	 * when it was not is worse than telling them to close the terminal.
	 */
	async function declineDevice() {
		setStage("declining");
		try {
			const response = await fetch("/api/auth/cli/deny", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ device_code: deviceCode, user_code: userCode }),
			});
			if (!response.ok) {
				const body: unknown = await response.json().catch(() => ({}));
				setError(approvalErrorMessage(body));
				setStage("error");
				return;
			}
			setStage("declined");
		} catch {
			setError(
				"Could not reach the control plane to record the refusal. Close your terminal to be sure nothing is shared.",
			);
			setStage("error");
		}
	}

	if (stage === "confirm" || stage === "approving" || stage === "declining") {
		return (
			<div className="flex flex-col gap-6">
				<div className="space-y-2 text-center">
					<p className="text-sm font-medium text-text-primary">
						Confirm the code from your terminal
					</p>
					<p className="text-xs text-text-secondary">
						A device is asking to sign in to your account. Approve it only if this
						code matches the one <code>alethia login</code> printed.
					</p>
				</div>

				{/* The code is set at a display size rather than at a `--text-ui-*` rung, and that
				    is a decision rather than drift: the reader is character-matching this string
				    against a terminal, one glyph at a time, and legibility of a code being typed
				    is not reading type. It is the same call the maintainer made for the sign-in
				    OTP input on 2026-09-02. `text-2xl` and not a hardcoded `text-[24px]`, so it
				    stays on a scale rather than becoming a number this file invented. */}
				<div
					className="border border-border bg-surface-sunken py-4 text-center font-mono text-2xl tracking-[0.3em] text-text-primary"
					aria-label="Device confirmation code"
				>
					{userCode}
				</div>

				<div className="flex flex-col gap-2">
					<Button
						onClick={approveDevice}
						disabled={stage === "approving" || stage === "declining"}
					>
						{stage === "approving" ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Approving…
							</>
						) : (
							"Approve"
						)}
					</Button>
					<Button
						variant="ghost"
						onClick={declineDevice}
						disabled={stage === "approving" || stage === "declining"}
					>
						{stage === "declining" ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Recording…
							</>
						) : (
							"This isn't me"
						)}
					</Button>
				</div>

				<p className="text-center text-xs text-text-secondary">
					If you did not start this sign-in, do not approve it.
				</p>
			</div>
		);
	}

	if (stage === "approved") {
		return (
			<div className="flex flex-col items-center justify-center gap-4">
				<div className="h-12 w-12 rounded-full bg-surface-muted flex items-center justify-center">
					<CheckCircle className="h-6 w-6 text-text-primary" />
				</div>
				<div className="text-center space-y-1">
					<p className="text-sm font-medium text-text-primary">
						Authentication successful
					</p>
					<p className="text-xs text-text-secondary">
						You can close this window and return to your terminal.
					</p>
				</div>
			</div>
		);
	}

	if (stage === "declined") {
		return (
			<div className="flex flex-col items-center justify-center gap-4">
				<div className="h-12 w-12 rounded-full bg-surface-muted flex items-center justify-center">
					<XCircle className="h-6 w-6 text-text-primary" />
				</div>
				<div className="text-center space-y-1">
					<p className="text-sm font-medium text-text-primary">
						Sign-in not approved
					</p>
					{/* This wording tracks the behaviour exactly, and it moved when the behaviour
					    did. It used to promise only that nothing was approved, because the refusal
					    was browser-local and that was all that was true. #3887 landed, so the
					    refusal is now recorded, the polling CLI is told, and the link cannot be
					    approved afterwards — all three are claims the server now backs. */}
					<p className="text-xs text-text-secondary">
						Nothing was shared, and the refusal has been recorded — the device has been
						told, and this link cannot be approved later. You can close this window.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center gap-4">
			<div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
				<XCircle className="h-6 w-6 text-destructive" />
			</div>
			<div className="text-center space-y-1">
				<p className="text-sm font-medium text-text-primary">
					Authentication failed
				</p>
				<p className="text-xs text-destructive">{error}</p>
			</div>
		</div>
	);
}

/**
 * What `alethia login` opens in the browser — the CLI's device-approval screen.
 *
 * The shell it wears is no longer mounted here: `layout.tsx` renders `AuthShell`/`AuthCard`
 * around this page and around `loading.tsx`, so one file decides the route's frame and its
 * width. It stays under `(private)` deliberately — an anonymous visitor should be bounced to
 * `/login?next=…` rather than shown an approval prompt.
 *
 * The heading stays. It is one of the six surfaces in the shared-surface allowlist that sit
 * outside the console shell entirely: there is no sidebar entry and no breadcrumb above this
 * page, and it is arrived at from a terminal, so the heading is the only thing on screen that
 * says what the page is.
 */
export default function CliLoginPage() {
	return (
		<>
			<div className="mb-6 text-center">
				<p className="vx-eyebrow">Device authorization</p>
				{/* `text-display-xs` — the rung #3830 adds for display type rendered inside a shell,
				    24/22/20px. It replaces this file's own `text-[22px]`, which was one of the five
				    console sites sitting in the gap between the UI ladder's 17px top and the display
				    ladder's 30px bottom. This file is not in #3830's scope, so the rung is CONSUMED
				    here rather than invented; until #3830 lands the class resolves to nothing and the
				    heading inherits. */}
				<h1 className="mt-2 font-grotesk text-display-xs font-semibold tracking-[-0.03em] text-text-primary">
					CLI Authentication
				</h1>
			</div>
			{/* The same body `loading.tsx` draws. `useSearchParams` forces a client bailout, and
			    the picture it falls back to must not be a second, different picture of this card
			    — the fallback used to be a centred spinner, which is a third one. */}
			<Suspense fallback={<CliLoginBodySkeleton />}>
				<CliLoginContent />
			</Suspense>
		</>
	);
}
