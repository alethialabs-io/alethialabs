"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Access — the authored grants design: an inheritance info-note, a stat strip
// (Grants / Org-wide / Zone-scoped / Spec-scoped), a toolbar (search · scope filter · Add
// grant), an inline grant builder with a live preview, and the grants table. Composed
// from the shared settings primitives; wired to grants.ts (listAccessGrants /
// getGrantOptions / assignGrant / revokeGrant). Enterprise-gated on customRoles.

import { formatDistanceToNow } from "date-fns";
import { Info, MoreHorizontal, Plus, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type AccessGrantRow,
	assignGrant,
	getGrantOptions,
	type GrantOptions,
	listAccessGrants,
	revokeGrant,
} from "@/app/server/actions/grants";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import {
	SettingsSearch,
	SettingsSelect,
	SettingsTableCard,
	SettingsTableFoot,
	settingsTableRows,
	settingsTd,
	settingsTh,
	StatCell,
	StatStrip,
} from "@/components/settings/settings-ui";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Combobox } from "./combobox";

const SCOPE_LEVEL: Record<string, string> = {
	org: "Org-wide",
	zone: "Zone",
	spec: "Spec",
	runner: "Runner",
	cloud_identity: "Cloud identity",
};
const SCOPE_OPTIONS = [
	{ value: "org", label: "Entire organization" },
	{ value: "zone", label: "A Zone" },
	{ value: "spec", label: "A Spec" },
	{ value: "runner", label: "A runner" },
	{ value: "cloud_identity", label: "A cloud identity" },
];

/** Qualitative inheritance reach for a scope (exact counts are a backend gap). */
function reachLabel(resourceType: string): string {
	switch (resourceType) {
		case "org":
			return "All Zones & Specs";
		case "zone":
			return "This Zone & its Specs";
		case "spec":
			return "This Spec";
		case "runner":
			return "This runner";
		case "cloud_identity":
			return "This identity";
		default:
			return "—";
	}
}
function initials(s: string): string {
	return s.slice(0, 2).toUpperCase();
}

export function AccessManager() {
	const entitled = useEntitlement("customRoles");
	const [grants, setGrants] = useState<AccessGrantRow[] | null>(null);
	const [options, setOptions] = useState<GrantOptions | null>(null);
	const [search, setSearch] = useState("");
	const [scopeFilter, setScopeFilter] = useState("all");
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<AccessGrantRow | null>(null);

	const load = useCallback(() => {
		listAccessGrants()
			.then(setGrants)
			.catch(() => setGrants([]));
		getGrantOptions()
			.then(setOptions)
			.catch(() => setOptions(null));
	}, []);
	useEffect(() => {
		if (entitled) load();
	}, [entitled, load]);

	// Resolve a scoped resource id → a friendly label via the option lists.
	const resourceLabel = useMemo(() => {
		const map = new Map<string, string>();
		if (options) {
			for (const [type, list] of Object.entries(options.resources)) {
				for (const r of list) map.set(`${type}:${r.id}`, r.label);
			}
		}
		return (type: string, id: string | null) =>
			id ? (map.get(`${type}:${id}`) ?? `${id.slice(0, 8)}…`) : "—";
	}, [options]);

	const revoke = async (g: AccessGrantRow) => {
		try {
			await revokeGrant(g.id);
			toast.success("Access revoked");
			setDeleting(null);
			load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't revoke access");
		}
	};

	const all = useMemo(() => grants ?? [], [grants]);
	const stats = {
		total: all.length,
		org: all.filter((g) => g.resourceType === "org").length,
		zone: all.filter((g) => g.resourceType === "zone").length,
		spec: all.filter((g) => g.resourceType === "spec").length,
	};

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return all.filter((g) => {
			if (scopeFilter !== "all" && g.resourceType !== scopeFilter) return false;
			if (q) {
				const scope =
					g.resourceType === "org"
						? "organization"
						: resourceLabel(g.resourceType, g.resourceId);
				if (!`${g.principalLabel} ${scope}`.toLowerCase().includes(q)) return false;
			}
			return true;
		});
	}, [all, scopeFilter, search, resourceLabel]);

	return (
		<div>
			{/* inheritance note */}
				<div className="mb-[18px] flex gap-3 rounded-lg border border-border bg-surface-sunken p-4">
					<Info size={16} className="mt-0.5 shrink-0 text-text-tertiary" />
					<p className="text-[12.5px] leading-relaxed text-text-secondary">
						<b className="font-medium text-text-primary">
							Org → Zone → Spec inheritance.
						</b>{" "}
						A grant on the org applies everywhere; a grant on a Zone applies to it and
						every Spec it contains; a grant on a single Spec is exact. Lower scopes can
						add access, never remove it.
					</p>
				</div>

				{grants === null ? (
					<div className="space-y-3">
						<Skeleton className="h-20 w-full" />
						<Skeleton className="h-64 w-full" />
					</div>
				) : (
					<>
						<StatStrip>
							<StatCell label="Grants" value={stats.total} sub="active" />
							<StatCell label="Org-wide" value={stats.org} sub="grants" />
							<StatCell label="Zone-scoped" value={stats.zone} sub="grants" />
							<StatCell label="Spec-scoped" value={stats.spec} sub="grants" />
						</StatStrip>

						{/* toolbar */}
						<div className="mb-[14px] flex flex-wrap items-center justify-between gap-4">
							<div className="flex items-center gap-3">
								<SettingsSearch
									value={search}
									onChange={setSearch}
									placeholder="Search principal or scope"
									className="w-[230px]"
								/>
								<SettingsSelect
									aria-label="Filter by scope"
									className="w-[150px]"
									value={scopeFilter}
									onChange={setScopeFilter}
									options={[
										{ value: "all", label: "All scopes" },
										{ value: "org", label: "Org-wide" },
										{ value: "zone", label: "Zone" },
										{ value: "spec", label: "Spec" },
									]}
								/>
							</div>
							<Button size="sm" onClick={() => setCreating((v) => !v)}>
								<Plus size={13} />
								Add grant
							</Button>
						</div>

						{/* inline grant builder */}
						{creating && options && (
							<GrantBuilder
								options={options}
								resourceLabel={resourceLabel}
								onCancel={() => setCreating(false)}
								onGranted={() => {
									setCreating(false);
									load();
								}}
							/>
						)}

						{/* grants table */}
						<SettingsTableCard
							foot={
								<SettingsTableFoot>
									<span>
										Showing{" "}
										<b className="font-medium text-text-secondary">{filtered.length}</b>{" "}
										of {all.length}
									</span>
								</SettingsTableFoot>
							}
						>
							<table className={settingsTableRows}>
								<thead>
									<tr>
										<th className={settingsTh}>Principal</th>
										<th className={settingsTh}>Role</th>
										<th className={settingsTh}>Scope</th>
										<th className={settingsTh}>Effective reach</th>
										<th className={settingsTh}>Granted</th>
										<th className={settingsTh} />
									</tr>
								</thead>
								<tbody>
									{filtered.map((g) => (
										<tr key={g.id}>
											<td className={settingsTd}>
												<div className="flex items-center gap-[11px]">
													<span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-muted font-mono text-[11px] text-text-secondary">
														{initials(g.principalLabel)}
													</span>
													<div className="flex min-w-0 flex-col gap-0.5">
														<span className="truncate text-[13px] text-text-primary">
															{g.principalLabel}
														</span>
														<span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
															{g.principalType === "team" ? "Team" : "Member"}
														</span>
													</div>
												</div>
											</td>
											<td className={settingsTd}>
												<div className="flex items-center gap-2">
													{g.roleName ? (
														<span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-1 text-[12px] font-medium capitalize text-text-primary">
															<Shield size={12} className="text-text-tertiary" />
															{g.roleName}
														</span>
													) : (
														<code className="font-mono text-[11.5px] text-text-primary">
															{g.permissionKey ?? "—"}
														</code>
													)}
													{g.effect === "deny" && (
														<span className="rounded-full border border-text-primary px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-text-primary">
															Deny
														</span>
													)}
												</div>
											</td>
											<td className={settingsTd}>
												<div className="flex flex-col gap-0.5">
													<span className="text-[13px] text-text-primary">
														{g.resourceType === "org"
															? "Organization"
															: resourceLabel(g.resourceType, g.resourceId)}
													</span>
													<span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
														{SCOPE_LEVEL[g.resourceType] ?? g.resourceType}
													</span>
												</div>
											</td>
											<td
												className={cn(
													settingsTd,
													"whitespace-nowrap font-mono text-[11px] text-text-tertiary",
												)}
											>
												{reachLabel(g.resourceType)}
											</td>
											<td
												className={cn(
													settingsTd,
													"whitespace-nowrap font-mono text-[11px] text-text-tertiary",
												)}
											>
												{formatDistanceToNow(new Date(g.createdAt), { addSuffix: true })}
											</td>
											<td className={settingsTd}>
												<DropdownMenu>
													<DropdownMenuTrigger asChild>
														<button
															type="button"
															aria-label="Manage grant"
															className="inline-flex size-7 items-center justify-center rounded-sm text-text-disabled transition-colors hover:bg-surface-muted hover:text-text-primary"
														>
															<MoreHorizontal size={16} />
														</button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end" className="w-40">
														<DropdownMenuItem
															className="text-destructive focus:text-destructive"
															onClick={() => setDeleting(g)}
														>
															Revoke access
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</td>
										</tr>
									))}
								</tbody>
							</table>
							{filtered.length === 0 && (
								<div className="px-5 py-10 text-center text-[13px] text-text-tertiary">
									{all.length === 0
										? "No access grants yet. Use “Add grant” to assign a role or permission."
										: "No grants match these filters."}
								</div>
							)}
						</SettingsTableCard>
					</>
				)}

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Revoke this grant?</AlertDialogTitle>
						<AlertDialogDescription>
							The principal loses this access immediately. Inherited access from other
							grants is unaffected. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void revoke(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Revoke access
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** The inline grant builder — principal · effect · role/permission · scope + live preview. */
function GrantBuilder({
	options,
	resourceLabel,
	onCancel,
	onGranted,
}: {
	options: GrantOptions;
	resourceLabel: (type: string, id: string | null) => string;
	onCancel: () => void;
	onGranted: () => void;
}) {
	const [principalId, setPrincipalId] = useState("");
	const [effect, setEffect] = useState<"allow" | "deny">("allow");
	const [mode, setMode] = useState<"role" | "permission">("role");
	const [roleId, setRoleId] = useState("");
	const [permissionKey, setPermissionKey] = useState("");
	const [scopeType, setScopeType] = useState("org");
	const [resourceId, setResourceId] = useState("");
	const [saving, setSaving] = useState(false);

	const principalOpts = options.principals.map((p) => ({
		value: p.id,
		label: p.type === "team" ? `${p.label} · team` : p.label,
	}));
	const permissionOpts = options.permissions.map((p) => ({
		value: p.key,
		label: p.key,
	}));
	const resourceOpts =
		scopeType !== "org" && scopeType in options.resources
			? options.resources[scopeType as keyof GrantOptions["resources"]].map((r) => ({
					value: r.id,
					label: r.label,
				}))
			: [];

	const what = mode === "role" ? roleId : permissionKey;
	const valid = Boolean(principalId && what && (scopeType === "org" || resourceId));

	const preview = useMemo(() => {
		if (!valid) return null;
		const pName = options.principals.find((p) => p.id === principalId)?.label ?? "—";
		const wName =
			mode === "role"
				? (options.roles.find((r) => r.id === roleId)?.name ?? "—")
				: permissionKey;
		const sName =
			scopeType === "org"
				? "the organization"
				: resourceLabel(scopeType, resourceId);
		return { pName, wName, sName, reach: reachLabel(scopeType) };
	}, [
		valid,
		options,
		principalId,
		mode,
		roleId,
		permissionKey,
		scopeType,
		resourceId,
		resourceLabel,
	]);

	async function submit() {
		if (!valid) return;
		setSaving(true);
		try {
			const principal = options.principals.find((p) => p.id === principalId);
			await assignGrant({
				principalType: principal?.type ?? "user",
				principalId,
				effect,
				roleId: mode === "role" ? roleId : null,
				permissionKey: mode === "permission" ? permissionKey : null,
				resourceType: scopeType === "org" ? "org" : scopeType,
				resourceId: scopeType === "org" ? null : resourceId,
			});
			toast.success("Access granted");
			onGranted();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't grant access");
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
			<p className="text-[13px] font-medium text-text-primary">New grant</p>
			<p className="mb-3 text-[11.5px] text-text-tertiary">
				Bind a principal to a role or permission on a scope. Inheritance is computed
				from the scope you pick.
			</p>

			<div className="grid gap-3 sm:grid-cols-3">
				<div>
					<div className="mb-1.5 text-[11.5px] text-text-tertiary">Principal</div>
					<Combobox
						options={principalOpts}
						value={principalId}
						onChange={setPrincipalId}
						placeholder="Select a member or team…"
					/>
				</div>
				<div>
					<div className="mb-1.5 flex items-center justify-between">
						<span className="text-[11.5px] text-text-tertiary">Grant</span>
						<Toggle
							value={mode}
							onChange={setMode}
							options={[
								{ value: "role", label: "Role" },
								{ value: "permission", label: "Permission" },
							]}
						/>
					</div>
					{mode === "role" ? (
						<SettingsSelect
							aria-label="Role"
							value={roleId}
							onChange={setRoleId}
							options={[
								{ value: "", label: "Select a role…" },
								...options.roles.map((r) => ({
									value: r.id,
									label: r.builtin ? `${r.name} (built-in)` : r.name,
								})),
							]}
						/>
					) : (
						<Combobox
							options={permissionOpts}
							value={permissionKey}
							onChange={setPermissionKey}
							placeholder="Select a permission…"
						/>
					)}
				</div>
				<div>
					<div className="mb-1.5 text-[11.5px] text-text-tertiary">Scope</div>
					<SettingsSelect
						aria-label="Scope"
						value={scopeType}
						onChange={(v) => {
							setScopeType(v);
							setResourceId("");
						}}
						options={SCOPE_OPTIONS}
					/>
					{scopeType !== "org" && (
						<div className="mt-2">
							<Combobox
								options={resourceOpts}
								value={resourceId}
								onChange={setResourceId}
								placeholder="Select a resource…"
							/>
						</div>
					)}
				</div>
			</div>

			<div className="mt-3 flex items-center gap-2">
				<span className="text-[11.5px] text-text-tertiary">Effect</span>
				<Toggle
					value={effect}
					onChange={setEffect}
					options={[
						{ value: "allow", label: "Allow" },
						{ value: "deny", label: "Deny" },
					]}
				/>
			</div>

			{preview && (
				<div className="mt-3 flex items-start gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
					<Info size={13} className="mt-0.5 shrink-0 text-text-tertiary" />
					<span className="text-[12px] text-text-secondary">
						<b className="font-medium text-text-primary">{preview.pName}</b> will{" "}
						{effect} <b className="font-medium text-text-primary">{preview.wName}</b> on{" "}
						<b className="font-medium text-text-primary">{preview.sName}</b> —{" "}
						{preview.reach.toLowerCase()}.
					</span>
				</div>
			)}

			<div className="mt-3 flex items-center justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button size="sm" disabled={!valid || saving} onClick={() => void submit()}>
					{saving ? "Adding…" : "Add grant"}
				</Button>
			</div>
		</div>
	);
}

/** A small two-option segmented toggle. */
function Toggle<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
}) {
	return (
		<div className="inline-flex gap-0.5 rounded-sm border border-border-strong bg-surface-sunken p-[2px]">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					onClick={() => onChange(o.value)}
					className={cn(
						"rounded-[3px] px-2 py-0.5 text-[11px] font-medium transition-colors",
						o.value === value
							? "bg-surface text-text-primary shadow-sm"
							: "text-text-tertiary hover:text-text-secondary",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
