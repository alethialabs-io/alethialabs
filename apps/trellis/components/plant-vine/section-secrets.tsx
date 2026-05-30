"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { KeyRound, Trash2 } from "lucide-react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

const SECRET_PRESETS = [
	{ label: "PostgreSQL Password", name: "postgres-password", length: 32, special_chars: true },
	{ label: "API Token", name: "api-token", length: 48, special_chars: false },
	{ label: "JWT Secret", name: "jwt-secret", length: 64, special_chars: false },
	{ label: "Redis Password", name: "redis-password", length: 32, special_chars: false },
	{ label: "Custom Secret", name: "", length: 32, special_chars: true },
];

export function SectionSecrets() {
	const { control } = useFormContext<VineFormData>();
	const { fields, append, remove } = useFieldArray({ control, name: "secrets" });

	const addFromPreset = (presetLabel: string) => {
		const preset = SECRET_PRESETS.find((p) => p.label === presetLabel);
		if (!preset) return;
		const baseName = preset.name || `secret-${fields.length + 1}`;
		const existingNames = fields.map((f: any) => f.name);
		const finalName = existingNames.includes(baseName) ? `${baseName}-${fields.length + 1}` : baseName;
		append({ name: finalName, generate: true, length: preset.length, special_chars: preset.special_chars });
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
				<CardDescription className="text-xs">AWS Secrets Manager. Auto-generated passwords and tokens.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
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
									<FormControl><Input type="number" min={8} max={128} {...f} value={f.value ?? 32} onChange={(e) => f.onChange(parseInt(e.target.value) || 32)} className="h-8 text-xs" /></FormControl>
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
