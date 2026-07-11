// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Starter taxonomy templates for the empty state — a one-click way to seed a common axis.
// Everything stays editable after; these just save the blank-page moment. Grayscale: values
// carry no color.

import type { SeedValue } from "@/app/server/actions/classification/dimensions";

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
			{ value: "dev", label: "Development" },
			{ value: "staging", label: "Staging" },
			{ value: "prod", label: "Production" },
		],
	},
	{
		key: "data-classification",
		label: "Data classification",
		description: "Sensitivity tier for the data a resource stores or processes.",
		multi: false,
		values: [
			{ value: "public", label: "Public" },
			{ value: "internal", label: "Internal" },
			{ value: "confidential", label: "Confidential" },
			{ value: "restricted", label: "Restricted" },
		],
	},
	{
		key: "team",
		label: "Team",
		description: "Owning team. A resource may belong to several.",
		multi: true,
		values: [
			{ value: "platform", label: "Platform" },
			{ value: "payments", label: "Payments" },
			{ value: "growth", label: "Growth" },
			{ value: "data-eng", label: "Data Eng" },
		],
	},
	{
		key: "cost-center",
		label: "Cost center",
		description: "Billing allocation code for chargeback.",
		multi: true,
		values: [
			{ value: "cc-2200", label: "Infrastructure" },
			{ value: "cc-1001", label: "R&D" },
			{ value: "cc-3050", label: "Growth" },
			{ value: "unallocated", label: "Unallocated" },
		],
	},
];
