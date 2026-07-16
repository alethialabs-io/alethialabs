"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The reusable cloud filter of the console filter standard: a typeahead MultiCombobox
// whose rows carry the provider marks. The option list comes from the caller (the
// evidence action derives it from the `cloud_provider` DB enum with per-cloud counts;
// jobs/runners can pass their own lists when they migrate) — this component only owns
// the look: icon rows, muted count hints, "All clouds" summary.

import { Cloud, Layers } from "lucide-react";
import { MultiCombobox, type ComboboxOption } from "@repo/ui/multi-combobox";
import { PROVIDER_LABELS, ProviderIcon } from "@repo/ui/provider-icon";

/** One selectable cloud (or the "other" bucket) with an optional match count. */
export interface CloudFilterOption {
	value: string;
	label: string;
	count?: number;
}

/** The leading mark for an option row: the cloud's logo, else a layers glyph. */
function leadingFor(value: string): React.ReactNode {
	if (value in PROVIDER_LABELS) {
		return <ProviderIcon provider={value} size={14} />;
	}
	return <Layers size={13} className="text-muted-foreground" />;
}

/** A multi-select cloud filter (MultiCombobox with provider-icon rows). */
export function CloudFilter({
	value,
	onChange,
	options,
	placeholder = "All clouds",
	className,
}: {
	value: string[];
	onChange: (next: string[]) => void;
	options: CloudFilterOption[];
	placeholder?: string;
	className?: string;
}) {
	const comboboxOptions: ComboboxOption[] = options.map((o) => ({
		value: o.value,
		label: o.label,
		hint: o.count !== undefined ? String(o.count) : undefined,
		leading: leadingFor(o.value),
	}));

	return (
		<MultiCombobox
			options={comboboxOptions}
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			icon={Cloud}
			className={className}
		/>
	);
}
