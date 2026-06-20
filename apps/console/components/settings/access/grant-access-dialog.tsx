"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { ShieldPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	assignGrant,
	getGrantOptions,
	type GrantOptions,
} from "@/app/server/actions/grants";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Combobox } from "./combobox";

const SCOPE_TYPES = ["zone", "spec", "runner", "cloud_identity"] as const;
const SCOPE_LABEL: Record<string, string> = {
	org: "Entire organization",
	zone: "A zone",
	spec: "A spec",
	runner: "A runner",
	cloud_identity: "A cloud identity",
};

const schema = z
	.object({
		principalId: z.string().min(1, "Pick who to grant access to"),
		effect: z.enum(["allow", "deny"]),
		mode: z.enum(["role", "permission"]),
		roleId: z.string().optional(),
		permissionKey: z.string().optional(),
		scopeType: z.enum(["org", "zone", "spec", "runner", "cloud_identity"]),
		resourceId: z.string().optional(),
	})
	.refine((d) => (d.mode === "role" ? !!d.roleId : !!d.permissionKey), {
		message: "Pick a role or a permission",
		path: ["roleId"],
	})
	.refine((d) => d.scopeType === "org" || !!d.resourceId, {
		message: "Pick a resource",
		path: ["resourceId"],
	});
type Data = z.infer<typeof schema>;

/** AWS-IAM-style grant builder: principal → role/permission → scope → allow/deny. */
export function GrantAccessDialog({ onGranted }: { onGranted?: () => void }) {
	const [open, setOpen] = useState(false);
	const [options, setOptions] = useState<GrantOptions | null>(null);

	const form = useForm<Data>({
		resolver: zodResolver(schema),
		defaultValues: {
			principalId: "",
			effect: "allow",
			mode: "role",
			scopeType: "org",
		},
	});
	const { control, watch, handleSubmit, setValue, formState } = form;
	const mode = watch("mode");
	const effect = watch("effect");
	const scopeType = watch("scopeType");

	useEffect(() => {
		if (open && !options) getGrantOptions().then(setOptions).catch(() => setOptions(null));
	}, [open, options]);

	const onSubmit = async (d: Data) => {
		try {
			const principal = options?.principals.find((p) => p.id === d.principalId);
			await assignGrant({
				principalType: principal?.type ?? "user",
				principalId: d.principalId,
				effect: d.effect,
				roleId: d.mode === "role" ? d.roleId : null,
				permissionKey: d.mode === "permission" ? d.permissionKey : null,
				resourceType: d.scopeType === "org" ? "org" : d.scopeType,
				resourceId: d.scopeType === "org" ? null : d.resourceId,
			});
			toast.success("Access granted");
			setOpen(false);
			form.reset();
			onGranted?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to grant access");
		}
	};

	const principalOpts =
		options?.principals.map((p) => ({
			value: p.id,
			label: p.type === "team" ? `${p.label} · team` : p.label,
		})) ?? [];
	const permissionOpts =
		options?.permissions.map((p) => ({ value: p.key, label: p.key })) ?? [];
	const resourceOpts =
		scopeType !== "org" && options
			? options.resources[scopeType].map((r) => ({ value: r.id, label: r.label }))
			: [];

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button size="sm" className="gap-2">
					<ShieldPlus className="h-4 w-4" />
					Grant access
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Grant access</DialogTitle>
					<DialogDescription>
						Give a member a role or a single permission, scoped to the whole org
						or one resource. Deny overrides an inherited allow.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
					{/* Principal */}
					<div className="space-y-1.5">
						<Label className="text-sm">Who</Label>
						<Controller
							control={control}
							name="principalId"
							render={({ field }) => (
								<Combobox
									options={principalOpts}
									value={field.value}
									onChange={field.onChange}
									placeholder="Select a member…"
								/>
							)}
						/>
						{formState.errors.principalId && (
							<p className="text-[11px] text-destructive">
								{formState.errors.principalId.message}
							</p>
						)}
					</div>

					{/* Effect */}
					<div className="space-y-1.5">
						<Label className="text-sm">Effect</Label>
						<div className="flex gap-2">
							{(["allow", "deny"] as const).map((e) => (
								<Button
									key={e}
									type="button"
									variant={effect === e ? "default" : "outline"}
									size="sm"
									className={cn(
										"flex-1 capitalize",
										effect === e && e === "deny" && "bg-destructive hover:bg-destructive/90",
									)}
									onClick={() => setValue("effect", e)}
								>
									{e}
								</Button>
							))}
						</div>
					</div>

					{/* What: role or single permission */}
					<div className="space-y-1.5">
						<Label className="text-sm">Grant</Label>
						<div className="flex gap-2">
							{(["role", "permission"] as const).map((m) => (
								<Button
									key={m}
									type="button"
									variant={mode === m ? "secondary" : "ghost"}
									size="sm"
									className="flex-1 capitalize"
									onClick={() => setValue("mode", m)}
								>
									{m === "role" ? "Role" : "Single permission"}
								</Button>
							))}
						</div>
						{mode === "role" ? (
							<Controller
								control={control}
								name="roleId"
								render={({ field }) => (
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger className="h-9">
											<SelectValue placeholder="Select a role…" />
										</SelectTrigger>
										<SelectContent>
											{options?.roles.map((r) => (
												<SelectItem key={r.id} value={r.id} className="capitalize">
													{r.name}
													{r.builtin ? " (built-in)" : ""}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							/>
						) : (
							<Controller
								control={control}
								name="permissionKey"
								render={({ field }) => (
									<Combobox
										options={permissionOpts}
										value={field.value}
										onChange={field.onChange}
										placeholder="Select a permission…"
									/>
								)}
							/>
						)}
						{formState.errors.roleId && (
							<p className="text-[11px] text-destructive">
								{formState.errors.roleId.message}
							</p>
						)}
					</div>

					{/* Scope */}
					<div className="space-y-1.5">
						<Label className="text-sm">Scope</Label>
						<Controller
							control={control}
							name="scopeType"
							render={({ field }) => (
								<Select
									value={field.value}
									onValueChange={(v) => {
										field.onChange(v);
										setValue("resourceId", undefined);
									}}
								>
									<SelectTrigger className="h-9">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="org">{SCOPE_LABEL.org}</SelectItem>
										{SCOPE_TYPES.map((t) => (
											<SelectItem key={t} value={t}>
												{SCOPE_LABEL[t]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						/>
						{scopeType !== "org" && (
							<Controller
								control={control}
								name="resourceId"
								render={({ field }) => (
									<Combobox
										options={resourceOpts}
										value={field.value}
										onChange={field.onChange}
										placeholder={`Select ${SCOPE_LABEL[scopeType].toLowerCase()}…`}
									/>
								)}
							/>
						)}
						{formState.errors.resourceId && (
							<p className="text-[11px] text-destructive">
								{formState.errors.resourceId.message}
							</p>
						)}
					</div>

					<DialogFooter>
						<Button type="submit" disabled={formState.isSubmitting}>
							Grant access
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
