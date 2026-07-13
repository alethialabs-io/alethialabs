"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared contract inputs used by both the flip-existing-org (Flow A) and create-new-org (Flow B)
// forms: term, seats, collection method (stripe|external), amount, refs, and the REQUIRED reason.

export interface ContractState {
	seats: string;
	termMonths: string;
	collectionMethod: "external" | "stripe";
	amountDollars: string;
	currency: string;
	interval: "month" | "year";
	contractRef: string;
	invoiceRef: string;
	notes: string;
	reason: string;
}

export const emptyContract: ContractState = {
	seats: "",
	termMonths: "12",
	collectionMethod: "external",
	amountDollars: "",
	currency: "usd",
	interval: "year",
	contractRef: "",
	invoiceRef: "",
	notes: "",
	reason: "",
};

/** Serializes the contract inputs into the shape the server actions expect. */
export function toContractPayload(c: ContractState) {
	return {
		seats: c.seats ? Number(c.seats) : null,
		termMonths: Number(c.termMonths) || 12,
		collectionMethod: c.collectionMethod,
		amountCents: c.amountDollars
			? Math.round(Number(c.amountDollars) * 100)
			: null,
		currency: c.currency.toLowerCase(),
		interval: c.interval,
		contractRef: c.contractRef || undefined,
		invoiceRef: c.invoiceRef || undefined,
		notes: c.notes || undefined,
		reason: c.reason,
	};
}

function Field({
	label,
	children,
	hint,
}: {
	label: string;
	children: React.ReactNode;
	hint?: string;
}) {
	return (
		<label className="block space-y-1">
			<span className="text-xs text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
		</label>
	);
}

const input =
	"w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring";

export function ContractFields({
	value,
	onChange,
}: {
	value: ContractState;
	onChange: (next: ContractState) => void;
}) {
	const set = <K extends keyof ContractState>(k: K, v: ContractState[K]) =>
		onChange({ ...value, [k]: v });

	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3">
				<Field label="Collection method">
					<select
						className={input}
						value={value.collectionMethod}
						onChange={(e) =>
							set("collectionMethod", e.target.value as ContractState["collectionMethod"])
						}
					>
						<option value="external">External (bank / Odoo фактура)</option>
						<option value="stripe">Stripe Invoicing</option>
					</select>
				</Field>
				<Field label="Term (months)">
					<input
						className={input}
						type="number"
						min={1}
						value={value.termMonths}
						onChange={(e) => set("termMonths", e.target.value)}
					/>
				</Field>
				<Field label="Seats" hint="Blank = unlimited/flat">
					<input
						className={input}
						type="number"
						min={1}
						value={value.seats}
						onChange={(e) => set("seats", e.target.value)}
					/>
				</Field>
				<Field label="Currency">
					<input
						className={input}
						maxLength={3}
						value={value.currency}
						onChange={(e) => set("currency", e.target.value)}
					/>
				</Field>
			</div>

			{value.collectionMethod === "stripe" && (
				<div className="grid grid-cols-2 gap-3 rounded-md border border-dashed p-3">
					<Field label="Amount" hint="Per interval, in the currency above">
						<input
							className={input}
							type="number"
							min={0}
							step="0.01"
							placeholder="e.g. 24000"
							value={value.amountDollars}
							onChange={(e) => set("amountDollars", e.target.value)}
						/>
					</Field>
					<Field label="Interval">
						<select
							className={input}
							value={value.interval}
							onChange={(e) =>
								set("interval", e.target.value as ContractState["interval"])
							}
						>
							<option value="year">Yearly</option>
							<option value="month">Monthly</option>
						</select>
					</Field>
					<p className="col-span-2 text-[11px] text-muted-foreground">
						Creates a Stripe subscription billed by invoice (net-30). The plan activates
						when the console webhook sees payment; the invoice link is shown after saving.
					</p>
				</div>
			)}

			<div className="grid grid-cols-2 gap-3">
				<Field label="Contract ref" hint="MSA / DocuSign id">
					<input
						className={input}
						value={value.contractRef}
						onChange={(e) => set("contractRef", e.target.value)}
					/>
				</Field>
				<Field label="Invoice ref" hint="Bank / Odoo number">
					<input
						className={input}
						value={value.invoiceRef}
						onChange={(e) => set("invoiceRef", e.target.value)}
					/>
				</Field>
			</div>

			<Field label="Notes">
				<textarea
					className={input}
					rows={2}
					value={value.notes}
					onChange={(e) => set("notes", e.target.value)}
				/>
			</Field>

			<Field label="Reason (required — audited)">
				<input
					className={input}
					placeholder="Why is this being done? Recorded in platform_audit."
					value={value.reason}
					onChange={(e) => set("reason", e.target.value)}
				/>
			</Field>
		</div>
	);
}
