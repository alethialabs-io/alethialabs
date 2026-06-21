"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · General — a faithful port of the authored claude.ai/design panel
// (Organization profile / Defaults / Danger zone), wired to our stack: name + slug via
// better-auth organization.update; description/region/default-env/terraform-version in
// org metadata; delete is real. Logo upload + ownership transfer are stubbed (noted).

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	getOrgSettings,
	type OrgSettings,
} from "@/app/server/actions/org-settings";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth/client";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import styles from "@/components/settings/settings-design.module.css";

const REGIONS = [
	"eu-west-1 · Frankfurt",
	"eu-north-1 · Stockholm",
	"us-east-1 · N. Virginia",
	"ap-southeast-1 · Singapore",
];
const ENVS = ["staging", "development", "production"];

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "OR";
	return ((parts[0][0] ?? "") + (parts[1]?.[0] ?? parts[0][1] ?? "")).toUpperCase();
}
function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function OrgGeneral() {
	const router = useRouter();
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);
	const [s, setS] = useState<OrgSettings | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		getOrgSettings()
			.then(setS)
			.catch(() => toast.error("Couldn't load organization settings."));
	}, []);

	function set<K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) {
		setS((prev) => (prev ? { ...prev, [key]: value } : prev));
	}

	async function save() {
		if (!s || !activeOrgId) return;
		setSaving(true);
		try {
			const { error } = await authClient.organization.update({
				organizationId: activeOrgId,
				data: {
					name: s.name,
					slug: s.slug,
					metadata: {
						description: s.description,
						region: s.region,
						defaultEnv: s.defaultEnv,
						terraformVersion: s.terraformVersion,
					},
				},
			});
			if (error) throw new Error(error.message ?? "Save failed");
			toast.success("Organization updated.");
			await fetchWorkspace();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save changes.");
		} finally {
			setSaving(false);
		}
	}

	async function remove() {
		if (!activeOrgId) return;
		const { error } = await authClient.organization.delete({
			organizationId: activeOrgId,
		});
		if (error) {
			toast.error(error.message ?? "Couldn't delete the organization");
			return;
		}
		await fetchWorkspace();
		router.push("/dashboard");
	}

	if (!s) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-48 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	return (
		<div>
			<div className={styles.pageHead}>
				<span className="vx-eyebrow">General</span>
				<h1>General</h1>
				<p>
					Your organization&apos;s identity and defaults. These apply across every
					Zone, Spec, and team in{" "}
					<b style={{ color: "var(--text-primary)", fontWeight: 500 }}>{s.name}</b>.
				</p>
			</div>

			{/* Organization profile */}
			<div className={styles.block}>
				<div className={styles.blockHead}>
					<h2>Organization profile</h2>
					<span className={styles.rule} />
				</div>
				<div className={styles.card}>
					<div className={styles.form}>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Logo</span>
								<span className={styles.h}>
									A square avatar, generated from the name until you upload one.
								</span>
							</div>
							<div className={styles.ctl}>
								<div className={styles.avatarRow}>
									<div className={styles.avatarLg}>{initials(s.name)}</div>
									<button
										type="button"
										className={`${styles.btn} ${styles.sm}`}
										onClick={() => toast.info("Logo upload is coming soon.")}
									>
										Upload image
									</button>
									<button
										type="button"
										className={`${styles.btn} ${styles.sm} ${styles.ghost}`}
										disabled
									>
										Remove
									</button>
								</div>
							</div>
						</div>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Organization name</span>
								<span className={styles.h}>
									Shown across the console and in invitations.
								</span>
							</div>
							<div className={styles.ctl}>
								<input
									className={styles.control}
									value={s.name}
									onChange={(e) => set("name", e.target.value)}
									autoComplete="off"
								/>
							</div>
						</div>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Organization URL</span>
								<span className={styles.h}>
									The slug for your org&apos;s console workspace.
								</span>
							</div>
							<div className={styles.ctl}>
								<div className={styles.urlRow}>
									<span className={styles.pre}>console.alethialabs.io/</span>
									<input
										value={s.slug}
										onChange={(e) => set("slug", slugify(e.target.value))}
										autoComplete="off"
									/>
								</div>
								<span className={styles.hint}>Lowercase, numbers and hyphens.</span>
							</div>
						</div>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Description</span>
								<span className={styles.h}>
									Optional. A short line for teammates and audit context.
								</span>
							</div>
							<div className={styles.ctl}>
								<textarea
									className={styles.control}
									placeholder="What does this organization manage?"
									value={s.description}
									onChange={(e) => set("description", e.target.value)}
								/>
							</div>
						</div>
					</div>
					<div className={styles.cardFoot}>
						<span className={styles.note}>Applies across the console</span>
						<button
							type="button"
							className={`${styles.btn} ${styles.primary}`}
							disabled={saving}
							onClick={save}
						>
							{saving ? "Saving…" : "Save changes"}
						</button>
					</div>
				</div>
			</div>

			{/* Defaults */}
			<div className={styles.block}>
				<div className={styles.blockHead}>
					<h2>Defaults</h2>
					<span className={styles.rule} />
				</div>
				<div className={styles.card}>
					<div className={styles.form}>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Data region</span>
								<span className={styles.h}>
									Residency for the control plane and Spec state.
								</span>
							</div>
							<div className={styles.ctl}>
								<select
									className={`${styles.control} ${styles.mono}`}
									style={{ fontSize: "12.5px" }}
									value={s.region}
									onChange={(e) => set("region", e.target.value)}
								>
									{REGIONS.map((r) => (
										<option key={r} value={r.split(" ")[0]}>
											{r}
										</option>
									))}
								</select>
								<span className={styles.hint}>
									Region migration requires a support request.
								</span>
							</div>
						</div>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Default Spec environment</span>
								<span className={styles.h}>
									Pre-selected stage for newly planted Specs.
								</span>
							</div>
							<div className={styles.ctl}>
								<select
									className={`${styles.control} ${styles.mono}`}
									style={{ fontSize: "12.5px" }}
									value={s.defaultEnv}
									onChange={(e) => set("defaultEnv", e.target.value)}
								>
									{ENVS.map((en) => (
										<option key={en} value={en}>
											{en}
										</option>
									))}
								</select>
							</div>
						</div>
						<div className={styles.row}>
							<div className={styles.lab}>
								<span className={styles.t}>Terraform version</span>
								<span className={styles.h}>
									Pinned across runners unless a Spec overrides it.
								</span>
							</div>
							<div className={styles.ctl}>
								<input
									className={`${styles.control} ${styles.mono}`}
									style={{ fontSize: "12.5px" }}
									value={s.terraformVersion}
									onChange={(e) => set("terraformVersion", e.target.value)}
								/>
							</div>
						</div>
					</div>
					<div className={styles.cardFoot}>
						<span className={styles.note}>Applies to new resources only</span>
						<button
							type="button"
							className={`${styles.btn} ${styles.primary}`}
							disabled={saving}
							onClick={save}
						>
							{saving ? "Saving…" : "Save changes"}
						</button>
					</div>
				</div>
			</div>

			{/* Danger zone */}
			<div className={styles.block} style={{ marginBottom: 0 }}>
				<div className={styles.blockHead}>
					<h2>Danger zone</h2>
					<span className={styles.rule} />
				</div>
				<div className={`${styles.card} ${styles.danger}`}>
					<div className={styles.drow}>
						<div>
							<div className={styles.t}>Transfer ownership</div>
							<div className={styles.h}>
								Move this organization to another owner. They take over billing
								and the Owner role.
							</div>
						</div>
						<button
							type="button"
							className={`${styles.btn} ${styles.outlineDanger} ${styles.sm}`}
							onClick={() => toast.info("Ownership transfer is coming soon.")}
						>
							Transfer
						</button>
					</div>
					<div className={styles.drow}>
						<div>
							<div className={styles.t}>Delete organization</div>
							<div className={styles.h}>
								Permanently delete {s.name} and all its Specs. This destroys no
								cloud resources — run destroy first. Cannot be undone.
							</div>
						</div>
						<AlertDialog>
							<AlertDialogTrigger asChild>
								<button
									type="button"
									className={`${styles.btn} ${styles.outlineDanger} ${styles.sm}`}
								>
									Delete
								</button>
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Delete this organization?</AlertDialogTitle>
									<AlertDialogDescription>
										This permanently deletes the organization, its members, and
										its access grants. This cannot be undone.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => void remove()}
										className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
									>
										Delete organization
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				</div>
			</div>
		</div>
	);
}
