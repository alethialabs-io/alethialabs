"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Payment methods + billing details + VAT id + receipts are managed natively in the
// Stripe Customer Portal (the canonical, PCI-handled surface) rather than a bespoke UI.
// This card opens the portal for the active org's customer.

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { createBillingPortalSession } from "@/app/server/actions/billing";
import { SettingsSection } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";

export function ManageBillingCard() {
	const [loading, setLoading] = useState(false);

	async function openPortal() {
		setLoading(true);
		try {
			const { url } = await createBillingPortalSession();
			window.location.href = url;
		} catch (e) {
			toast.error(
				e instanceof Error ? e.message : "Couldn't open the billing portal.",
			);
			setLoading(false);
		}
	}

	return (
		<SettingsSection title="Payment & billing details">
			<div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface p-5 shadow-sm">
				<div>
					<p className="text-[13px] font-medium text-text-primary">
						Manage in the Stripe billing portal
					</p>
					<p className="mt-1 max-w-prose text-[12.5px] text-text-tertiary">
						Update payment methods, your billing address, company VAT ID, and download
						receipts — securely on Stripe.
					</p>
				</div>
				<Button onClick={() => void openPortal()} disabled={loading}>
					<ExternalLink size={14} />
					{loading ? "Opening…" : "Manage billing"}
				</Button>
			</div>
		</SettingsSection>
	);
}
