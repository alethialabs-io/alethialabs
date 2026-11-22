"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useActionState } from "react";
import {
	decidePrivacyCase,
	openPrivacyCaseFromEmail,
	type PrivacyFormState,
} from "@/app/privacy/actions";

const INPUT =
	"w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";
const BUTTON =
	"rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50";

/** The result line under a form. */
function Result({ state }: { state: PrivacyFormState | null }) {
	if (!state) return null;
	return (
		<p role="status" className={state.ok ? "text-sm text-foreground" : "text-sm text-destructive"}>
			{state.message}
		</p>
	);
}

/** A decision with no legal reason of its own (verify, fulfil): asks for the audit reason only. */
export function SimpleDecisionForm({
	reference,
	action,
	label,
	hint,
}: {
	reference: string;
	action: "verify" | "fulfil";
	label: string;
	hint: string;
}) {
	const [state, submit, pending] = useActionState(decidePrivacyCase, null);
	return (
		<form action={submit} className="space-y-2 rounded-lg border p-4">
			<p className="text-sm font-medium">{label}</p>
			<p className="text-xs text-muted-foreground">{hint}</p>
			<input type="hidden" name="action" value={action} />
			<input type="hidden" name="reference" value={reference} />
			<input name="auditReason" required placeholder="Why (recorded in the operator audit log)" className={INPUT} />
			<button type="submit" disabled={pending} className={BUTTON}>
				{pending ? "Working…" : label}
			</button>
			<Result state={state} />
		</form>
	);
}

/** A decision that carries a reason the subject is told (extend, hold, refuse). */
export function ReasonedDecisionForm({
	reference,
	action,
	label,
	hint,
}: {
	reference: string;
	action: "extend" | "hold" | "refuse";
	label: string;
	hint: string;
}) {
	const [state, submit, pending] = useActionState(decidePrivacyCase, null);
	return (
		<form action={submit} className="space-y-2 rounded-lg border p-4">
			<p className="text-sm font-medium">{label}</p>
			<p className="text-xs text-muted-foreground">{hint}</p>
			<input type="hidden" name="action" value={action} />
			<input type="hidden" name="reference" value={reference} />
			<textarea name="reason" required minLength={10} rows={2} placeholder="The reason the subject will be told" className={INPUT} />
			<button type="submit" disabled={pending} className={BUTTON}>
				{pending ? "Working…" : label}
			</button>
			<Result state={state} />
		</form>
	);
}

/** Opens a case from a request that arrived by email. */
export function OpenCaseForm() {
	const [state, submit, pending] = useActionState(openPrivacyCaseFromEmail, null);
	return (
		<form action={submit} className="grid gap-2 rounded-lg border p-4 sm:grid-cols-[10rem_1fr]">
			<p className="text-sm font-medium sm:col-span-2">Open a case from an email</p>
			<select name="kind" defaultValue="erasure" className={INPUT} aria-label="Kind of request">
				<option value="access">Access</option>
				<option value="export">Export</option>
				<option value="portability">Portability</option>
				<option value="rectification">Rectification</option>
				<option value="erasure">Erasure</option>
				<option value="restriction">Restriction</option>
				<option value="objection">Objection</option>
			</select>
			<input name="email" type="email" required placeholder="The address the request came from" className={INPUT} />
			<input
				name="auditReason"
				required
				placeholder="Why (e.g. the inbox thread it came from)"
				className={`${INPUT} sm:col-span-2`}
			/>
			<div className="flex items-center gap-3 sm:col-span-2">
				<button type="submit" disabled={pending} className={BUTTON}>
					{pending ? "Opening…" : "Open case"}
				</button>
				<Result state={state} />
			</div>
		</form>
	);
}
