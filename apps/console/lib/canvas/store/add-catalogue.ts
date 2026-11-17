// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What can be added to a board (#6764): ONE function, read by every surface that offers an add —
// the add picker, the command palette, the pane's context menu — so no two of them can list
// different things. Before it there were two catalogues: the Add palette grouped by service type
// and showed add-ons and roadmap rows, the command palette grouped by core and periphery and
// showed neither, and bring-your-own charts and IaC were rows in the second only.
//
// It is a pure function of the cloud, the feature flags and whether a bring-your-own IaC module
// governs the environment. The cloud arrives as an argument: this file names no provider.

import type { LucideIcon } from "lucide-react";
import {
	addableKindsFor,
	NODE_REGISTRY,
	PALETTE_GROUP_ORDER,
	ROADMAP_ITEMS,
	SINGLETON_KINDS,
	type PaletteGroup,
} from "@/components/design-project/canvas/graph/node-registry";
import type { NodeKind } from "@/components/design-project/canvas/graph/types";
import type { CloudProviderSlug } from "@/lib/cloud-providers";

/** A marketplace add-on the environment can install, as much of it as a row shows. */
export interface AddCatalogueAddon {
	id: string;
	name: string;
	subtitle: string;
}

/** What is switched on for this environment. */
export interface AddCatalogueFlags {
	/** Bring-your-own Helm charts. */
	byoHelm: boolean;
	/** Bring-your-own IaC. */
	byoIac: boolean;
	/** The add-ons the environment can install; absent before the catalog has loaded. */
	addons?: AddCatalogueAddon[];
}

/** One thing a person can pick. `type` says what picking it does. */
export type AddCatalogueRow =
	/** Adds a design node of `kind`. A singleton that is already placed is selected instead. */
	| {
			type: "kind";
			id: string;
			kind: NodeKind;
			label: string;
			subtitle: string;
			icon: LucideIcon;
			singleton: boolean;
	  }
	/** Shown, not pickable: a service with no module yet. */
	| { type: "roadmap"; id: string; label: string; subtitle: string; icon: LucideIcon }
	/** Opens the add-on's install form. */
	| { type: "addon"; id: string; label: string; subtitle: string }
	/** Opens the attach flow for a bring-your-own chart or IaC module. */
	| { type: "source"; id: "byo-chart" | "byo-iac"; label: string; subtitle: string };

/** The catalogue's group headings: the service types, then add-ons, then sources. */
export type AddCatalogueGroupTitle = PaletteGroup | "Add-ons" | "Sources";

/** One heading and the rows under it. A group with no rows is not returned. */
export interface AddCatalogueGroup {
	title: AddCatalogueGroupTitle;
	rows: AddCatalogueRow[];
}

/**
 * Everything that can be added to a board on `provider` (null = no cloud chosen yet: every kind).
 *
 * While a bring-your-own IaC module governs the environment there is nothing to add — the
 * component design is not what gets deployed — so the catalogue is empty.
 */
export function addCatalogue(
	provider: CloudProviderSlug | null,
	flags: AddCatalogueFlags,
	governed: boolean,
): AddCatalogueGroup[] {
	if (governed) return [];
	const kinds = addableKindsFor(provider);
	const groups: AddCatalogueGroup[] = PALETTE_GROUP_ORDER.map((title) => ({
		title,
		rows: [
			...kinds
				.filter((kind) => NODE_REGISTRY[kind].palette?.group === title)
				.map((kind): AddCatalogueRow => {
					const def = NODE_REGISTRY[kind];
					return {
						type: "kind",
						id: kind,
						kind,
						label: def.label,
						subtitle: def.palette?.subtitle ?? "",
						icon: def.icon,
						singleton: SINGLETON_KINDS.includes(kind),
					};
				}),
			...ROADMAP_ITEMS.filter((item) => item.group === title).map(
				(item): AddCatalogueRow => ({
					type: "roadmap",
					id: item.id,
					label: item.label,
					subtitle: item.subtitle,
					icon: item.icon,
				}),
			),
		],
	}));
	groups.push({
		title: "Add-ons",
		rows: (flags.addons ?? []).map((addon): AddCatalogueRow => ({
			type: "addon",
			id: addon.id,
			label: addon.name,
			subtitle: addon.subtitle,
		})),
	});
	const sources: AddCatalogueRow[] = [];
	if (flags.byoHelm) {
		sources.push({
			type: "source",
			id: "byo-chart",
			label: "Helm chart",
			subtitle: "Attach a chart from your repository",
		});
	}
	if (flags.byoIac) {
		sources.push({
			type: "source",
			id: "byo-iac",
			label: "Infrastructure as code",
			subtitle: "Attach a module from your repository",
		});
	}
	groups.push({ title: "Sources", rows: sources });
	return groups.filter((group) => group.rows.length > 0);
}

/** Every design kind the catalogue offers, in catalogue order. */
export function catalogueKinds(groups: AddCatalogueGroup[]): NodeKind[] {
	return groups.flatMap((group) =>
		group.rows.flatMap((row) => (row.type === "kind" ? [row.kind] : [])),
	);
}
