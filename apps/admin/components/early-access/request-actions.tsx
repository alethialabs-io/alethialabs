"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
	declineEarlyAccess,
	grantEarlyAccess,
	markEarlyAccessConverted,
} from "@/app/early-access/actions";
import { DEFAULT_GRANT_DAYS, MAX_GRANT_DAYS } from "@/app/early-access/constants";

const inputClass =
	"w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";
const primaryClass =
	"rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50";
const secondaryClass =
	"rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted/40 disabled:opacity-50";

/**
 * The staff controls for one request. An OPEN request can be granted (free, for a number of days,
 * after which the console lapses it on its own) or declined; a GRANTED one can be marked converted.
 * Every act needs a reason, which goes to the platform audit trail. Follows the admin app's other
 * operator forms (plain controlled inputs; the server action validates with zod).
 */
export function EarlyAccessRequestActions({
	requestId,
	status,
}: {
	requestId: string;
	status: "open" | "granted";
}) {
	const router = useRouter();
	const [termDays, setTermDays] = useState(String(DEFAULT_GRANT_DAYS));
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Runs one decision and refreshes the list on success. */
	async function act(run: () => Promise<{ ok: boolean; error?: string }>) {
		setBusy(true);
		setError(null);
		const res = await run();
		setBusy(false);
		if (!res.ok) {
			setError(res.error ?? "Failed");
			return;
		}
		setReason("");
		router.refresh();
	}

	const noReason = !reason.trim();

	return (
		<div className="space-y-2">
			<label className="block space-y-1">
				<span className="text-xs text-muted-foreground">Reason (audit trail)</span>
				<input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
			</label>
			{status === "open" ? (
				<>
					<label className="block space-y-1">
						<span className="text-xs text-muted-foreground">
							Grant length in days (1–{MAX_GRANT_DAYS}); it lapses on its own after this
						</span>
						<input
							className={inputClass}
							type="number"
							min={1}
							max={MAX_GRANT_DAYS}
							value={termDays}
							onChange={(e) => setTermDays(e.target.value)}
						/>
					</label>
					<div className="flex gap-2">
						<button
							type="button"
							disabled={busy || noReason}
							className={primaryClass}
							onClick={() => void act(() => grantEarlyAccess({ requestId, termDays, reason }))}
						>
							{busy ? "Working…" : "Grant (complimentary)"}
						</button>
						<button
							type="button"
							disabled={busy || noReason}
							className={secondaryClass}
							onClick={() => void act(() => declineEarlyAccess({ requestId, reason }))}
						>
							Decline
						</button>
					</div>
				</>
			) : (
				<button
					type="button"
					disabled={busy || noReason}
					className={secondaryClass}
					onClick={() => void act(() => markEarlyAccessConverted({ requestId, reason }))}
				>
					Mark converted
				</button>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</div>
	);
}
