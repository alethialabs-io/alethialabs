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
import { useProviderSlug, DB_ENGINES, DB_CAPACITY } from "@/lib/cloud-providers";
import { Database, Plus, Trash2 } from "lucide-react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { ProjectFormData } from "@/lib/validations/project-form.schema";

export function SectionDatabases() {
	const { control } = useFormContext<ProjectFormData>();
	const { fields, append, remove } = useFieldArray({ control, name: "databases" });
	const provider = useProviderSlug();
	const engines = DB_ENGINES[provider];
	const capacity = DB_CAPACITY[provider];

	const addDatabase = () => {
		const engine = engines[0];
		append({
			name: fields.length === 0 ? "primary" : `db-${fields.length + 1}`,
			engine: engine.value,
			engine_version: engine.defaultVersion,
			min_capacity: capacity.defaultMin,
			max_capacity: capacity.defaultMax,
			port: 5432,
			iam_auth: false,
		});
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Database className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Databases</CardTitle>
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addDatabase}>
						<Plus className="h-3.5 w-3.5 mr-1.5" />Add Database
					</Button>
				</div>
				<CardDescription className="text-xs">Managed databases. Add multiple instances for different services.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{fields.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<Database className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No databases configured.</p>
					</div>
				) : fields.map((field, i) => (
					<div key={field.id} className="p-4 border border-border/50 rounded-lg space-y-3">
						<div className="flex items-center justify-between">
							<FormField control={control} name={`databases.${i}.name`} render={({ field: f }) => (
								<span className="text-sm font-medium">{f.value || "Unnamed"}</span>
							)} />
							<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => remove(i)}>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</div>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
							<FormField control={control} name={`databases.${i}.name`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Name <span className="text-destructive">*</span></Label>
									<FormControl><Input {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase())} className="h-8 text-xs font-mono" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`databases.${i}.engine`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Engine</Label>
									<Select value={f.value || engines[0].value} onValueChange={f.onChange}>
										<FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
										<SelectContent>
											{engines.map((e) => (
												<SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
											))}
										</SelectContent>
									</Select>
								</FormItem>
							)} />
							<FormField control={control} name={`databases.${i}.instance_class`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<div className="flex items-center gap-1"><Label className="text-[11px]">Instance Class</Label><HelpTooltip topic="db-instance-class" /></div>
									<FormControl><Input name={f.name} onBlur={f.onBlur} value={f.value ?? ""} placeholder="Template default" onChange={(e) => f.onChange(e.target.value || null)} className="h-8 text-xs font-mono" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`databases.${i}.min_capacity`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<div className="flex items-center gap-1"><Label className="text-[11px]">Min {capacity.unit}</Label><HelpTooltip topic="acu" /></div>
									<FormControl><Input type="number" min={0.5} max={128} step={0.5} name={f.name} onBlur={f.onBlur} value={f.value ?? 0.5} onChange={(e) => f.onChange(parseFloat(e.target.value) || 0.5)} className="h-8 text-xs" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`databases.${i}.max_capacity`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Max {capacity.unit}</Label>
									<FormControl><Input type="number" min={0.5} max={128} step={0.5} name={f.name} onBlur={f.onBlur} value={f.value ?? 4} onChange={(e) => f.onChange(parseFloat(e.target.value) || 4)} className="h-8 text-xs" /></FormControl>
								</FormItem>
							)} />
						</div>
						<FormField control={control} name={`databases.${i}.iam_auth`} render={({ field: f }) => (
							<div className="flex items-center justify-between p-2 bg-muted/20 rounded">
								<div className="flex items-center gap-1.5">
									<span className="text-[11px] text-muted-foreground">IAM Authentication</span>
									<HelpTooltip topic="iam-auth" />
								</div>
								<Switch checked={f.value ?? false} onCheckedChange={f.onChange} />
							</div>
						)} />
					</div>
				))}
			</CardContent>
		</Card>
	);
}
