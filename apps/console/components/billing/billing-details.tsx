"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Billing contact + address + VAT id form. The address is required for Stripe Tax to
// compute VAT, and both appear on invoices (EU B2B reverse-charge needs the VAT id).

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	getBillingDetails,
	saveTaxId,
	updateBillingAddress,
} from "@/app/server/actions/billing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

const schema = z.object({
	name: z.string().trim().min(1, "Required"),
	line1: z.string().trim().min(1, "Required"),
	line2: z.string().optional(),
	city: z.string().trim().min(1, "Required"),
	state: z.string().optional(),
	postalCode: z.string().trim().min(1, "Required"),
	country: z.string().trim().length(2, "Use the 2-letter country code"),
	taxId: z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const EMPTY: FormData = {
	name: "",
	line1: "",
	line2: "",
	city: "",
	state: "",
	postalCode: "",
	country: "",
	taxId: "",
};

function Field({
	id,
	label,
	error,
	children,
}: {
	id: string;
	label: string;
	error?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id}>{label}</Label>
			{children}
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}

export function BillingDetails({ onSaved }: { onSaved?: () => void } = {}) {
	const [loaded, setLoaded] = useState(false);
	const [pending, startTransition] = useTransition();
	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: EMPTY,
	});

	useEffect(() => {
		getBillingDetails()
			.then((d) => {
				if (d) {
					form.reset({
						name: d.name,
						line1: d.line1,
						line2: d.line2,
						city: d.city,
						state: d.state,
						postalCode: d.postalCode,
						country: d.country,
						taxId: d.taxId ?? "",
					});
				}
			})
			.catch(() => toast.error("Couldn't load billing details."))
			.finally(() => setLoaded(true));
	}, [form]);

	function onSubmit(data: FormData) {
		startTransition(async () => {
			try {
				await updateBillingAddress({
					name: data.name,
					line1: data.line1,
					line2: data.line2,
					city: data.city,
					state: data.state,
					postalCode: data.postalCode,
					country: data.country.toUpperCase(),
				});
				await saveTaxId(data.taxId ?? "");
				toast.success("Billing details saved.");
				onSaved?.();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Couldn't save billing details.");
			}
		});
	}

	if (!loaded) return <Skeleton className="h-72 w-full" />;

	const e = form.formState.errors;
	return (
		<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
			<div>
				<h3 className="text-sm font-semibold text-foreground">Billing details</h3>
				<p className="mt-1 text-xs text-muted-foreground">
					Your address and VAT id appear on invoices and are used to calculate tax.
				</p>
			</div>

			<Field id="bd-name" label="Billing name" error={e.name?.message}>
				<Input id="bd-name" {...form.register("name")} />
			</Field>
			<Field id="bd-line1" label="Address line 1" error={e.line1?.message}>
				<Input id="bd-line1" {...form.register("line1")} />
			</Field>
			<Field id="bd-line2" label="Address line 2 (optional)">
				<Input id="bd-line2" {...form.register("line2")} />
			</Field>
			<div className="grid gap-4 sm:grid-cols-2">
				<Field id="bd-city" label="City" error={e.city?.message}>
					<Input id="bd-city" {...form.register("city")} />
				</Field>
				<Field id="bd-state" label="State / region (optional)">
					<Input id="bd-state" {...form.register("state")} />
				</Field>
				<Field id="bd-postal" label="Postal code" error={e.postalCode?.message}>
					<Input id="bd-postal" {...form.register("postalCode")} />
				</Field>
				<Field id="bd-country" label="Country (2-letter)" error={e.country?.message}>
					<Input id="bd-country" placeholder="DE" {...form.register("country")} />
				</Field>
			</div>
			<Field id="bd-tax" label="VAT id (optional)">
				<Input id="bd-tax" placeholder="DE123456789" {...form.register("taxId")} />
			</Field>

			<Button type="submit" disabled={pending}>
				{pending ? "Saving…" : "Save billing details"}
			</Button>
		</form>
	);
}
