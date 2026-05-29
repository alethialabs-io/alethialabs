"use client";

import {
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
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
import { ContainerPlatformSelector } from "@/components/container-platform-selector";
import { EksVersionSelector } from "./eks-version-selector";
import { UseFormReturn } from "react-hook-form";
import type { ConfigFormValues } from "./configuration-form";

const TERRAFORM_VERSIONS = [
	{ value: "1.11.4", label: "1.11.4", latest: true },
	{ value: "1.10.5", label: "1.10.5" },
	{ value: "1.9.8", label: "1.9.8" },
];

interface SectionPlatformEksProps {
	form: UseFormReturn<ConfigFormValues>;
}

export function SectionPlatformEks({ form }: SectionPlatformEksProps) {
	return (
		<Card className="shadow-sm border border-border/40">
			<CardHeader className="bg-muted/5 border-b border-border/40 pb-4">
				<CardTitle className="text-base font-medium">
					Platform & Versions
				</CardTitle>
				<CardDescription className="text-xs">
					Choose your container platform and infrastructure versions.
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6 space-y-5">
				<FormField
					control={form.control}
					name="container_platform"
					render={({ field }) => (
						<FormItem>
							<FormLabel className="text-xs">
								Container Platform *
							</FormLabel>
							<FormControl>
								<ContainerPlatformSelector
									selected={field.value}
									onSelect={field.onChange}
								/>
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>

				<div className="grid gap-5 sm:grid-cols-2">
					<FormField
						control={form.control}
						name="eks_version"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									EKS Version *
								</FormLabel>
								<FormControl>
									<EksVersionSelector
										value={field.value ?? "1.32"}
										onChange={field.onChange}
									/>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>

					<FormField
						control={form.control}
						name="terraform_version"
						render={({ field }) => (
							<FormItem>
								<FormLabel className="text-xs">
									Terraform Version *
								</FormLabel>
								<Select
									value={field.value}
									onValueChange={field.onChange}
								>
									<FormControl>
										<SelectTrigger className="h-9 text-sm">
											<SelectValue placeholder="Select version" />
										</SelectTrigger>
									</FormControl>
									<SelectContent>
										{TERRAFORM_VERSIONS.map((v) => (
											<SelectItem
												key={v.value}
												value={v.value}
											>
												{v.label}
												{v.latest && " (Latest)"}
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
