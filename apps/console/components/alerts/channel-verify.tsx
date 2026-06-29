"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The unified channel verification control (there is one concept — verification, not
// "test"). Sends a synthetic delivery via verifyChannel, shows a success/error callout,
// and rate-limits repeats with an escalating client cooldown ("Re-verify in 0:29") on top
// of the server-side limiter. Shared by the add-channel sheet and the inline editor.

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { verifyChannel } from "@/app/server/actions/alerts";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";

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
	onVerified: () => void;
}

/** Verify / re-verify a channel with a cooldown and inline result. */
export function ChannelVerify({
	channelId,
	isVerified,
	lastVerifiedAt,
	canManage,
	onVerified,
}: ChannelVerifyProps) {
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(
		null,
	);
	const [attempts, setAttempts] = useState(0);
	const [cooldown, setCooldown] = useState(0);

	useEffect(() => {
		if (cooldown <= 0) return;
		const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
		return () => clearTimeout(id);
	}, [cooldown]);

	const verify = async () => {
		if (busy || cooldown > 0) return;
		setBusy(true);
		setResult(null);
		try {
			const res = await verifyChannel(channelId);
			setResult(res);
			const next = attempts + 1;
			setAttempts(next);
			setCooldown(COOLDOWNS[Math.min(next - 1, COOLDOWNS.length - 1)]);
			if (res.ok) onVerified();
		} finally {
			setBusy(false);
		}
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
								Last verified {new Date(lastVerifiedAt).toLocaleString()}.
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
						result.ok
							? "border-border bg-muted/40"
							: "border-destructive/30 bg-destructive/5",
					)}
				>
					{result.ok ? (
						<CheckCircle2 className="mt-px size-4 shrink-0 text-foreground" />
					) : (
						<XCircle className="mt-px size-4 shrink-0 text-destructive" />
					)}
					<p className={cn(result.ok ? "text-foreground" : "text-destructive")}>
						{result.ok
							? "Verified — a sample event reached the endpoint."
							: (result.error ?? "Verification failed.")}
					</p>
				</div>
			)}
		</div>
	);
}
