"use client";

import {
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import type { CachedAwsResources } from "@/app/server/actions/aws/resources";
import { UseFormReturn } from "react-hook-form";
import type { ConfigFormValues } from "./configuration-form";

interface SectionDatabaseProps {
	form: UseFormReturn<ConfigFormValues>;
	awsResources: CachedAwsResources | null;
}

export function SectionDatabase({ form, awsResources }: SectionDatabaseProps) {
	const createRds = form.watch("create_rds") ?? true;

	return (
		<Card className="shadow-sm border border-border/40">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="text-base font-medium">
							Database
						</CardTitle>
						<CardDescription className="text-xs">
							Aurora Serverless v2 (PostgreSQL)
						</CardDescription>
					</div>
					<Switch
						checked={createRds}
						onCheckedChange={(checked) =>
							form.setValue("create_rds", checked)
						}
					/>
				</div>
			</CardHeader>
			{createRds && (
				<CardContent className="pt-6">
					<div className="flex items-center gap-2 mb-4">
						<Badge
							variant="outline"
							className="text-[10px] py-0 px-1.5 text-muted-foreground"
						>
							Aurora PostgreSQL
						</Badge>
						<Badge
							variant="outline"
							className="text-[10px] py-0 px-1.5 text-muted-foreground"
						>
							Serverless v2
						</Badge>
					</div>
					<div className="grid gap-5 sm:grid-cols-2">
						<FormField
							control={form.control}
							name="db_min_capacity"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs">
										Min Capacity (ACU)
									</FormLabel>
									<FormControl>
										<Input
											type="number"
											min={0.5}
											max={128}
											step={0.5}
											className="h-9 text-sm"
											value={field.value ?? 2}
											onChange={(e) =>
												field.onChange(
													parseFloat(
														e.target.value,
													),
												)
											}
										/>
									</FormControl>
									<p className="text-[10px] text-muted-foreground">
										~${((field.value ?? 2) * 0.12 * 730).toFixed(0)}/mo at min
									</p>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="db_max_capacity"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="text-xs">
										Max Capacity (ACU)
									</FormLabel>
									<FormControl>
										<Input
											type="number"
											min={0.5}
											max={128}
											step={0.5}
											className="h-9 text-sm"
											value={field.value ?? 16}
											onChange={(e) =>
												field.onChange(
													parseFloat(
														e.target.value,
													),
												)
											}
										/>
									</FormControl>
									<p className="text-[10px] text-muted-foreground">
										~${((field.value ?? 16) * 0.12 * 730).toFixed(0)}/mo at max
									</p>
									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
				</CardContent>
			)}
		</Card>
	);
}
