"use client";

import {
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { VineyardSelector } from "@/components/vineyard-selector";
import { UseFormReturn } from "react-hook-form";
import type { ConfigFormValues } from "./configuration-form";

const ENVIRONMENTS = [
	{ value: "development", label: "Development" },
	{ value: "staging", label: "Staging" },
	{ value: "production", label: "Production" },
];

interface SectionProjectBasicsProps {
	form: UseFormReturn<ConfigFormValues>;
}

export function SectionProjectBasics({ form }: SectionProjectBasicsProps) {
	return (
		<Card className="shadow-sm border border-border/40">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-base font-medium">
					Project Basics
				</CardTitle>
				<CardDescription className="text-xs">
					Name your configuration and select a workspace.
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6 space-y-5">
				<FormField
					control={form.control}
					name="vineyard_id"
					render={({ field }) => (
						<FormItem>
							<FormLabel className="text-xs">
								Vineyard (Workspace)
							</FormLabel>
							<FormControl>
								<VineyardSelector
									value={field.value ?? ""}
									onChange={field.onChange}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>

				<div className="grid gap-5 sm:grid-cols-2">
					<FormField
						control={form.control}
						name="project_name"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									Project Name *
								</FormLabel>
								<FormControl>
									<Input
										placeholder="my-project"
										className="h-9 text-sm"
										maxLength={25}
										{...field}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="environment_stage"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									Environment *
								</FormLabel>
								<Select
									value={field.value}
									onValueChange={field.onChange}
								>
									<FormControl>
										<SelectTrigger className="h-9 text-sm">
											<SelectValue placeholder="Select environment" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										{ENVIRONMENTS.map((env) => (
											<SelectItem
												key={env.value}
												value={env.value}
											>
												{env.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FormMessage />
							</FormItem>
						)}
					/>
				</div>
			</CardContent>
		</Card>
	);
}
