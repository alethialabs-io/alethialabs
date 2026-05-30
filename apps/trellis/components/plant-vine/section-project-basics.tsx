"use client";

import {
	Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
	FormControl, FormField, FormItem,
} from "@/components/ui/form";
import { VineyardSelector } from "@/components/vineyard-selector";
import { HelpTooltip } from "./help-tooltip";
import { useVineStore } from "./use-vine-store";
import { Grape } from "lucide-react";
import { useFormContext } from "react-hook-form";
import type { VineFormData } from "@/lib/validations/vine-form.schema";

const PROJECT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function SectionProjectBasics() {
	const { control, watch } = useFormContext<VineFormData>();
	const projectName = watch("vine.project_name");
	const submitted = useVineStore((s) => s.submitted);

	const nameError =
		projectName && projectName.length > 0 && !PROJECT_NAME_REGEX.test(projectName)
			? "Lowercase letters, numbers, and hyphens only."
			: submitted && (!projectName || !projectName.trim())
				? "Vine name is required."
				: null;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center gap-2">
					<Grape className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-base">Project Basics</CardTitle>
				</div>
				<CardDescription className="text-xs">
					Name your vine and choose where it grows.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-1.5">
					<div className="flex items-center gap-1.5">
						<Label className="text-xs">Vineyard Workspace (optional)</Label>
						<HelpTooltip topic="vineyard" />
					</div>
					<FormField
						control={control}
						name="vine.vineyard_id"
						render={({ field }) => (
							<FormItem>
								<FormControl>
									<VineyardSelector
										value={field.value ?? undefined}
										onChange={(v) => field.onChange(v || null)}
									/>
								</FormControl>
							</FormItem>
						)}
					/>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-1.5">
						<Label className="text-xs">
							Vine Name <span className="text-destructive">*</span>
						</Label>
						<FormField
							control={control}
							name="vine.project_name"
							render={({ field }) => (
								<FormItem>
									<FormControl>
										<Input
											placeholder="my-project"
											maxLength={25}
											{...field}
											onChange={(e) => field.onChange(e.target.value.toLowerCase())}
											className={`h-9 text-sm font-mono ${nameError ? "border-destructive" : ""}`}
										/>
									</FormControl>
									<div className="flex items-center justify-between">
										{nameError ? (
											<p className="text-[11px] text-destructive">{nameError}</p>
										) : (
											<p className="text-[11px] text-muted-foreground">
												Lowercase, numbers, hyphens. Used in AWS resource names.
											</p>
										)}
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
							name="vine.environment_stage"
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
