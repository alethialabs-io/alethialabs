"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { RepositorySelector } from "@/components/repository-selector";
import { ListField } from "./list-field";
import { SubresourceField } from "./subresource-field";
import { BindingsField, type ServiceBinding } from "./bindings-field";
import {
	REGION_LABELS,
	groupRegions,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import type {
	FieldCtx,
	FieldDef,
	FieldOption,
	KindConfig,
	Resolvable,
	SectionDef,
} from "./config-schema";
import { RadioCardGroup } from "./radio-card-group";

type Config = Record<string, unknown>;

/** Resolve a static-or-derived field attribute against the current context. */
function resolve<T>(
	r: Resolvable<T> | undefined,
	ctx: FieldCtx,
): T | undefined {
	return typeof r === "function" ? (r as (c: FieldCtx) => T)(ctx) : r;
}

/** The grouped region dropdown, keyed by the effective provider. */
function RegionSelect({
	provider,
	value,
	onChange,
}: {
	provider: CloudProviderSlug;
	value: string;
	onChange: (v: string) => void;
}) {
	const groups = groupRegions(
		Object.keys(REGION_LABELS[provider] ?? {}),
		provider,
	);
	return (
		<Select value={value || ""} onValueChange={onChange}>
			<SelectTrigger className="h-9 text-sm">
				<SelectValue placeholder="Region" />
			</SelectTrigger>
			<SelectContent>
				{groups.map((g) => (
					<SelectGroup key={g.group}>
						<SelectLabel>{g.group}</SelectLabel>
						{g.regions.map((r) => (
							<SelectItem key={r.value} value={r.value}>
								{r.label} ({r.value})
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}

/** Render one field's control. */
function FieldControl({
	field,
	ctx,
	onChange,
	id,
}: {
	field: FieldDef;
	ctx: FieldCtx;
	onChange: (patch: Config) => void;
	/** Ties the control to its <Label>. Without it the label is decorative and screen readers —
	 * and every accessible query — can't find the input. */
	id?: string;
}) {
	const { provider, config } = ctx;
	const raw = field.get ? field.get(config) : config[field.key];
	const patch = (value: unknown) =>
		onChange(field.set ? field.set(value, config) : { [field.key]: value });

	if (field.requiresProvider && !provider) {
		return (
			<p className="text-xs text-muted-foreground">
				Select a cloud account to configure this.
			</p>
		);
	}

	switch (field.type) {
		case "text":
			return (
				<Input
					id={id}
					value={(raw as string) ?? ""}
					placeholder={resolve(field.placeholder, ctx)}
					className={cn("h-9 text-sm", field.mono && "font-mono")}
					onChange={(e) =>
						patch(
							field.transform
								? field.transform(e.target.value)
								: e.target.value,
						)
					}
				/>
			);

		case "number": {
			const step = resolve(field.step, ctx);
			const isFloat = field.float || (typeof step === "number" && step < 1);
			return (
				<Input
					id={id}
					type="number"
					min={resolve(field.min, ctx)}
					max={resolve(field.max, ctx)}
					step={step}
					placeholder={resolve(field.placeholder, ctx)}
					value={(raw as number) ?? ""}
					className="h-9 text-sm"
					onChange={(e) => {
						const n = isFloat
							? Number.parseFloat(e.target.value)
							: Number.parseInt(e.target.value, 10);
						// Clearing an OPTIONAL number field means "use the default" → patch null
						// (the columns are nullable; 0 would trip min(1) validation with no way
						// back). Required numbers keep the legacy 0 so they never go null.
						patch(Number.isNaN(n) ? (field.optional ? null : 0) : n);
					}}
				/>
			);
		}

		case "select": {
			const options = resolve(field.options, ctx) ?? [];
			return (
				<Select
					value={(raw as string) || options[0]?.value || ""}
					onValueChange={patch}
				>
					<SelectTrigger id={id} className="h-9 text-sm">
						<SelectValue placeholder={resolve(field.placeholder, ctx)} />
					</SelectTrigger>
					<SelectContent>
						{options.map((o) => (
							<SelectItem key={o.value} value={o.value}>
								{o.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		}

		case "radio-card": {
			const options = resolve(field.options, ctx) ?? [];
			return (
				<RadioCardGroup
					ariaLabel={field.label}
					value={(raw as string) || options[0]?.value || ""}
					onChange={patch}
					options={options}
					columns={options.length >= 2 ? 2 : 1}
				/>
			);
		}

		case "switch":
			// Switches render as a full labelled row (handled in FieldRow); this is unreachable.
			return null;

		case "region":
			return provider ? (
				<RegionSelect
					provider={provider}
					value={(raw as string) ?? ""}
					onChange={patch}
				/>
			) : null;

		case "repository":
			return (
				<RepositorySelector
					label=""
					placeholder="Select repository"
					value={(raw as string) || undefined}
					onChange={(v) => patch(v || "")}
				/>
			);

		case "list":
			return (
				<ListField
					ariaLabel={field.label}
					value={Array.isArray(raw) ? (raw as string[]) : []}
					placeholder={field.item?.placeholder}
					mono={field.item?.mono ?? field.mono}
					// Blank rows are dropped on write: an empty CIDR isn't a value, and letting one
					// through would fail zod at deploy with a confusing message.
					onChange={(next) => patch(next.filter((v) => v.trim() !== ""))}
				/>
			);

		case "subresource":
			return field.sub ? (
				<SubresourceField
					spec={field.sub}
					provider={ctx.provider}
					value={Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []}
					onChange={patch}
				/>
			) : null;

		case "bindings":
			return (
				<BindingsField
					value={Array.isArray(raw) ? (raw as ServiceBinding[]) : []}
					onChange={patch}
				/>
			);
	}
}

/** A field wrapped with its label (or, for switches, a label+switch row). */
function FieldRow({
	field,
	ctx,
	onChange,
}: {
	field: FieldDef;
	ctx: FieldCtx;
	onChange: (patch: Config) => void;
}) {
	const fieldId = useId();
	const raw = field.get ? field.get(ctx.config) : ctx.config[field.key];
	const unit = resolve(field.unit, ctx);
	const label = unit ? `${field.label} (${unit})` : field.label;

	if (field.type === "switch") {
		return (
			<div className="col-span-full flex items-center justify-between gap-4 rounded-none border border-border/60 px-3 py-2.5">
				<div className="min-w-0">
					<p className="text-sm font-medium">{field.label}</p>
					{field.description && (
						<p className="mt-0.5 text-xs text-muted-foreground">
							{field.description}
						</p>
					)}
				</div>
				<Switch
					checked={raw !== false}
					onCheckedChange={(v) => onChange({ [field.key]: v })}
				/>
			</div>
		);
	}

	const full =
		field.full ||
		field.type === "radio-card" ||
		field.type === "region" ||
		field.type === "repository" ||
		field.type === "list" ||
		field.type === "subresource" ||
		field.type === "bindings";

	// Composite controls (list / subresource / bindings / radio-card) label their own inner rows, so
	// the section label stays decorative for those; everything else gets a real label→control binding.
	const composite =
		field.type === "list" ||
		field.type === "subresource" ||
		field.type === "bindings" ||
		field.type === "radio-card";

	return (
		<div className={cn("space-y-1.5", full && "col-span-full")}>
			<Label htmlFor={composite ? undefined : fieldId} className="text-xs">
				{label}
			</Label>
			<FieldControl
				field={field}
				ctx={ctx}
				onChange={onChange}
				id={composite ? undefined : fieldId}
			/>
			{field.description && field.type !== "radio-card" && (
				<p className="text-xs text-muted-foreground">{field.description}</p>
			)}
		</div>
	);
}

/** Compact one-line summary of a section's current values (for the collapsed header). */
function sectionSummary(section: SectionDef, ctx: FieldCtx): string {
	const chips: string[] = [];
	for (const field of section.fields) {
		if (chips.length >= 2) break;
		if (field.type === "switch") continue;
		// A list of twelve CIDRs is not a one-line summary; count them instead.
		if (
			field.type === "list" ||
			field.type === "subresource" ||
			field.type === "bindings"
		) {
			const items = field.get ? field.get(ctx.config) : ctx.config[field.key];
			if (Array.isArray(items) && items.length > 0) chips.push(`${items.length}`);
			continue;
		}
		if (field.visibleWhen && !field.visibleWhen(ctx.config, ctx)) continue;
		const raw = field.get ? field.get(ctx.config) : ctx.config[field.key];
		if (raw == null || raw === "") continue;
		if (field.type === "select" || field.type === "radio-card") {
			const opts = resolve(field.options, ctx) ?? [];
			chips.push(
				opts.find((o: FieldOption) => o.value === raw)?.label ?? String(raw),
			);
		} else if (field.type === "number") {
			const unit = resolve(field.unit, ctx);
			chips.push(unit ? `${raw} ${unit}` : String(raw));
		} else {
			chips.push(String(raw));
		}
	}
	return chips.join(" · ");
}

/** A single collapsible settings section. */
function Section({
	section,
	ctx,
	onChange,
}: {
	section: SectionDef;
	ctx: FieldCtx;
	onChange: (patch: Config) => void;
}) {
	const advanced = section.tier === "advanced";
	// Advanced = provider-specific knobs. Collapsed by default, so the portable fields stay the
	// thing you see first; you have to deliberately open the door to leave cloud-indifferent ground.
	const [open, setOpen] = useState(section.defaultOpen ?? false);
	const summary = sectionSummary(section, ctx);
	const fields = section.fields.filter(
		(f) => !f.visibleWhen || f.visibleWhen(ctx.config, ctx),
	);

	// A section scoped to clouds this project isn't on doesn't exist for it.
	if (
		section.providerScope &&
		(!ctx.provider || !section.providerScope.includes(ctx.provider))
	) {
		return null;
	}

	// A section whose every field is hidden (e.g. provider-gated sizing) renders nothing.
	if (fields.length === 0) return null;

	return (
		<Collapsible
			open={open}
			onOpenChange={setOpen}
			className={cn(
				"rounded-none border border-border",
				advanced && "bg-surface-sunken/40",
			)}
		>
			<CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="min-w-0">
						<span className="block text-sm font-medium">{section.title}</span>
						{!open && summary && (
							<span className="block truncate text-xs text-muted-foreground">
								{summary}
							</span>
						)}
					</span>
					{/* Badge the cloud whose knobs these are, so it's obvious the field is not portable. */}
					{advanced && ctx.provider && (
						<span className="ml-1 inline-flex shrink-0 items-center gap-1 border border-border-strong px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
							<ProviderIcon provider={ctx.provider} size={10} />
							only
						</span>
					)}
				</span>
				<ChevronDown
					className={cn(
						"h-4 w-4 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
				/>
			</CollapsibleTrigger>
			<CollapsibleContent className="grid grid-cols-1 gap-4 border-t border-border/60 px-4 py-4 sm:grid-cols-2">
				{fields.map((field) => (
					<FieldRow
						key={field.key}
						field={field}
						ctx={ctx}
						onChange={onChange}
					/>
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** Renders a node kind's whole Settings body from its config schema. */
export function ConfigFields({
	schema,
	config,
	provider,
	onChange,
}: {
	schema: KindConfig;
	config: Config;
	provider: CloudProviderSlug | null;
	onChange: (patch: Config) => void;
}) {
	const ctx: FieldCtx = { provider, config };
	return (
		<div className="space-y-3">
			{schema.sections.map((section) => (
				<Section
					key={section.id}
					section={section}
					ctx={ctx}
					onChange={onChange}
				/>
			))}
		</div>
	);
}
