"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
	FormControl, FormField, FormItem, FormMessage,
} from "@/components/ui/form";
import { ZoneSelector } from "@/components/zones/zone-selector";
import { HelpTooltip } from "./help-tooltip";
import { Box } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { SpecFormData } from "@/lib/validations/spec-form.schema";

export function SectionProjectBasics() {
	const { control } = useFormContext<SpecFormData>();

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Box className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Project Basics</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Name your spec and choose where it runs.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5">
						<Label className="text-xs">Zone <span className="text-destructive">*</span></Label>
						<HelpTooltip topic="zone" />
					</div>
					<FormField
						control={control}
						name="spec.zone_id"
						render={({ field }) => (
							<FormItem>
								<FormControl>
									<ZoneSelector
										value={field.value ?? undefined}
										onChange={(v) => field.onChange(v || "")}
									/>
								</FormControl>
								<FormMessage className="text-[11px]" />
							</FormItem>
						)}
					/>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">
							Spec Name <span className="text-destructive">*</span>
						</Label>
						<FormField
							control={control}
							name="spec.project_name"
							render={({ field }) => (
								<FormItem>
									<FormControl>
										<Input
											placeholder="my-project"
											maxLength={25}
											{...field}
											onChange={(e) => field.onChange(e.target.value.toLowerCase())}
											className="h-9 text-sm font-mono"
										/>
									</FormControl>
									<div className="flex items-center justify-between">
										<FormMessage className="text-[11px]" />
										{field.value && field.value.length > 0 && (
											<p className="text-[11px] text-muted-foreground tabular-nums">
												{field.value.length}/25
											</p>
										)}
									</div>
								</FormItem>
							)}
						/>
					</div>

					<div className="space-y-1.5">
						<div className="flex items-center gap-1.5">
							<Label className="text-xs">
								Environment <span className="text-destructive">*</span>
							</Label>
							<HelpTooltip topic="environment" />
						</div>
						<FormField
							control={control}
							name="spec.environment_stage"
							render={({ field }) => (
								<FormItem>
									<Select value={field.value ?? "development"} onValueChange={field.onChange}>
										<FormControl>
											<SelectTrigger className="h-9 text-sm">
												<SelectValue />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="development">Development</SelectItem>
											<SelectItem value="staging">Staging</SelectItem>
											<SelectItem value="production">Production</SelectItem>
										</SelectContent>
									</Select>
								</FormItem>
							)}
						/>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
