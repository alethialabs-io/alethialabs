"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { openEmailedPrivacyCase } from "@/app/privacy/actions";
import { PRIVACY_KINDS } from "@/app/privacy/constants";

/**
 * Records a privacy request that arrived by email: the kind, the address it came from, and the day
 * it arrived (the statutory clock starts then). On success it opens the new case. Follows the admin
 * app's other operator forms — plain controlled inputs; the server action validates with zod.
 */
export function OpenPrivacyCaseForm({ today }: { today: string }) {
	const router = useRouter();
	const [kind, setKind] = useState<string>("erasure");
	const [email, setEmail] = useState("");
	const [receivedOn, setReceivedOn] = useState(today);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** Opens the case and navigates to it. */
	async function submit() {
		setBusy(true);
		setError(null);
		const res = await openEmailedPrivacyCase({ kind, email, receivedOn });
		setBusy(false);
		if (!res.ok || !res.reference) {
			setError(res.error ?? "Could not open the request");
			return;
		}
		router.push(`/privacy/${res.reference}`);
	}

	return (
		<form
			className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[10rem_1fr_10rem_auto] sm:items-end"
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
		>
			<div className="space-y-1">
				<Label htmlFor="privacy-kind">Kind</Label>
				<Select value={kind} onValueChange={setKind}>
					<SelectTrigger id="privacy-kind" className="w-full">
						<SelectValue placeholder="Kind" />
					</SelectTrigger>
					<SelectContent>
						{PRIVACY_KINDS.map((k) => (
							<SelectItem key={k} value={k}>
								{k}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="space-y-1">
				<Label htmlFor="privacy-email">From address</Label>
				<Input
					id="privacy-email"
					type="email"
					autoComplete="off"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor="privacy-received">Received on (UTC)</Label>
				<Input
					id="privacy-received"
					type="date"
					max={today}
					value={receivedOn}
					onChange={(e) => setReceivedOn(e.target.value)}
				/>
			</div>
			<Button type="submit" disabled={busy || !email.trim() || !receivedOn}>
				{busy ? "Opening…" : "Open case"}
			</Button>
			{error && <p className="text-sm text-destructive sm:col-span-4">{error}</p>}
		</form>
	);
}
