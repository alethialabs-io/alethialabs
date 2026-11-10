"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The unified channel verification control (there is one concept — verification, not
// "test"). Sends a synthetic delivery via verifyChannel, shows a success/error callout,
// and rate-limits repeats with an escalating client cooldown ("Re-verify in 0:29") on top
// of the server-side limiter. Shared by the add-channel sheet and the inline editor.
//
// The write goes through `useActionMutation` (#6125): a refused attempt (the channel is gone, the
// plan changed) is one toast; an endpoint that did not answer is the inline result below; a pass
// invalidates every key that shows the channel, so its badge and "Last verified" move with it. The
// timestamp is rendered after hydration only — it reads the browser's time zone.

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { type VerifyChannelOutcome, verifyChannel } from "@/app/server/actions/alerts";
import { ClockSlot } from "@/components/overview/clock-slot";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { alertsKeys } from "@/lib/query/use-alerts-query";
import { formatDate } from "@repo/format";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

/** The widest "Last verified" timestamp `formatDate(…, "datetime")` prints in the console's locale. */
const VERIFIED_AT_SIZER = "Sep 30, 2026, 12:00 PM";

// Escalating cooldown tiers (seconds) — mirrors the OTP resend pattern.
const COOLDOWNS = [30, 60, 120];

function fmt(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return `${m}:${s}`;
}

interface ChannelVerifyProps {
	channelId: string;
	isVerified: boolean;
	lastVerifiedAt: string | null;
	canManage: boolean;
}

/** Verify / re-verify a channel with a cooldown and inline result. */
export function ChannelVerify({
	channelId,
	isVerified,
	lastVerifiedAt,
	canManage,
}: ChannelVerifyProps) {
	const [result, setResult] = useState<VerifyChannelOutcome | null>(null);
	const [attempts, setAttempts] = useState(0);
	const [cooldown, setCooldown] = useState(0);

	useEffect(() => {
		if (cooldown <= 0) return;
		const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
		return () => clearTimeout(id);
	}, [cooldown]);

	const mutation = useActionMutation(verifyChannel, {
		invalidates: alertsKeys(),
		onSuccess: (outcome) => {
			setResult(outcome);
			const next = attempts + 1;
			setAttempts(next);
			setCooldown(COOLDOWNS[Math.min(next - 1, COOLDOWNS.length - 1)]);
		},
	});
	const busy = mutation.isPending;

	const verify = () => {
		if (busy || cooldown > 0) return;
		setResult(null);
		mutation.mutate({ id: channelId });
	};

	const label = busy
		? "Verifying…"
		: cooldown > 0
			? `Re-verify in ${fmt(cooldown)}`
			: isVerified
				? "Re-verify"
				: "Verify";

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-4">
				<div className="min-w-0">
					<div className="text-sm">Verification</div>
					<div className="text-muted-foreground text-xs">
						Send a synthetic event to confirm the endpoint works.
						{lastVerifiedAt && (
							<>
								{" "}
								Last verified{" "}
								<ClockSlot
									sizer={VERIFIED_AT_SIZER}
									render={() => formatDate(lastVerifiedAt, "datetime")}
								/>
								.
							</>
						)}
					</div>
				</div>
				{canManage && (
					<Button
						variant="outline"
						size="sm"
						onClick={verify}
						disabled={busy || cooldown > 0}
						className="shrink-0"
					>
						{busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
						{label}
					</Button>
				)}
			</div>

			{result && (
				<div
					className={cn(
						"flex items-start gap-2.5 rounded-md border p-3 text-xs",
						result.verified
							? "border-border bg-muted/40"
							: "border-destructive/30 bg-destructive/5",
					)}
				>
					{result.verified ? (
						<CheckCircle2 className="mt-px size-4 shrink-0 text-foreground" />
					) : (
						<XCircle className="mt-px size-4 shrink-0 text-destructive" />
					)}
					<p className={cn(result.verified ? "text-foreground" : "text-destructive")}>
						{result.verified
							? "Verified — a sample event reached the endpoint."
							: result.error}
					</p>
				</div>
			)}
		</div>
	);
}
