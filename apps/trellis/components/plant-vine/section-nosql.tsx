"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FormControl, FormField, FormItem } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { ChevronDown, Plus, Table2, Trash2 } from "lucide-react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

export function SectionNosql() {
	const { control } = useFormContext<VineFormData>();
	const { fields, append, remove } = useFieldArray({ control, name: "nosql_tables" });

	const addTable = () => append({
		name: `table-${fields.length + 1}`,
		hash_key: "id",
		hash_key_type: "S",
		table_type: "standard",
		billing_mode: "PAY_PER_REQUEST",
		point_in_time_recovery: true,
	});

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<Table2 className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">NoSQL Tables</CardTitle>
						<HelpTooltip topic="nosql" />
					</div>
					<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={addTable}>
						<Plus className="h-3.5 w-3.5 mr-1.5" />Add Table
					</Button>
				</div>
				<CardDescription className="text-xs">NoSQL key-value tables. On-demand billing — pay per request.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{fields.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						<Table2 className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No DynamoDB tables configured.</p>
					</div>
				) : fields.map((field, i) => (
					<div key={field.id} className="p-4 border border-border/50 rounded-lg space-y-3">
						<div className="flex items-center justify-between">
							<FormField control={control} name={`nosql_tables.${i}.name`} render={({ field: f }) => (
								<span className="text-sm font-medium">{f.value || "Unnamed"}</span>
							)} />
							<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => remove(i)}>
								<Trash2 className="h-3.5 w-3.5" />
							</Button>
						</div>

						<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
							<FormField control={control} name={`nosql_tables.${i}.name`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Table Name <span className="text-destructive">*</span></Label>
									<FormControl><Input {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase())} className="h-8 text-xs font-mono" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`nosql_tables.${i}.hash_key`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<div className="flex items-center gap-1">
										<Label className="text-[11px]">Hash Key <span className="text-destructive">*</span></Label>
										<HelpTooltip topic="hash-key" />
									</div>
									<FormControl><Input {...f} value={f.value || ""} className="h-8 text-xs font-mono" placeholder="id" /></FormControl>
								</FormItem>
							)} />
							<FormField control={control} name={`nosql_tables.${i}.hash_key_type`} render={({ field: f }) => (
								<FormItem className="space-y-1">
									<Label className="text-[11px]">Type</Label>
									<Select value={f.value || "S"} onValueChange={f.onChange}>
										<FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
										<SelectContent>
											<SelectItem value="S">String</SelectItem>
											<SelectItem value="N">Number</SelectItem>
											<SelectItem value="B">Binary</SelectItem>
										</SelectContent>
									</Select>
								</FormItem>
							)} />
						</div>

						<Collapsible>
							<CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
								<ChevronDown className="h-3 w-3" />
								Advanced options
							</CollapsibleTrigger>
							<CollapsibleContent className="pt-3 space-y-3">
								<div className="grid grid-cols-2 md:grid-cols-3 gap-3">
									<FormField control={control} name={`nosql_tables.${i}.range_key`} render={({ field: f }) => (
										<FormItem className="space-y-1">
											<div className="flex items-center gap-1"><Label className="text-[11px]">Range Key</Label><HelpTooltip topic="range-key" /></div>
											<FormControl><Input {...f} value={f.value || ""} className="h-8 text-xs font-mono" placeholder="timestamp" /></FormControl>
										</FormItem>
									)} />
									<FormField control={control} name={`nosql_tables.${i}.table_type`} render={({ field: f }) => (
										<FormItem className="space-y-1">
											<Label className="text-[11px]">Table Type</Label>
											<Select value={f.value || "standard"} onValueChange={f.onChange}>
												<FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
												<SelectContent>
													<SelectItem value="standard">Standard</SelectItem>
													<SelectItem value="global">Global (multi-region)</SelectItem>
												</SelectContent>
											</Select>
										</FormItem>
									)} />
									<FormField control={control} name={`nosql_tables.${i}.billing_mode`} render={({ field: f }) => (
										<FormItem className="space-y-1">
											<div className="flex items-center gap-1"><Label className="text-[11px]">Billing</Label><HelpTooltip topic="billing-mode" /></div>
											<Select value={f.value || "PAY_PER_REQUEST"} onValueChange={f.onChange}>
												<FormControl><SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger></FormControl>
												<SelectContent>
													<SelectItem value="PAY_PER_REQUEST">On-demand ($0 base)</SelectItem>
													<SelectItem value="PROVISIONED">Provisioned</SelectItem>
												</SelectContent>
											</Select>
										</FormItem>
									)} />
								</div>
								<FormField control={control} name={`nosql_tables.${i}.point_in_time_recovery`} render={({ field: f }) => (
									<div className="flex items-center justify-between p-2 bg-muted/20 rounded">
										<span className="text-[11px] text-muted-foreground">Point-in-time Recovery</span>
										<Switch checked={f.value ?? true} onCheckedChange={f.onChange} />
									</div>
								)} />
							</CollapsibleContent>
						</Collapsible>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
