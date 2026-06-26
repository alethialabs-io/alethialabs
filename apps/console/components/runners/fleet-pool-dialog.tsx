"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { ProviderIcon, PROVIDER_LABELS, type Provider } from "@repo/ui/provider-icon";
import { cloudProvider, type FleetPool } from "@/lib/db/schema";
import { useFleetStore } from "@/lib/stores/use-fleet-store";
import type { FleetPoolCreateInput } from "@/lib/validations/fleet";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";

// Form-level schema: locations are entered as a comma-separated string and the
// version source is an explicit toggle; both are mapped to the server input on submit.
const formSchema = z.object({
	provider: z.enum(cloudProvider.enumValues),
	name: z.string().trim().max(60).optional(),
	locationsCsv: z.string().trim().min(1, "At least one location"),
	warmMin: z.number().int().min(0),
	max: z.number().int().min(0),
	slotsPerRunner: z.number().int().min(1),
	minPerLocation: z.number().int().min(0),
	surge: z.number().int().min(1),
	buffer: z.number().int().min(0),
	scaleDownGraceTicks: z.number().int().min(1),
	versionSource: z.enum(["channel", "pin"]),
	channel: z.string().trim().optional(),
	version: z.string().trim().optional(),
});
type FormValues = z.infer<typeof formSchema>;

const DEFAULTS: FormValues = {
	provider: "aws",
	name: "",
	locationsCsv: "fsn1, nbg1",
	warmMin: 1,
	max: 10,
	slotsPerRunner: 1,
	minPerLocation: 0,
	surge: 1,
	buffer: 1,
	scaleDownGraceTicks: 5,
	versionSource: "channel",
	channel: "stable",
	version: "",
};

/** Map a stored pool row to form values (edit mode). */
function poolToForm(pool: FleetPool): FormValues {
	return {
		provider: pool.provider,
		name: pool.name ?? "",
		locationsCsv: pool.locations.join(", "),
		warmMin: pool.warm_min,
		max: pool.max,
		slotsPerRunner: pool.slots_per_runner,
		minPerLocation: pool.min_per_location,
		surge: pool.surge,
		buffer: pool.buffer,
		scaleDownGraceTicks: pool.scale_down_grace_ticks,
		versionSource: pool.version ? "pin" : "channel",
		channel: pool.channel ?? "stable",
		version: pool.version ?? "",
	};
}

/** Map validated form values to the server create/update input. */
function formToInput(v: FormValues): FleetPoolCreateInput {
	return {
		provider: v.provider,
		name: v.name?.trim() ? v.name.trim() : undefined,
		locations: v.locationsCsv.split(",").map((s) => s.trim()).filter(Boolean),
		warmMin: v.warmMin,
		max: v.max,
		slotsPerRunner: v.slotsPerRunner,
		minPerLocation: v.minPerLocation,
		surge: v.surge,
		buffer: v.buffer,
		scaleDownGraceTicks: v.scaleDownGraceTicks,
		version: v.versionSource === "pin" ? (v.version?.trim() || undefined) : undefined,
		channel: v.versionSource === "channel" ? (v.channel?.trim() || undefined) : undefined,
	};
}

const NUMBER_FIELDS: { name: keyof FormValues; label: string; hint: string }[] = [
	{ name: "warmMin", label: "Warm min", hint: "always-on floor" },
	{ name: "max", label: "Max", hint: "hard ceiling" },
	{ name: "slotsPerRunner", label: "Slots / runner", hint: "concurrent jobs" },
	{ name: "minPerLocation", label: "Min / location", hint: "per-DC floor" },
	{ name: "surge", label: "Surge", hint: "extra during rollout" },
	{ name: "buffer", label: "Buffer", hint: "idle headroom (N+1)" },
	{ name: "scaleDownGraceTicks", label: "Scale-down grace", hint: "ticks before reap" },
];

interface FleetPoolDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Null = create; a row = edit (provider is then fixed). */
	pool: FleetPool | null;
	/** Providers that already have a pool (disabled in the create select). */
	usedProviders: string[];
}

/** Create/edit a managed warm pool. Provider is immutable once created (one pool per cloud). */
export function FleetPoolDialog({ open, onOpenChange, pool, usedProviders }: FleetPoolDialogProps) {
	const { createPool, updatePool } = useFleetStore();
	const isEdit = pool !== null;

	const {
		control,
		register,
		handleSubmit,
		reset,
		watch,
		formState: { errors, isSubmitting },
	} = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: DEFAULTS,
	});

	useEffect(() => {
		if (!open) return;
		reset(pool ? poolToForm(pool) : DEFAULTS);
	}, [open, pool, reset]);

	const versionSource = watch("versionSource");

	const onSubmit = async (values: FormValues) => {
		try {
			const input = formToInput(values);
			if (isEdit && pool) {
				await updatePool(pool.id, input);
				toast.success("Pool updated");
			} else {
				await createPool(input);
				toast.success("Pool created");
			}
			onOpenChange(false);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to save pool");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit pool" : "Add pool"}</DialogTitle>
					<DialogDescription>
						A declarative warm pool the controller keeps sized to demand. Changes converge on the next tick.
					</DialogDescription>
				</DialogHeader>

				<form id="fleet-pool-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label>Provider</Label>
							<Controller
								control={control}
								name="provider"
								render={({ field }) => (
									<Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{cloudProvider.enumValues.map((p) => (
												<SelectItem key={p} value={p} disabled={!isEdit && usedProviders.includes(p)}>
													<span className="flex items-center gap-2">
														<ProviderIcon provider={p} size={16} />
														{PROVIDER_LABELS[p as Provider] ?? p}
													</span>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>Name (optional)</Label>
							<Input placeholder="e.g. AWS primary" {...register("name")} />
						</div>
					</div>

					<div className="space-y-1.5">
						<Label>Locations</Label>
						<Input placeholder="fsn1, nbg1" {...register("locationsCsv")} />
						{errors.locationsCsv && (
							<p className="text-xs text-destructive">{errors.locationsCsv.message}</p>
						)}
						<p className="text-[11px] text-muted-foreground">Comma-separated region codes to spread across.</p>
					</div>

					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						{NUMBER_FIELDS.map((f) => (
							<div key={f.name} className="space-y-1.5">
								<Label className="text-xs">{f.label}</Label>
								<Input type="number" min={0} {...register(f.name, { valueAsNumber: true })} />
								<p className="text-[10px] text-muted-foreground">{f.hint}</p>
							</div>
						))}
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label>Version source</Label>
							<Controller
								control={control}
								name="versionSource"
								render={({ field }) => (
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="channel">Channel (auto-update)</SelectItem>
											<SelectItem value="pin">Pinned version</SelectItem>
										</SelectContent>
									</Select>
								)}
							/>
						</div>
						<div className="space-y-1.5">
							<Label>{versionSource === "pin" ? "Version" : "Channel"}</Label>
							{versionSource === "pin" ? (
								<Input placeholder="e.g. v1.4.2" {...register("version")} />
							) : (
								<Input placeholder="stable" {...register("channel")} />
							)}
						</div>
					</div>
				</form>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
						Cancel
					</Button>
					<Button type="submit" form="fleet-pool-form" disabled={isSubmitting}>
						{isSubmitting ? "Saving…" : isEdit ? "Save changes" : "Create pool"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
