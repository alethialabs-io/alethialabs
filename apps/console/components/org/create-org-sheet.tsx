"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Create organization" slide-over — a faithful implementation of the authored
// claude.ai/design sheet (2-column: details/plan/team + a live order-summary rail),
// tailored to our stack: our real Stripe prices (Team per-seat, Business/Enterprise
// flat), Community = a free org, paid = the in-app Payment Element. Styling is ported
// to create-org-sheet.module.css against our shared Alethia tokens.

import { ArrowRight, Check, Info, Plus, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { createSubscriptionIntent } from "@/app/server/actions/billing";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { authClient } from "@/lib/auth/client";
import { planMeta } from "@/lib/billing/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { cn } from "@/lib/utils";
import styles from "./create-org-sheet.module.css";

type Role = "admin" | "operator" | "viewer";
interface Invite {
	email: string;
	role: Role;
}

const REGIONS = [
	{ value: "eu-west-1", label: "eu-west-1 · Frankfurt" },
	{ value: "eu-north-1", label: "eu-north-1 · Stockholm" },
	{ value: "us-east-1", label: "us-east-1 · N. Virginia" },
	{ value: "ap-southeast-1", label: "ap-southeast-1 · Singapore" },
];

// Card presentation. Feature bullets come from the enriched PLAN_CATALOG highlights;
// price/billed/audience are card-specific. Prices are our real wired Stripe prices.
const CARDS: {
	id: BillingPlan;
	who: string;
	price: string;
	per: string | null;
	custom?: boolean;
	billed: string;
	recommended?: boolean;
}[] = [
	{
		id: "community",
		who: "Solo, homelab & self-hosters who own their stack",
		price: "Free",
		per: null,
		billed: "AGPL · self-hosted",
	},
	{
		id: "team",
		who: "Small teams that want a shared, hosted control plane",
		price: "$29",
		per: "/seat·mo",
		billed: "Hosted · billed per seat",
	},
	{
		id: "business",
		who: "Growing orgs that need roles, teams & audit",
		price: "$999",
		per: "/mo",
		billed: "Hosted · billed monthly",
		recommended: true,
	},
	{
		id: "enterprise",
		who: "Regulated & large teams needing SSO, audit & SLA",
		price: "From $2,500",
		per: null,
		custom: true,
		billed: "Annual contract · self-managed option",
	},
];

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "OR";
	return ((parts[0][0] ?? "") + (parts[1] ? parts[1][0] : (parts[0][1] ?? "")))
		.toUpperCase()
		.padEnd(2, parts[0][0]?.toUpperCase() ?? "R");
}
function slugify(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}
function money(n: number): string {
	return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** A slug + short suffix to avoid collisions on the unique org slug. */
function uniqueSlug(slug: string): string {
	return `${slug || "org"}-${Math.random().toString(36).slice(2, 7)}`;
}

interface CreateOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateOrgSheet({ open, onOpenChange }: CreateOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);

	const [step, setStep] = useState<"details" | "payment">("details");
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [slugTouched, setSlugTouched] = useState(false);
	const [region, setRegion] = useState(REGIONS[0].value);
	const [billingEmail, setBillingEmail] = useState("");
	const [plan, setPlan] = useState<BillingPlan>("business");
	const [invites, setInvites] = useState<Invite[]>([]);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");
	const [busy, setBusy] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);

	const effSlug = slug || "org";
	const seats = 1 + invites.length;
	const meta = planMeta(plan);

	// Rail cost for the selected plan.
	const monthly =
		plan === "community"
			? 0
			: plan === "team"
				? seats * 29
				: plan === "business"
					? 999
					: -1; // enterprise = custom

	const totalLabel =
		plan === "community" ? "Free" : monthly < 0 ? "Custom" : `$${monthly}`;
	const totalSub =
		plan === "community"
			? "self-hosted · AGPL"
			: monthly < 0
				? "annual contract · contact sales"
				: "per month · excl. tax";
	const ctaLabel = plan === "enterprise" ? "Contact sales" : "Create organization";

	function reset() {
		setStep("details");
		setName("");
		setSlug("");
		setSlugTouched(false);
		setRegion(REGIONS[0].value);
		setBillingEmail("");
		setPlan("business");
		setInvites([]);
		setInviteEmail("");
		setInviteRole("operator");
		setBusy(false);
		setClientSecret(null);
		setCreatedOrgId(null);
	}
	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	function onNameChange(v: string) {
		setName(v);
		if (!slugTouched) setSlug(slugify(v));
	}

	function addInvite() {
		const email = inviteEmail.trim();
		if (!email) return;
		setInvites((prev) => [...prev, { email, role: inviteRole }]);
		setInviteEmail("");
	}

	/** Create the org; for paid plans open the in-app payment step. */
	async function handleCreate() {
		if (name.trim().length < 2) {
			toast.error("Give your organization a name.");
			return;
		}
		if (plan === "enterprise") {
			window.location.href =
				"mailto:sales@alethialabs.io?subject=Alethia%20Enterprise";
			return;
		}

		setBusy(true);
		try {
			let orgId = createdOrgId;
			if (!orgId) {
				const { data, error } = await authClient.organization.create({
					name: name.trim(),
					slug: uniqueSlug(slug),
					metadata: { region },
				});
				if (error || !data) {
					throw new Error(error?.message ?? "Couldn't create the organization");
				}
				orgId = data.id;
				setCreatedOrgId(orgId);
				await setActiveOrganization(orgId);
				await fetchWorkspace();
			}

			if (plan === "community") {
				// Free org — no payment.
				toast.success("Organization created.");
				finishAndClose();
				return;
			}

			const intent = await createSubscriptionIntent(plan, {
				seats: plan === "team" ? seats : undefined,
				billingEmail: billingEmail.trim() || undefined,
			});
			setClientSecret(intent.clientSecret);
			setStep("payment");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	function finishAndClose() {
		fetchWorkspace();
		handleOpenChange(false);
		router.refresh();
	}

	/** After payment: send the collected invites (best-effort), then close. */
	async function handlePaid() {
		toast.success("Subscription active — your organization is ready.");
		for (const inv of invites) {
			try {
				await authClient.organization.inviteMember({
					email: inv.email,
					role: inv.role,
				});
			} catch {
				toast.error(`Couldn't invite ${inv.email} — do it from Members.`);
			}
		}
		finishAndClose();
	}

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[86vw] gap-0 p-0 sm:max-w-[1112px]"
			>
				<SheetTitle className="sr-only">Create organization</SheetTitle>
				<SheetDescription className="sr-only">
					Set up a new organization, choose a plan, and invite your team.
				</SheetDescription>

				{step === "details" ? (
					<div className={styles.layout}>
						{/* ===== header ===== */}
						<div className={styles.head}>
							<div className={styles.titles}>
								<p className={styles.eyebrow}>New organization</p>
								<h1>Create organization</h1>
								<p className={styles.sub}>
									An organization groups your Zones, Specs, and team under shared
									billing, roles, and audit. You can change your plan anytime.
								</p>
								<div className={styles.steps}>
									<div className={cn(styles.step, styles.active)}>
										<span className={styles.dot}>01</span>
										<span className={styles.lbl}>Details</span>
									</div>
									<span className={styles.bar} />
									<div className={styles.step}>
										<span className={styles.dot}>02</span>
										<span className={styles.lbl}>Plan</span>
									</div>
									<span className={styles.bar} />
									<div className={styles.step}>
										<span className={styles.dot}>03</span>
										<span className={styles.lbl}>Team</span>
									</div>
								</div>
							</div>
							<button
								type="button"
								className={styles.xBtn}
								aria-label="Close"
								onClick={() => handleOpenChange(false)}
							>
								<X size={15} />
							</button>
						</div>

						{/* ===== main column ===== */}
						<div className={styles.body}>
							{/* 01 · Details */}
							<section className={styles.block}>
								<div className={styles.blockHead}>
									<span className={styles.num}>01</span>
									<h2>Organization details</h2>
									<span className={styles.rule} />
								</div>
								<div className={styles.detailsGrid}>
									<div className={styles.monogramRow}>
										<div className={styles.monogram}>{initials(name)}</div>
										<div className={styles.mhint}>
											<span className={styles.t}>
												Avatar generated from the organization name.
											</span>
											<span className={styles.u}>
												Square · replaceable after setup
											</span>
										</div>
									</div>

									<div className={styles.field}>
											<label>
											Organization name <span className={styles.req}>required</span>
										</label>
										<input
											className={styles.control}
											value={name}
											onChange={(e) => onNameChange(e.target.value)}
											placeholder="Acme Cloud"
											autoComplete="off"
										/>
									</div>

									<div className={styles.field}>
											<label>Organization URL</label>
										<input
											className={cn(styles.control, styles.mono)}
											style={{ fontSize: "12.5px" }}
											value={slug}
											onChange={(e) => {
												setSlugTouched(true);
												setSlug(slugify(e.target.value));
											}}
											placeholder="acme-cloud"
											autoComplete="off"
										/>
										<span className={styles.urlPreview}>
											console.alethialabs.io/<b>{effSlug}</b>
										</span>
									</div>

									<div className={styles.field}>
											<label>
											Data region <span className={styles.req}>residency</span>
										</label>
										<select
											className={cn(styles.control, styles.mono)}
											style={{ fontSize: "12.5px" }}
											value={region}
											onChange={(e) => setRegion(e.target.value)}
										>
											{REGIONS.map((r) => (
												<option key={r.value} value={r.value}>
													{r.label}
												</option>
											))}
										</select>
									</div>

									<div className={styles.field}>
											<label>Billing email</label>
										<input
											className={styles.control}
											style={{ fontSize: "12.5px" }}
											value={billingEmail}
											onChange={(e) => setBillingEmail(e.target.value)}
											placeholder="billing@acme.cloud"
											autoComplete="off"
										/>
									</div>
								</div>
							</section>

							{/* 02 · Plan */}
							<section className={styles.block}>
								<div className={styles.blockHead}>
									<span className={styles.num}>02</span>
									<h2>Choose a plan</h2>
									<span className={styles.rule} />
								</div>

								<div className={styles.plans}>
									{CARDS.map((card) => {
										const sel = card.id === plan;
										return (
											<button
												type="button"
												key={card.id}
												className={cn(styles.plan, sel && styles.sel)}
												onClick={() => setPlan(card.id)}
											>
												{card.recommended && (
													<span className={styles.rec}>Recommended</span>
												)}
												<div className={styles.planTop}>
													<span className={styles.planName}>
														{planMeta(card.id).name}
													</span>
													<span className={styles.check}>
														<Check size={11} strokeWidth={3} />
													</span>
												</div>
												<p className={styles.who}>{card.who}</p>
												<div className={styles.price}>
													{card.custom ? (
														<span className={styles.custom}>{card.price}</span>
													) : (
														<>
															<span className={styles.amt}>{card.price}</span>
															{card.per && (
																<span className={styles.per}>{card.per}</span>
															)}
														</>
													)}
												</div>
												<div className={styles.billed}>{card.billed}</div>
												<div className={styles.sep} />
												<ul className={styles.feats}>
													{planMeta(card.id).highlights.map((f) => (
														<li key={f}>
															<Check size={12} strokeWidth={2.4} />
															<span>{f}</span>
														</li>
													))}
												</ul>
											</button>
										);
									})}
								</div>

								<p className={styles.planNote}>
									<Info size={13} />
									Add-ons billed as used — runner-minutes beyond plan and AI
									repo-scans are metered. The customer&apos;s cloud spend is
									always billed by their own provider.
								</p>
							</section>

							{/* 03 · Team */}
							<section className={styles.block} style={{ marginBottom: 8 }}>
								<div className={styles.blockHead}>
									<span className={styles.num}>03</span>
									<h2>Invite your team</h2>
									<span className={styles.rule} />
									<span className={styles.opt}>optional</span>
								</div>

								<div className={styles.inviteInput}>
									<input
										className={styles.control}
										placeholder="name@company.com"
										autoComplete="off"
										value={inviteEmail}
										onChange={(e) => setInviteEmail(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addInvite();
											}
										}}
									/>
									<select
										className={cn(styles.control, styles.roleSelect, styles.mono)}
										style={{ fontSize: "12px" }}
										value={inviteRole}
										onChange={(e) => setInviteRole(e.target.value as Role)}
									>
										<option value="admin">Admin</option>
										<option value="operator">Operator</option>
										<option value="viewer">Viewer</option>
									</select>
									<button
										type="button"
										className={styles.addBtn}
										onClick={addInvite}
									>
										<Plus size={14} />
										Invite
									</button>
								</div>

								<div className={styles.seatList}>
									<div className={styles.seat}>
										<span className={styles.av}>YO</span>
										<div className={styles.who2}>
											<span className={styles.em}>You</span>
											<span className={styles.mt}>Organization creator</span>
										</div>
										<span className={styles.you}>Owner</span>
									</div>
									{invites.map((inv, i) => (
										<div className={styles.seat} key={`${inv.email}-${i}`}>
											<span className={styles.av}>
												{inv.email.slice(0, 2).toUpperCase()}
											</span>
											<div className={styles.who2}>
												<span className={styles.em}>{inv.email}</span>
												<span className={styles.mt}>Invited · pending</span>
											</div>
											<select
												className={cn(
													styles.control,
													styles.seatRole,
													styles.mono,
												)}
												value={inv.role}
												onChange={(e) =>
													setInvites((prev) =>
														prev.map((p, j) =>
															j === i
																? { ...p, role: e.target.value as Role }
																: p,
														),
													)
												}
											>
												<option value="admin">Admin</option>
												<option value="operator">Operator</option>
												<option value="viewer">Viewer</option>
											</select>
											<button
												type="button"
												className={styles.rm}
												aria-label="Remove"
												onClick={() =>
													setInvites((prev) => prev.filter((_, j) => j !== i))
												}
											>
												<X size={15} />
											</button>
										</div>
									))}
								</div>
								<p className={styles.seatNote}>
									<Users size={13} />
									<span>
										<b style={{ color: "var(--text-secondary)", fontWeight: 500 }}>
											{seats}
										</b>{" "}
										seat{seats === 1 ? "" : "s"}
										{plan === "team" ? " · billed per seat" : ""}.
									</span>
								</p>
							</section>
						</div>

						{/* ===== summary rail ===== */}
						<aside className={styles.rail}>
							<div className={styles.railScroll}>
								<p className={styles.eyebrow}>Order summary</p>

								<div className={styles.railOrg}>
									<div className={styles.mg}>{initials(name)}</div>
									<div className={styles.meta}>
										<span className={styles.nm}>{name || "Untitled"}</span>
										<span className={styles.sl}>
											console.alethialabs.io/{effSlug}
										</span>
									</div>
								</div>

								<div className={styles.railLine}>
									<span className={styles.k}>Plan</span>
									<span className={cn(styles.v, styles.strong)}>{meta.name}</span>
								</div>
								<div className={styles.railLine}>
									<span className={styles.k}>Region</span>
									<span className={styles.v}>{region}</span>
								</div>
								<div className={styles.railLine}>
									<span className={styles.k}>Seats</span>
									<span className={styles.v}>{seats}</span>
								</div>

								<div className={styles.railSep} />

								<div className={styles.railCost}>
									<div className={styles.costRow}>
										<span className={styles.k}>
											{plan === "team"
												? `Team · $29 × ${seats}`
												: `${meta.name} plan`}
										</span>
										<span className={styles.v}>
											{monthly < 0 ? "custom" : money(Math.max(0, monthly))}
										</span>
									</div>
									<div className={styles.costRow}>
										<span className={styles.k}>Runner-minutes</span>
										<span className={styles.v}>metered</span>
									</div>
									<div className={styles.costTotal}>
										<span className={styles.k}>Due today</span>
										<span className={styles.vwrap}>
											<span className={styles.v}>{totalLabel}</span>
											<div className={styles.vsub}>{totalSub}</div>
										</span>
									</div>
								</div>
							</div>

							<div className={styles.railFoot}>
								<button
									type="button"
									className={styles.btnPrimary}
									disabled={busy}
									onClick={handleCreate}
								>
									<span>{busy ? "Setting up…" : ctaLabel}</span>
									<ArrowRight size={15} />
								</button>
								<button
									type="button"
									className={styles.btnGhost}
									onClick={() => handleOpenChange(false)}
								>
									Cancel
								</button>
								<p className={styles.fineprint}>
									Provisions an isolated org with coarse{" "}
									<span className={styles.mono}>org_id</span> tenancy. No charge
									until you confirm.
								</p>
							</div>
						</aside>
					</div>
				) : (
					/* ===== payment step ===== */
					<div className={styles.payWrap}>
						<button
							type="button"
							className={styles.payBack}
							onClick={() => {
								setStep("details");
								setClientSecret(null);
							}}
						>
							← Back
						</button>
						<div className={styles.payRecap}>
							<span className={styles.pk}>{meta.name} plan</span>
							<span className={styles.pv}>{totalLabel}</span>
						</div>
						{clientSecret && (
							<StripeElementsProvider clientSecret={clientSecret}>
								<PaymentForm
									mode="payment"
									submitLabel={`Subscribe — ${totalLabel}`}
									onSuccess={handlePaid}
								/>
							</StripeElementsProvider>
						)}
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
