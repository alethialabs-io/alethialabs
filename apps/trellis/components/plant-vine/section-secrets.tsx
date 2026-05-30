"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

export function SectionSecrets() {
	const { control } = useFormContext<VineFormData>();
	const { fields, append, remove } = useFieldArray({ control, name: "secrets" });

	const addSecret = () => append({
		name: `secret-${fields.length + 1}`,
		generate: true,
		length: 32,
		special_chars: true,
	});

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<KeyRound className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Secrets</CardTitle>
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addSecret}>
						<Plus className="h-3.5 w-3.5 mr-1.5" />Add Secret
					</Button>
				</div>
				<CardDescription className="text-xs">AWS Secrets Manager entries. Auto-generate passwords or define custom secrets.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{fields.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<KeyRound className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No secrets configured.</p>
					</div>
				) : fields.map((field, i) => (
					<div key={field.id} className="p-4 border border-border/50 rounded-lg space-y-3">
						<div className="flex items-center justify-between">
							<FormField control={control} name={`secrets.${i}.name`} render={({ field: f }) => (
								<span className="text-sm font-medium">{f.value || "Unnamed"}</span>
							)} />
							<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => remove(i)}>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</div>
						<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
							<FormField control={control} name={`secrets.${i}.name`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Name <span className="text-destructive">*</span></Label>
									<FormControl><Input {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} className="h-8 text-xs font-mono" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`secrets.${i}.length`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Length</Label>
									<FormControl><Input type="number" min={8} max={128} {...f} value={f.value ?? 32} onChange={(e) => f.onChange(parseInt(e.target.value) || 32)} className="h-8 text-xs" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`secrets.${i}.special_chars`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Special Characters</Label>
									<div className="flex items-center h-8">
										<Switch checked={f.value ?? true} onCheckedChange={f.onChange} />
									</div>
								</FormItem>
							)} />
						</div>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
