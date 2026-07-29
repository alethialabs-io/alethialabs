"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { CloudConnectResult } from "@/components/cloud-connect/use-cloud-connect";
import { ConnectorCard } from "@/components/connectors/connector-card";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import { arrayIncludes } from "@/lib/type-guards";

/** Clouds with full provisioning templates — the only ones a project can target. */
const PROVISIONABLE: CloudProviderSlug[] = ["aws", "gcp", "azure", "alibaba"];

interface CloudPickerProps {
	/** All connectors; the picker filters to provisionable clouds. */
	integrations: ConnectorWithConnection[];
	canManage: boolean;
	platformConfigured: Record<string, boolean>;
	/** Owned by the parent (which also renders `cloudConnect.sheets`). */
	cloudConnect: CloudConnectResult;
	selectedIdentityId: string | null;
	onSelect: (identityId: string, provider: CloudProviderSlug) => void;
}

/**
 * The Configure step's cloud picker — **reuses the real {@link ConnectorCard}** in pick mode. A
 * connected, healthy provisionable cloud becomes a radio-style pick (its first account's identity);
 * an unconnected one keeps the card's Connect affordance (via `useCloudConnect`). No bespoke cloud
 * tiles — the connectors surface and this picker render the identical card.
 */
export function CloudPicker({
	integrations,
	canManage,
	platformConfigured,
	cloudConnect,
	selectedIdentityId,
	onSelect,
}: CloudPickerProps) {
	const clouds = integrations.filter(
		(i) => i.category === "cloud" && arrayIncludes(PROVISIONABLE, i.slug),
	);

	return (
		<div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(228px,1fr))]">
			{clouds.map((integration) => {
				// Narrow the slug to a provisionable provider (the filter above guarantees it).
				if (!arrayIncludes(PROVISIONABLE, integration.slug)) return null;
				const provider = integration.slug;
				const identityId = integration.accounts?.[0]?.identityId ?? null;
				const selected =
					identityId != null && identityId === selectedIdentityId;
				return (
					<ConnectorCard
						key={integration.id}
						integration={integration}
						canManage={canManage}
						platformConfigured={platformConfigured[integration.slug] ?? true}
						isConnecting={cloudConnect.connectingSlug === integration.slug}
						selectable
						selected={selected}
						onSelect={() => {
							if (identityId) onSelect(identityId, provider);
						}}
						onConnect={() => cloudConnect.openConnect(integration)}
						onManage={() => cloudConnect.openConnect(integration)}
					/>
				);
			})}
		</div>
	);
}
