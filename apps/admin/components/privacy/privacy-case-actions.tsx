"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Label } from "@repo/ui/label";
import { SectionHeading } from "@repo/ui/section-heading";
import { Textarea } from "@repo/ui/textarea";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
	extendPrivacyRequest,
	fulfilPrivacyErasure,
	holdPrivacyRequest,
	type PrivacyActionResult,
	refusePrivacyRequest,
	verifyPrivacyIdentity,
} from "@/app/privacy/actions";
import {
	MIN_EXTENSION_REASON,
	MIN_REFUSAL_REASON,
	MIN_VERIFICATION_NOTE,
} from "@/app/privacy/constants";
import { ConfirmErasureDialog } from "./confirm-erasure-dialog";

/** What the actions need to know about the case to offer only the steps that apply. */
export interface PrivacyCaseActionState {
	reference: string;
	kind: string;
	identityVerified: boolean;
	extended: boolean;
	onHold: boolean;
	accountLinked: boolean;
}

/**
 * One step: a reason field and its button. The button stays disabled until the reason is as long
 * as the console requires, so the operator sees the rule before the round trip.
 */
function ReasonStep({
	id,
	title,
	description,
	label,
	min,
	action,
	busy,
	onRun,
}: {
	id: string;
	title: string;
	description: string;
	label: string;
	min: number;
	action: string;
	busy: boolean;
	onRun: (reason: string) => Promise<boolean>;
}) {
	const [reason, setReason] = useState("");
	return (
		<div className="space-y-2 rounded-lg border p-4">
			<SectionHeading level={3} title={title} description={description} />
			<Label htmlFor={id}>{label}</Label>
			<Textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
			<Button
				type="button"
				variant="outline"
				disabled={busy || reason.trim().length < min}
				onClick={() =>
					void onRun(reason).then((ok) => {
						if (ok) setReason("");
					})
				}
			>
				{action}
			</Button>
		</div>
	);
}

/**
 * The handling steps for one open privacy case, each offered only when it applies: verify identity
 * (until it is verified), extend (once), apply a legal hold (until one is applied), fulfil the
 * erasure (an erasure request with identity verified, an account linked and no hold — behind a
 * typed confirmation), and refuse with grounds. Every step is a platform-admin server action that
 * is audited and re-validated by the console; this component only gathers the input.
 */
export function PrivacyCaseActions({ state }: { state: PrivacyCaseActionState }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const ref = state.reference;

	/** Runs one step, shows its outcome, and refreshes the page on success. */
	async function run(step: () => Promise<PrivacyActionResult>): Promise<boolean> {
		setBusy(true);
		setError(null);
		setNotice(null);
		const res = await step();
		setBusy(false);
		if (!res.ok) {
			setError(res.error ?? "Failed");
			router.refresh();
			return false;
		}
		setNotice(res.message ?? "Done.");
		router.refresh();
		return true;
	}

	const canErase =
		state.kind === "erasure" && state.identityVerified && state.accountLinked && !state.onHold;

	return (
		<div className="space-y-3">
			{error && <p className="text-sm text-destructive">{error}</p>}
			{notice && <p className="text-sm text-foreground">{notice}</p>}

			{!state.identityVerified && (
				<ReasonStep
					id="privacy-verify"
					title="Verify identity"
					description="Nothing is disclosed or destroyed before this. The note goes to the platform audit trail, not the case."
					label="How identity was verified — the method, not the evidence"
					min={MIN_VERIFICATION_NOTE}
					action="Mark identity verified"
					busy={busy}
					onRun={(how) => run(() => verifyPrivacyIdentity({ reference: ref, how }))}
				/>
			)}

			{state.kind === "erasure" && (
				<div className="space-y-2 rounded-lg border p-4">
					<SectionHeading
						level={3}
						title="Fulfil the erasure"
						description={
							!state.identityVerified
								? "Available once identity is verified."
								: !state.accountLinked
									? "The address matches no account, so no row can be matched. Erase by hand and record it on the case."
									: state.onHold
										? "A legal hold is applied; the erasure is paused until it is lifted."
										: "Runs the erasure register against the linked account."
						}
					/>
					<Button
						type="button"
						variant="destructive"
						disabled={busy || !canErase}
						onClick={() => setConfirming(true)}
					>
						Perform erasure…
					</Button>
					<ConfirmErasureDialog
						reference={ref}
						open={confirming}
						onOpenChange={setConfirming}
						onConfirm={(typed) =>
							run(() => fulfilPrivacyErasure({ reference: ref, confirm: typed }))
						}
					/>
				</div>
			)}

			{!state.extended && (
				<ReasonStep
					id="privacy-extend"
					title="Extend the deadline"
					description="The single extension: two further months. The reason is told to the subject."
					label="Why the request is complex"
					min={MIN_EXTENSION_REASON}
					action="Extend by two months"
					busy={busy}
					onRun={(reason) => run(() => extendPrivacyRequest({ reference: ref, reason }))}
				/>
			)}

			{!state.onHold && (
				<ReasonStep
					id="privacy-hold"
					title="Apply a legal hold"
					description="Pauses the destructive half of the request. It does not refuse it."
					label="The basis of the hold"
					min={MIN_EXTENSION_REASON}
					action="Apply legal hold"
					busy={busy}
					onRun={(reason) => run(() => holdPrivacyRequest({ reference: ref, reason }))}
				/>
			)}

			<ReasonStep
				id="privacy-refuse"
				title="Refuse the request"
				description="Closes the case. The subject must be told the grounds and that they may complain to the supervisory authority."
				label="Grounds, and the right to complain"
				min={MIN_REFUSAL_REASON}
				action="Refuse request"
				busy={busy}
				onRun={(reason) => run(() => refusePrivacyRequest({ reference: ref, reason }))}
			/>
		</div>
	);
}
