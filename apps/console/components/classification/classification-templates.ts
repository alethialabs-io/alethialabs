// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Starter taxonomy templates for the empty state — a one-click way to seed a common axis.
// Everything stays editable after; these just save the blank-page moment. Colors come from
// the shared muted swatch palette.

import type { SeedValue } from "@/app/server/actions/classification/dimensions";

/** The muted accent palette offered in the value editor + used by the templates. */
export const SWATCHES = [
	"#c05a52",
	"#c08a3e",
	"#4f9d8c",
	"#5a7fb5",
	"#8a6bb0",
	"#6d8a4f",
	"#b56a94",
	"#5c6b7a",
] as const;

/** A ready-made dimension + values the user can drop in from the empty state. */
export interface ClassificationTemplate {
	key: string;
	label: string;
	description: string;
	multi: boolean;
	values: SeedValue[];
}

export const CLASSIFICATION_TEMPLATES: ClassificationTemplate[] = [
	{
		key: "environment",
		label: "Environment",
		description: "Lifecycle stage a resource belongs to.",
		multi: false,
		values: [
			{ value: "dev", label: "Development", color: "#4f9d8c" },
			{ value: "staging", label: "Staging", color: "#c08a3e" },
			{ value: "prod", label: "Production", color: "#c05a52" },
		],
	},
	{
		key: "data-classification",
		label: "Data classification",
		description: "Sensitivity tier for the data a resource stores or processes.",
		multi: false,
		values: [
			{ value: "public", label: "Public", color: null },
			{ value: "internal", label: "Internal", color: "#5a7fb5" },
			{ value: "confidential", label: "Confidential", color: "#8a6bb0" },
			{ value: "restricted", label: "Restricted", color: "#c05a52" },
		],
	},
	{
		key: "team",
		label: "Team",
		description: "Owning team. A resource may belong to several.",
		multi: true,
		values: [
			{ value: "platform", label: "Platform", color: "#4f9d8c" },
			{ value: "payments", label: "Payments", color: "#c08a3e" },
			{ value: "growth", label: "Growth", color: "#5a7fb5" },
			{ value: "data-eng", label: "Data Eng", color: "#8a6bb0" },
		],
	},
	{
		key: "cost-center",
		label: "Cost center",
		description: "Billing allocation code for chargeback.",
		multi: true,
		values: [
			{ value: "cc-2200", label: "Infrastructure", color: null },
			{ value: "cc-1001", label: "R&D", color: null },
			{ value: "cc-3050", label: "Growth", color: null },
			{ value: "unallocated", label: "Unallocated", color: null },
		],
	},
];
