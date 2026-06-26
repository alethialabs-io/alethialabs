"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Usage page — everything the org consumes against its plan this billing period:
// Seats, Zones (stub), Provisioning/runner-minutes (real), plus the spend-control
// hard-cap. The AI section is a labeled seam: the AI-usage + credit-pack top-up
// component (built separately) drops in there. Subscription/payment lives on Billing.

import { Info } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useState,
	useTransition,
} from "react";
import { toast } from "sonner";
import {
	type BillingSummary,
	getBillingSummary,
	getOrgUsage,
	setUsageHardCap,
	type UsageReport,
} from "@/app/server/actions/billing";
import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import {
	SettingsPageHead,
	SettingsSection,
} from "@/components/settings/settings-ui";
import { Button } from "@repo/ui/button";
import { Card } from "@repo/ui/card";
import { Skeleton } from "@repo/ui/skeleton";

/** One usage meter cell (key, value, fill %, sub note). */
function Meter({
	label,
	value,
	sub,
	fill,
}: {
	label: string;
	value: ReactNode;
	sub: ReactNode;
	/** 0–100 fill percentage. */
	fill: number;
}) {
	return (
		<div className="border-r border-border px-6 py-4 last:border-r-0">
			<div className="mb-[9px] flex items-baseline justify-between">
				<span className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
					{label}
				</span>
				<span className="text-[12.5px] text-text-secondary">{value}</span>
			</div>
			<div className="h-[5px] overflow-hidden rounded-full border border-border bg-surface-sunken">
				<div
					className="h-full rounded-full bg-text-primary"
					style={{ width: `${fill}%` }}
				/>
			</div>
			<div className="mt-2 font-mono text-[10px] text-text-tertiary">{sub}</div>
		</div>
	);
}

export function UsagePanel() {
	const [summary, setSummary] = useState<BillingSummary | null>(null);
	const [usage, setUsage] = useState<UsageReport | null>(null);
	const [pending, startTransition] = useTransition();
	const [createOpen, setCreateOpen] = useState(false);

	const refresh = useCallback(() => {
		getBillingSummary()
			.then(setSummary)
			.catch(() => toast.error("Couldn't load usage."));
		getOrgUsage()
			.then(setUsage)
			.catch(() => {
				/* usage is best-effort; the meter just shows a dash */
			});
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);

	if (!summary) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-48 w-full" />
			</div>
		);
	}

	// Self-managed / community: no Stripe metering — usage is a hosted-billing concept.
	if (!summary.hosted) {
		return (
			<div>
				<SettingsPageHead title="Usage" description="Consumption against your plan." />
				<Card className="p-6">
					<h2 className="text-sm font-semibold text-foreground">
						Self-managed deployment
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						This instance isn&apos;t connected to hosted billing, so usage isn&apos;t
						metered here.
					</p>
				</Card>
			</div>
		);
	}

	// Free user with no org yet: usage is per-organization.
	if (!summary.hasOrg) {
		return (
			<div>
				<SettingsPageHead title="Usage" description="Consumption against your plan." />
				<Card className="p-6">
					<h2 className="text-sm font-semibold text-foreground">
						No organization yet
					</h2>
					<p className="mt-1 max-w-prose text-sm text-muted-foreground">
						Usage is metered per organization. Create one to track seats, runner
						minutes, and AI against a plan.
					</p>
					<Button className="mt-4" onClick={() => setCreateOpen(true)}>
						Create organization
					</Button>
				</Card>
				<CreateOrgSheet open={createOpen} onOpenChange={setCreateOpen} />
			</div>
		);
	}

	const seatFill =
		summary.seats != null && summary.seats > 0
			? Math.min(100, (summary.memberCount / summary.seats) * 100)
			: 100;

	return (
		<div>
			<SettingsPageHead
				title="Usage"
				description="What you've used this billing period across your plan."
			/>

			<SettingsSection title="This period">
				<div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
					<div className="grid grid-cols-1 sm:grid-cols-3">
						<Meter
							label="Seats"
							value={
								<>
									<b className="font-medium text-text-primary">
										{summary.memberCount}
									</b>
									{summary.seats != null ? ` / ${summary.seats}` : ""}
								</>
							}
							fill={seatFill}
							sub={
								summary.seats != null
									? `${Math.max(0, summary.seats - summary.memberCount)} seats available`
									: "members in this organization"
							}
						/>
						<Meter
							label="Zones"
							value={<b className="font-medium text-text-primary">—</b>}
							fill={0}
							sub="usage metering coming soon"
						/>
						<Meter
							label="Provisioning minutes"
							value={
								usage ? (
									<>
										<b className="font-medium text-text-primary">
											{Math.round(usage.usedMinutes)}
										</b>
										{` / ${usage.includedMinutes}`}
									</>
								) : (
									<b className="font-medium text-text-primary">—</b>
								)
							}
							fill={usage ? Math.min(100, usage.pct * 100) : 0}
							sub={
								!usage
									? "managed runner usage this period"
									: usage.overLimit
										? `${Math.round(usage.overageMinutes)} min over included · ~$${usage.overageCost.toFixed(2)} overage`
										: usage.approaching
											? `${Math.round(usage.pct * 100)}% used — approaching your included minutes`
											: `${Math.round(usage.pct * 100)}% of included used · self-hosted runners are free`
							}
						/>
					</div>

					{/* Spend control: pause at the included allowance instead of overage. */}
					{usage && usage.plan !== "community" && (
						<label className="flex cursor-pointer items-center gap-2 border-t border-border px-6 py-3 text-[12px] text-text-tertiary">
							<input
								type="checkbox"
								className="accent-ink"
								checked={usage.hardCap}
								disabled={pending}
								onChange={(e) => {
									const next = e.target.checked;
									setUsage((u) => (u ? { ...u, hardCap: next } : u));
									startTransition(async () => {
										try {
											await setUsageHardCap(next);
										} catch {
											toast.error("Couldn't update the usage cap.");
											setUsage((u) => (u ? { ...u, hardCap: !next } : u));
										}
									});
								}}
							/>
							Pause new jobs at my included minutes instead of billing overage
						</label>
					)}

					<div className="flex items-center gap-2 border-t border-border bg-surface-sunken px-6 py-[14px] text-[12px] text-text-tertiary">
						<Info size={13} />
						Your cloud-resource spend is billed separately by your provider.
					</div>
				</div>
			</SettingsSection>

			{/* AI usage seam — the AI consumption + credit-pack top-up component drops in
			    here once the AI-billing work lands. Until then, a placeholder. */}
			<SettingsSection title="AI usage">
				<Card className="flex flex-wrap items-center justify-between gap-4 border-dashed p-6">
					<div>
						<p className="text-[13px] font-medium text-text-primary">
							AI usage &amp; credits
						</p>
						<p className="mt-1 max-w-prose text-[12.5px] text-text-tertiary">
							Track AI credits used this window and top up with credit packs. Arrives
							with the AI assistant metering.
						</p>
					</div>
					<Button variant="outline" size="sm" disabled>
						Coming soon
					</Button>
				</Card>
			</SettingsSection>
		</div>
	);
}
