"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Payment methods card (Billing page) — the authored design, composed from the shared
// settings primitives. Lists the org's saved cards, adds one via the embedded Payment
// Element (SetupIntent), sets a default, or removes one. Reuses <PaymentForm mode="setup">.

import { Plus } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
	createSetupIntent,
	detachPaymentMethod,
	listPaymentMethods,
	type PaymentMethodInfo,
	setDefaultPaymentMethod,
} from "@/app/server/actions/billing";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

export function PaymentMethodsCard() {
	const [cards, setCards] = useState<PaymentMethodInfo[] | null>(null);
	const [pending, startTransition] = useTransition();
	const [addOpen, setAddOpen] = useState(false);
	const [setupSecret, setSetupSecret] = useState<string | null>(null);

	function load() {
		listPaymentMethods()
			.then(setCards)
			.catch(() => toast.error("Couldn't load payment methods."));
	}
	useEffect(load, []);

	async function openAdd() {
		try {
			const { clientSecret } = await createSetupIntent();
			setSetupSecret(clientSecret);
			setAddOpen(true);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't start adding a card.");
		}
	}

	function onAdded() {
		setAddOpen(false);
		setSetupSecret(null);
		toast.success("Card added.");
		load();
	}

	function makeDefault(id: string) {
		startTransition(async () => {
			try {
				await setDefaultPaymentMethod(id);
				load();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Couldn't set the default.");
			}
		});
	}

	function remove(id: string) {
		startTransition(async () => {
			try {
				await detachPaymentMethod(id);
				toast.success("Card removed.");
				load();
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "Couldn't remove the card.");
			}
		});
	}

	return (
		<SettingsSection title="Payment methods" className="mb-0">
			<div className="rounded-lg border border-border bg-surface shadow-sm">
				{!cards ? (
					<div className="p-[18px]">
						<Skeleton className="h-12 w-full" />
					</div>
				) : cards.length === 0 ? (
					<div className="px-[18px] py-[18px] text-[13px] text-text-tertiary">
						No cards on file yet.
					</div>
				) : (
					<div className="flex flex-col">
						{cards.map((c) => (
							<div
								key={c.id}
								className="flex items-center gap-3.5 border-b border-border px-[18px] py-[15px] last:border-b-0"
							>
								<span className="grid h-7 w-[42px] shrink-0 place-items-center rounded-xs border border-border-strong bg-surface-sunken font-mono text-[8px] uppercase tracking-[0.08em] text-text-secondary">
									{c.brand}
								</span>
								<div className="flex min-w-0 flex-1 flex-col gap-[3px]">
									<span className="flex items-center gap-2 text-[13px] text-text-primary">
										<span className="tracking-[0.15em] text-text-tertiary">
											•••• •••• ••••
										</span>{" "}
										{c.last4}
									</span>
									<span className="font-mono text-[10.5px] text-text-tertiary">
										expires {String(c.expMonth).padStart(2, "0")} / {c.expYear}
									</span>
								</div>
								{c.isDefault && (
									<span className="whitespace-nowrap rounded-full border border-border-strong px-[7px] py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-text-secondary">
										Default
									</span>
								)}
								{!c.isDefault && (
									<button
										type="button"
										className="whitespace-nowrap rounded-sm px-2 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary disabled:opacity-50"
										disabled={pending}
										onClick={() => makeDefault(c.id)}
									>
										Make default
									</button>
								)}
								<button
									type="button"
									className="whitespace-nowrap rounded-sm px-2 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary disabled:opacity-50"
									disabled={pending}
									onClick={() => remove(c.id)}
								>
									Remove
								</button>
							</div>
						))}
					</div>
				)}
				<div className="border-t border-border px-[18px] py-3">
					<Button variant="outline" size="sm" onClick={openAdd}>
						<Plus size={13} />
						Add payment method
					</Button>
				</div>
			</div>

			<Dialog open={addOpen} onOpenChange={setAddOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Add a card</DialogTitle>
					</DialogHeader>
					{setupSecret && (
						<StripeElementsProvider clientSecret={setupSecret}>
							<PaymentForm mode="setup" submitLabel="Save card" onSuccess={onAdded} />
						</StripeElementsProvider>
					)}
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
}
