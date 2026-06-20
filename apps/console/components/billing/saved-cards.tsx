"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Saved-cards manager for the billing panel: list the org's cards, add one via the
// embedded Payment Element (SetupIntent), set a default, or remove. Reuses
// <PaymentForm mode="setup"> inside a dialog.

import { CreditCard } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

export function SavedCards() {
	const [cards, setCards] = useState<PaymentMethodInfo[] | null>(null);
	const [pending, startTransition] = useTransition();
	const [addOpen, setAddOpen] = useState(false);
	const [setupSecret, setSetupSecret] = useState<string | null>(null);

	function load() {
		listPaymentMethods()
			.then(setCards)
			.catch(() => toast.error("Couldn't load cards."));
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
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-semibold text-foreground">Payment methods</h3>
				<Button variant="outline" size="sm" onClick={openAdd}>
					Add card
				</Button>
			</div>

			{!cards ? (
				<Skeleton className="h-16 w-full" />
			) : cards.length === 0 ? (
				<Card className="p-4 text-sm text-muted-foreground">
					No cards on file yet.
				</Card>
			) : (
				<div className="space-y-2">
					{cards.map((c) => (
						<Card
							key={c.id}
							className="flex flex-wrap items-center justify-between gap-3 p-4"
						>
							<div className="flex items-center gap-3">
								<CreditCard className="h-4 w-4 text-muted-foreground" />
								<span className="text-sm font-medium capitalize text-foreground">
									{c.brand} •••• {c.last4}
								</span>
								<span className="text-xs text-muted-foreground">
									{String(c.expMonth).padStart(2, "0")}/{c.expYear}
								</span>
								{c.isDefault && (
									<Badge variant="outline" className="text-[10px] uppercase">
										Default
									</Badge>
								)}
							</div>
							<div className="flex items-center gap-2">
								{!c.isDefault && (
									<Button
										variant="ghost"
										size="sm"
										disabled={pending}
										onClick={() => makeDefault(c.id)}
									>
										Make default
									</Button>
								)}
								<Button
									variant="ghost"
									size="sm"
									disabled={pending}
									onClick={() => remove(c.id)}
									className="text-destructive hover:text-destructive"
								>
									Remove
								</Button>
							</div>
						</Card>
					))}
				</div>
			)}

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
		</div>
	);
}
