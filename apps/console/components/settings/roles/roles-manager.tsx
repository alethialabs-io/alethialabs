"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Roles — the authored IAM-style master-detail: a left rail (Built-in +
// Custom roles) and a right detail panel with the permission matrix, plus a template
// gallery for creating from a predefined permission set. Composed from the shared
// settings primitives. Built-in roles come from the registry (read-only); custom roles
// are CRUD via roles.ts and gated on the customRoles entitlement.

import { Lock, Plus, Shield, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	createRole,
	type CustomRole,
	deleteRole,
	listCustomRoles,
	updateRole,
} from "@/app/server/actions/roles";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import {
	SettingsPageHead,
	SettingsSearch,
	settingsControl,
	settingsControlSize,
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
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { Skeleton } from "@repo/ui/skeleton";
import { BUILT_IN_ROLES, type BuiltInRole, PERMISSIONS } from "@/lib/authz/registry";
import { cn } from "@repo/ui/utils";
import { PermissionMatrix } from "./permission-matrix";

const ROLE_META: Record<BuiltInRole, string> = {
	owner: "Full control of the organization, including members and billing.",
	admin: "Everything except billing — manage members, identities, and all infrastructure.",
	operator:
		"Operate infrastructure (plan, deploy, destroy); no members, identities, or billing.",
	viewer: "Read-only access to everything.",
};
const ROLE_ORDER: BuiltInRole[] = ["owner", "admin", "operator", "viewer"];
const ALL_KEYS = PERMISSIONS.map((p) => p.key);

/** The permission keys a built-in role grants ("*" → every permission). */
function builtinKeys(role: BuiltInRole): string[] {
	const grant = BUILT_IN_ROLES[role];
	return grant === "*" ? ALL_KEYS : grant;
}
function cap(s: string): string {
	return s[0].toUpperCase() + s.slice(1);
}

const NEW_ID = "__new__";

/** Templates to start a custom role from — derived from the real built-in perm sets. */
const TEMPLATES = [
	{ id: "blank", name: "Blank", desc: "Start with no permissions.", perms: [] as string[] },
	...ROLE_ORDER.map((r) => ({
		id: r,
		name: `Based on ${cap(r)}`,
		desc: ROLE_META[r],
		perms: builtinKeys(r),
	})),
];

/** A rail row — selectable role with its permission count. */
function RailRow({
	name,
	count,
	active,
	onClick,
}: {
	name: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left transition-colors",
				active ? "bg-surface-muted" : "hover:bg-surface-muted/60",
			)}
		>
			<span
				className={cn(
					"truncate text-[13px]",
					active ? "font-medium text-text-primary" : "text-text-secondary",
				)}
			>
				{name}
			</span>
			<span className="shrink-0 font-mono text-[10.5px] text-text-tertiary">
				{count}
			</span>
		</button>
	);
}

export function RolesManager() {
	const entitled = useEntitlement("customRoles");
	const [customRoles, setCustomRoles] = useState<CustomRole[] | null>(null);
	const [selectedId, setSelectedId] = useState<string>("owner");
	const [search, setSearch] = useState("");
	const [gallery, setGallery] = useState(false);
	const [editName, setEditName] = useState("");
	const [editPerms, setEditPerms] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState<CustomRole | null>(null);

	const load = useCallback(() => {
		listCustomRoles()
			.then(setCustomRoles)
			.catch(() => setCustomRoles([]));
	}, []);
	useEffect(() => {
		load();
	}, [load]);

	const custom = useMemo(() => customRoles ?? [], [customRoles]);

	const select = useCallback(
		(id: string) => {
			setGallery(false);
			setSelectedId(id);
			const c = custom.find((r) => r.id === id);
			if (c) {
				setEditName(c.name);
				setEditPerms(c.permissionKeys);
			}
		},
		[custom],
	);

	function startTemplate(t: (typeof TEMPLATES)[number]) {
		setSelectedId(NEW_ID);
		setEditName(t.id === "blank" ? "" : `${t.id}-copy`);
		setEditPerms([...t.perms]);
		setGallery(false);
	}

	async function saveNew() {
		if (!editName.trim()) return;
		setSaving(true);
		try {
			const created = await createRole(editName.trim(), editPerms);
			toast.success("Role created");
			setSelectedId(created.id);
			setEditName(created.name);
			setEditPerms(created.permissionKeys);
			load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't create role");
		} finally {
			setSaving(false);
		}
	}

	async function saveEdit(id: string) {
		if (!editName.trim()) return;
		setSaving(true);
		try {
			await updateRole(id, editName.trim(), editPerms);
			toast.success("Role updated");
			load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't update role");
		} finally {
			setSaving(false);
		}
	}

	async function confirmDelete(r: CustomRole) {
		try {
			await deleteRole(r.id);
			toast.success("Role deleted");
			setDeleting(null);
			setCustomRoles((prev) => prev?.filter((x) => x.id !== r.id) ?? null);
			select("owner");
			load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't delete role");
		}
	}

	const q = search.trim().toLowerCase();
	const builtinList = ROLE_ORDER.filter((r) => r.includes(q));
	const customList = custom.filter((r) => r.name.toLowerCase().includes(q));

	function onCreateClick() {
		if (!entitled) {
			toast.info("Custom roles require an Enterprise plan.");
			return;
		}
		setGallery((v) => !v);
	}

	if (customRoles === null) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-72 w-full" />
			</div>
		);
	}

	const builtinSel = ROLE_ORDER.find((r) => r === selectedId);
	const customSel = custom.find((r) => r.id === selectedId);
	const isNew = selectedId === NEW_ID;

	return (
		<div>
			<SettingsPageHead
				eyebrow="Roles"
				title="Roles"
				description="A role is a named set of permissions. Assign it at the highest scope and let Org → Zone → Spec inheritance flow it down — sensitive scopes are never implied by a broad role."
			/>

			{/* toolbar */}
			<div className="mb-[14px] flex flex-wrap items-center justify-between gap-4">
				<div className="flex items-center gap-3">
					<SettingsSearch
						value={search}
						onChange={setSearch}
						placeholder="Search roles"
						className="w-[240px]"
					/>
					<span className="font-mono text-[11px] text-text-tertiary">
						{ROLE_ORDER.length} built-in · {custom.length} custom
					</span>
				</div>
				<Button size="sm" onClick={onCreateClick}>
					{entitled ? <Plus size={13} /> : <Lock size={13} />}
					Create role
				</Button>
			</div>

			{/* template gallery */}
			{gallery && entitled && (
				<div className="mb-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
					<div className="mb-3 flex items-start justify-between">
						<div>
							<p className="text-[13px] font-medium text-text-primary">
								Start from a template
							</p>
							<p className="text-[11.5px] text-text-tertiary">
								Predefined permission sets for common job functions. Everything stays
								editable after.
							</p>
						</div>
						<button
							type="button"
							aria-label="Close"
							onClick={() => setGallery(false)}
							className="text-text-tertiary hover:text-text-primary"
						>
							<X size={16} />
						</button>
					</div>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{TEMPLATES.map((t) => (
							<button
								type="button"
								key={t.id}
								onClick={() => startTemplate(t)}
								className="rounded-lg border border-border bg-surface-sunken p-3 text-left transition-colors hover:border-border-strong"
							>
								<div className="text-[13px] font-medium text-text-primary">
									{t.name}
								</div>
								<div className="mt-0.5 line-clamp-2 text-[11.5px] text-text-tertiary">
									{t.desc}
								</div>
								<div className="mt-2 font-mono text-[10px] text-text-tertiary">
									{t.perms.length} permission{t.perms.length === 1 ? "" : "s"}
								</div>
							</button>
						))}
					</div>
				</div>
			)}

			{/* master-detail */}
			<div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
				{/* rail */}
				<div className="rounded-lg border border-border bg-surface p-2 shadow-sm">
					<div className="px-2.5 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
						Built-in
					</div>
					{builtinList.map((r) => (
						<RailRow
							key={r}
							name={cap(r)}
							count={builtinKeys(r).length}
							active={selectedId === r}
							onClick={() => select(r)}
						/>
					))}
					<div className="my-2 h-px bg-border" />
					<div className="px-2.5 py-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-text-tertiary">
						Custom
					</div>
					{isNew && (
						<RailRow
							name={editName.trim() || "New role…"}
							count={editPerms.length}
							active
							onClick={() => undefined}
						/>
					)}
					{customList.length === 0 && !isNew ? (
						<div className="px-2.5 py-2 text-[11.5px] text-text-tertiary">
							No custom roles yet.
						</div>
					) : (
						customList.map((r) => (
							<RailRow
								key={r.id}
								name={r.name}
								count={r.permissionKeys.length}
								active={selectedId === r.id}
								onClick={() => select(r.id)}
							/>
						))
					)}
				</div>

				{/* detail */}
				<div className="rounded-lg border border-border bg-surface shadow-sm">
					{builtinSel ? (
						<RoleDetail
							title={cap(builtinSel)}
							badge="Built-in"
							description={ROLE_META[builtinSel]}
							perms={builtinKeys(builtinSel)}
						/>
					) : customSel || isNew ? (
						<div>
							<div className="border-b border-border px-5 py-4">
								<label
									htmlFor="role-name"
									className="mb-1.5 block text-[11.5px] text-text-tertiary"
								>
									Role name
								</label>
								<input
									id="role-name"
									className={cn(settingsControl, settingsControlSize, "max-w-sm")}
									value={editName}
									onChange={(e) => setEditName(e.target.value)}
									placeholder="spec-deployer"
									disabled={!entitled}
									autoComplete="off"
								/>
							</div>
							<div className="px-5 py-4">
								<p className="mb-3 text-[13px] font-medium text-text-primary">
									Permissions
								</p>
								<PermissionMatrix
									value={editPerms}
									onChange={entitled ? setEditPerms : undefined}
									readOnly={!entitled}
								/>
							</div>
							<div className="flex items-center justify-between gap-3 border-t border-border bg-surface-sunken px-5 py-3">
								<span className="font-mono text-[11px] text-text-tertiary">
									{editPerms.length} permission{editPerms.length === 1 ? "" : "s"}
								</span>
								<div className="flex items-center gap-2">
									{customSel && (
										<Button
											variant="outline"
											size="sm"
											disabled={!entitled}
											onClick={() => setDeleting(customSel)}
										>
											<Trash2 size={13} />
											Delete
										</Button>
									)}
									<Button
										size="sm"
										disabled={!entitled || saving || !editName.trim()}
										onClick={() =>
											isNew ? void saveNew() : customSel && void saveEdit(customSel.id)
										}
									>
										{saving ? "Saving…" : isNew ? "Create role" : "Save changes"}
									</Button>
								</div>
							</div>
						</div>
					) : (
						<div className="px-5 py-16 text-center text-[13px] text-text-tertiary">
							Select a role to view its permissions.
						</div>
					)}
				</div>
			</div>

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this role?</AlertDialogTitle>
						<AlertDialogDescription>
							Grants that reference this role are revoked. Members keep their built-in
							role. This cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => deleting && void confirmDelete(deleting)}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Delete role
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** Read-only detail for a built-in role: header + description + view-only matrix. */
function RoleDetail({
	title,
	badge,
	description,
	perms,
}: {
	title: string;
	badge: string;
	description: string;
	perms: string[];
}) {
	return (
		<div>
			<div className="border-b border-border px-5 py-4">
				<div className="flex items-center gap-2">
					<Shield size={15} className="text-text-tertiary" />
					<span className="text-[15px] font-semibold text-text-primary">{title}</span>
					<span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-text-secondary">
						{badge}
					</span>
				</div>
				<p className="mt-1.5 text-[12.5px] text-text-secondary">{description}</p>
			</div>
			<div className="px-5 py-4">
				<p className="mb-3 text-[13px] font-medium text-text-primary">
					Permissions{" "}
					<span className="font-mono text-[11px] font-normal text-text-tertiary">
						({perms.length})
					</span>
				</p>
				<PermissionMatrix value={perms} readOnly />
			</div>
		</div>
	);
}
