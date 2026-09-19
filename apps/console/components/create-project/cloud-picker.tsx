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
		// THE TILES GET A ROLE AND AN ACCESSIBLE NAME (#4269).
		//
		// A pick-mode `ConnectorCard` is a bare `<div onClick>`: no role, no name, nothing between
		// "Amazon Web Services" the heading and "Amazon Web Services" the thing you can select. To a
		// screen reader the picker read as four unlabelled stacks of text, and to a spec there was no
		// `getByRole` handle on a tile at all — only `getByText("GCP")`, which matches the connectors
		// board, the status copy and the region row just as happily.
		//
		// `group` and not `radio`, deliberately, and the difference is load-bearing. `radio` is the
		// role this picker's BEHAVIOUR wants, but a radio may own no interactive descendants, and an
		// UNCONNECTED tile renders a Connect button inside itself — so a blanket `radio` here would
		// trip axe's `nested-interactive` (serious) on exactly the tiles a first-run org sees. Marking
		// only the connected ones means re-deriving `ConnectorCard`'s own `isPick` predicate out here,
		// a second renderer of a six-condition question that would then be the one that never gets the
		// fix. `group` is honest for every tile, costs nothing, and needs no predicate.
		//
		// What it does NOT do is make the pick keyboard-operable — the click handler still lives on a
		// div in `components/connectors/connector-card.tsx`, where `isPick` is, and that file is
		// outside this unit's scope. Fixing it THERE (one `role`/`tabIndex`/`onKeyDown` behind the
		// existing `isPick`) is the whole fix; nothing here should grow a second copy of it.
		<div
			role="group"
			aria-label="Cloud account"
			className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(228px,1fr))]"
		>
			{clouds.map((integration) => {
				// Narrow the slug to a provisionable provider (the filter above guarantees it).
				if (!arrayIncludes(PROVISIONABLE, integration.slug)) return null;
				const provider = integration.slug;
				const identityId = integration.accounts?.[0]?.identityId ?? null;
				const selected =
					identityId != null && identityId === selectedIdentityId;
				return (
					// `grid` on the wrapper, not a bare div: the card was a GRID ITEM before this
					// wrapper existed and stretched to the row's height, which is what its footer's
					// `mt-auto` hangs off. A block wrapper would collapse it to its content and the
					// tiles in a row would stop lining up. A one-cell grid stretches its child on
					// both axes, so the rendered box is unchanged.
					<div
						key={integration.id}
						role="group"
						aria-label={integration.name}
						className="grid"
					>
						<ConnectorCard
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
					</div>
				);
			})}
		</div>
	);
}
