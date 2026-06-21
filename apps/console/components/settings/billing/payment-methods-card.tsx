"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Payment methods card (Billing page) — re-skinned to the authored design. Lists the
// org's saved cards, adds one via the embedded Payment Element (SetupIntent), sets a
// default, or removes one. Reuses <PaymentForm mode="setup"> inside a dialog.

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
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import styles from "./billing-design.module.css";

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
		<section className={styles.section} style={{ marginBottom: 0 }}>
			<div className={styles.sectionHead}>
				<h2>Payment methods</h2>
				<span className={styles.rule} />
			</div>
			<div className={styles.card}>
				{!cards ? (
					<div style={{ padding: 18 }}>
						<Skeleton className="h-12 w-full" />
					</div>
				) : cards.length === 0 ? (
					<div className={styles.empty}>No cards on file yet.</div>
				) : (
					<div className={styles.pmList}>
						{cards.map((c) => (
							<div key={c.id} className={styles.pm}>
								<span className={styles.brandmark}>{c.brand}</span>
								<div className={styles.info}>
									<span className={styles.num}>
										<span className={styles.dots}>•••• •••• ••••</span> {c.last4}
									</span>
									<span className={styles.exp}>
										expires {String(c.expMonth).padStart(2, "0")} / {c.expYear}
									</span>
								</div>
								{c.isDefault && <span className={styles.tag}>Default</span>}
								{!c.isDefault && (
									<button
										type="button"
										className={styles.pmAction}
										disabled={pending}
										onClick={() => makeDefault(c.id)}
									>
										Make default
									</button>
								)}
								<button
									type="button"
									className={styles.pmAction}
									disabled={pending}
									onClick={() => remove(c.id)}
								>
									Remove
								</button>
							</div>
						))}
					</div>
				)}
				<div className={styles.cardFoot}>
					<button
						type="button"
						className={`${styles.btn} ${styles.sm}`}
						onClick={openAdd}
					>
						<Plus size={13} />
						Add payment method
					</button>
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
		</section>
	);
}
