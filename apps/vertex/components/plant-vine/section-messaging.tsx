"use client";
// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useProviderMeta, MESSAGING } from "@/lib/cloud-providers";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { HelpTooltip } from "./help-tooltip";
import { MessageSquare, Plus, Trash2 } from "lucide-react";
import { useFormContext, useFieldArray } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

function formatTimeout(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h`;
}

export function SectionMessaging() {
	const { control } = useFormContext<VineFormData>();
	const queues = useFieldArray({ control, name: "queues" });
	const topics = useFieldArray({ control, name: "topics" });

	const isEmpty = queues.fields.length === 0 && topics.fields.length === 0;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<MessageSquare className="h-4 w-4 text-muted-foreground" />
						<CardTitle className="text-base">Messaging</CardTitle>
					</div>
					<div className="flex gap-2">
						<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => queues.append({ name: "", fifo: false, visibility_timeout: 30 })}>
							<Plus className="h-3.5 w-3.5 mr-1" />Queue
						</Button>
						<Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => topics.append({ name: "", subscriptions: [] })}>
							<Plus className="h-3.5 w-3.5 mr-1" />Topic
						</Button>
					</div>
				</div>
				<CardDescription className="text-xs">Message queues and topics for event-driven architectures.</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isEmpty ? (
					<div className="text-center py-8 text-muted-foreground">
						<MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-20" />
						<p className="text-sm">No messaging configured.</p>
					</div>
				) : (
					<>
						{queues.fields.length > 0 && (
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">Queues</Label>
								{queues.fields.map((field, i) => (
									<div key={field.id} className="p-3 border border-border/50 rounded-lg">
										<div className="flex items-center gap-3">
											<div className="flex-1 grid grid-cols-1 md:grid-cols-3 gap-2">
												<FormField control={control} name={`queues.${i}.name`} render={({ field: f }) => (
													<FormItem className="space-y-1">
														<Label className="text-[10px] text-muted-foreground">Name <span className="text-destructive">*</span></Label>
														<FormControl><Input placeholder="email-processing" {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase())} className="h-8 text-xs font-mono" /></FormControl>
													</FormItem>
												)} />
												<FormField control={control} name={`queues.${i}.visibility_timeout`} render={({ field: f }) => (
													<FormItem className="space-y-1">
														<div className="flex items-center gap-1">
															<Label className="text-[10px] text-muted-foreground">Visibility Timeout</Label>
															<HelpTooltip topic="visibility-timeout" />
														</div>
														<div className="flex items-center gap-1.5">
															<FormControl><Input type="number" min={0} max={43200} {...f} value={f.value ?? 30} onChange={(e) => f.onChange(parseInt(e.target.value) || 30)} className="h-8 text-xs" /></FormControl>
															<span className="text-[10px] text-muted-foreground shrink-0 w-6">{formatTimeout(f.value ?? 30)}</span>
														</div>
													</FormItem>
												)} />
												<FormField control={control} name={`queues.${i}.fifo`} render={({ field: f }) => (
													<FormItem className="space-y-1">
														<div className="flex items-center gap-1"><Label className="text-[10px] text-muted-foreground">FIFO</Label><HelpTooltip topic="fifo" /></div>
														<div className="flex items-center h-8"><Switch checked={f.value ?? false} onCheckedChange={f.onChange} /></div>
													</FormItem>
												)} />
											</div>
											<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0" onClick={() => queues.remove(i)}>
												<Trash2 className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
						{topics.fields.length > 0 && (
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">Topics</Label>
								{topics.fields.map((field, i) => (
									<div key={field.id} className="flex items-center gap-3 p-3 border border-border/50 rounded-lg">
										<FormField control={control} name={`topics.${i}.name`} render={({ field: f }) => (
											<FormItem className="flex-1 space-y-1">
												<Label className="text-[10px] text-muted-foreground">Name <span className="text-destructive">*</span></Label>
												<FormControl><Input placeholder="user-events" {...f} value={f.value || ""} onChange={(e) => f.onChange(e.target.value.toLowerCase())} className="h-8 text-xs font-mono" /></FormControl>
											</FormItem>
										)} />
										<Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0" onClick={() => topics.remove(i)}>
											<Trash2 className="h-3.5 w-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
