"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { useProviderSlug, CACHE_NODE_TYPES, DEFAULT_CACHE_NODE } from "@/lib/cloud-providers";
import { Cpu, Plus, Trash2 } from "lucide-react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";

export function SectionCaches() {
	const { control } = useFormContext<SpecFormData>();
	const { fields, append, remove } = useFieldArray({ control, name: "caches" });
	const provider = useProviderSlug();
	const nodeTypes = CACHE_NODE_TYPES[provider];

	const addCache = () => append({
		name: fields.length === 0 ? "primary" : `cache-${fields.length + 1}`,
		engine: "redis",
		node_type: DEFAULT_CACHE_NODE[provider],
		num_cache_nodes: 1,
		multi_az: false,
	});

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Cpu className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Caches</CardTitle>
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addCache}>
						<Plus className="h-3.5 w-3.5 mr-1.5" />Add Cache
					</Button>
				</div>
				<CardDescription className="text-xs">In-memory caching for your applications.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{fields.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<Cpu className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No caches configured.</p>
					</div>
				) : fields.map((field, i) => (
					<div key={field.id} className="p-4 border border-border/50 rounded-lg space-y-3">
						<div className="flex items-center justify-between">
							<FormField control={control} name={`caches.${i}.name`} render={({ field: f }) => (
								<span className="text-sm font-medium">{f.value || "Unnamed"}</span>
							)} />
							<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => remove(i)}>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</div>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
							<FormField control={control} name={`caches.${i}.name`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Name <span className="text-destructive">*</span></Label>
									<FormControl><Input {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase())} className="h-8 text-xs font-mono" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`caches.${i}.engine`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<div className="flex items-center gap-1"><Label className="text-[11px]">Engine</Label><HelpTooltip topic="cache-engine" /></div>
									<Select value={f.value || "redis"} onValueChange={f.onChange}>
										<FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
										<SelectContent>
											<SelectItem value="redis">Redis</SelectItem>
											<SelectItem value="valkey">Valkey</SelectItem>
										</SelectContent>
									</Select>
								</FormItem>
							)} />
							<FormField control={control} name={`caches.${i}.node_type`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Node Type</Label>
									<Select value={f.value || DEFAULT_CACHE_NODE[provider]} onValueChange={f.onChange}>
										<FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
										<SelectContent>
											{nodeTypes.map((nt) => (
												<SelectItem key={nt.value} value={nt.value} className="text-xs">
													{nt.label} ({nt.cost})
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</FormItem>
							)} />
							<FormField control={control} name={`caches.${i}.num_cache_nodes`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Nodes</Label>
									<FormControl><Input type="number" min={1} max={6} name={f.name} onBlur={f.onBlur} value={f.value ?? 1} onChange={(e) => f.onChange(parseInt(e.target.value) || 1)} className="h-8 text-xs" /></FormControl>
								</FormItem>
							)} />
						</div>
						<FormField control={control} name={`caches.${i}.multi_az`} render={({ field: f }) => (
							<div className="flex items-center justify-between p-2 bg-muted/20 rounded">
								<div className="flex items-center gap-1.5">
									<span className="text-[11px] text-muted-foreground">Multi-AZ Failover</span>
									<HelpTooltip topic="multi-az" />
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
