"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@repo/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@repo/ui/card";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@repo/ui/select";
import { Switch } from "@repo/ui/switch";
import { FormControl, FormField, FormItem } from "@repo/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { useProviderMeta } from "@/lib/cloud-providers";
import { useConnectedProviders } from "./connectors-context";
import { KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";

const SECRET_PRESETS = [
	{ label: "PostgreSQL Password", name: "postgres-password", length: 32, special_chars: true },
	{ label: "API Token", name: "api-token", length: 48, special_chars: false },
	{ label: "JWT Secret", name: "jwt-secret", length: 64, special_chars: false },
	{ label: "Redis Password", name: "redis-password", length: 32, special_chars: false },
	{ label: "Custom Secret", name: "", length: 32, special_chars: true },
];

export function SectionSecrets() {
	const meta = useProviderMeta();
	const { control, setValue, getValues } = useFormContext<SpecFormData>();
	const { fields, append, remove } = useFieldArray({ control, name: "secrets" });

	// Connected secret stores (e.g. HashiCorp Vault). "native" = the cluster cloud's
	// own secrets service. The model is homogeneous, so the choice applies to every
	// secret in the spec.
	const secretsProviders = useConnectedProviders("secrets");
	const [secretsProvider, setSecretsProvider] = useState<string>(
		() => getValues("secrets")?.[0]?.provider || "native",
	);

	const applyProvider = (value: string) => {
		setSecretsProvider(value);
		const next = value === "native" ? null : value;
		(getValues("secrets") ?? []).forEach((_, i) =>
			setValue(`secrets.${i}.provider`, next),
		);
	};

	const addFromPreset = (presetLabel: string) => {
		const preset = SECRET_PRESETS.find((p) => p.label === presetLabel);
		if (!preset) return;
		const baseName = preset.name || `secret-${fields.length + 1}`;
		const existingNames = fields.map((f) => f.name);
		const finalName = existingNames.includes(baseName) ? `${baseName}-${fields.length + 1}` : baseName;
		append({
			name: finalName,
			generate: true,
			length: preset.length,
			special_chars: preset.special_chars,
			provider: secretsProvider === "native" ? null : secretsProvider,
		});
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<KeyRound className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Secrets</CardTitle>
						<HelpTooltip topic="secrets" />
					</div>
					<Select value="" onValueChange={addFromPreset}>
						<SelectTrigger className="h-8 text-xs w-44">
							<SelectValue placeholder="Add secret..." />
						</SelectTrigger>
						<SelectContent>
							{SECRET_PRESETS.map((p) => (
								<SelectItem key={p.label} value={p.label} className="text-xs">{p.label}</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<CardDescription className="text-xs">{meta.secretsService}. Auto-generated passwords and tokens.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{secretsProviders.length > 0 && (
					<div className="space-y-1.5">
						<Label className="text-xs">Secrets Store</Label>
						<Select value={secretsProvider} onValueChange={applyProvider}>
							<SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
							<SelectContent>
								<SelectItem value="native">Cloud-native ({meta.secretsService})</SelectItem>
								{secretsProviders.map((p) => (
									<SelectItem key={p.slug} value={p.slug}>{p.name}</SelectItem>
								))}
							</SelectContent>
						</Select>
						{secretsProvider !== "native" && (
							<p className="text-[11px] text-muted-foreground">
								Secrets are stored in your connected{" "}
								{secretsProviders.find((p) => p.slug === secretsProvider)?.name ?? secretsProvider}{" "}
								instead of {meta.secretsService}.
							</p>
						)}
					</div>
				)}
				{fields.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<KeyRound className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No secrets configured.</p>
						<p className="text-[11px] mt-1">Use the dropdown to add presets or a custom secret.</p>
					</div>
				) : fields.map((field, i) => (
					<div key={field.id} className="flex items-center gap-3 p-3 border border-border/50 rounded-lg">
						<div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-3">
							<FormField control={control} name={`secrets.${i}.name`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[10px] text-muted-foreground">Name <span className="text-destructive">*</span></Label>
									<FormControl><Input {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} className="h-8 text-xs font-mono" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`secrets.${i}.length`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[10px] text-muted-foreground">Length</Label>
									<FormControl><Input type="number" min={8} max={128} name={f.name} onBlur={f.onBlur} value={f.value ?? 32} onChange={(e) => f.onChange(parseInt(e.target.value) || 32)} className="h-8 text-xs" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`secrets.${i}.special_chars`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[10px] text-muted-foreground">Special Chars</Label>
									<div className="flex items-center h-8"><Switch checked={f.value ?? true} onCheckedChange={f.onChange} /></div>
								</FormItem>
							)} />
							<FormField control={control} name={`secrets.${i}.generate`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[10px] text-muted-foreground">Auto-generate</Label>
									<div className="flex items-center h-8"><Switch checked={f.value ?? true} onCheckedChange={f.onChange} /></div>
								</FormItem>
							)} />
						</div>
						<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0" onClick={() => remove(i)}>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
