"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Create organization" slide-over — a 2-column form (details / plan / team) + a live
// order-summary rail, then an embedded payment step. Composed from shadcn/ui + Tailwind
// tokens (no CSS module). react-hook-form + zod validation. Community = a free org; paid
// = the in-app Payment + Address Element (Stripe Tax computes VAT from the address).
// Address/VAT/cards are managed later in the Stripe Customer Portal.

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Check, Info, Plus, Users, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	createNewOrgSubscriptionIntent,
	isOrgSlugAvailable,
	linkSubscriptionToNewOrg,
} from "@/app/server/actions/billing";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@repo/ui/sheet";
import { authClient } from "@/lib/auth/client";
import { planMeta } from "@repo/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";
import { cn } from "@repo/ui/utils";

const ROLES = ["admin", "operator", "viewer"] as const;
type Role = (typeof ROLES)[number];
interface Invite {
	email: string;
	role: Role;
}

const schema = z.object({
	name: z.string().trim().min(2, "Give your organization a name."),
	slug: z
		.string()
		.trim()
		.min(1, "Pick a slug.")
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and hyphens."),
});
type FormData = z.infer<typeof schema>;

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
		recommended: true,
	},
	{
		id: "enterprise",
		who: "Regulated & large teams needing SSO, audit & SLA",
		price: "Let's talk",
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

/** A compact role <select> on the shadcn Select primitive. */
function RoleField({
	value,
	onChange,
	className,
}: {
	value: Role;
	onChange: (role: Role) => void;
	className?: string;
}) {
	return (
		<Select value={value} onValueChange={(v) => onChange(v as Role)}>
			<SelectTrigger size="sm" aria-label="Role" className={cn("capitalize", className)}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ROLES.map((r) => (
					<SelectItem key={r} value={r} className="capitalize">
						{r}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

interface CreateOrgSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateOrgSheet({ open, onOpenChange }: CreateOrgSheetProps) {
	const router = useRouter();
	const fetchWorkspace = useWorkspaceStore((s) => s.fetchWorkspace);

	const form = useForm<FormData>({
		resolver: zodResolver(schema),
		defaultValues: { name: "", slug: "" },
		mode: "onChange",
	});
	const name = form.watch("name");
	const slug = form.watch("slug");

	const [slugTouched, setSlugTouched] = useState(false);
	const [step, setStep] = useState<"details" | "payment">("details");
	const [plan, setPlan] = useState<BillingPlan>("team");
	const [invites, setInvites] = useState<Invite[]>([]);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");
	const [busy, setBusy] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);
	const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);
	const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
	const [customerId, setCustomerId] = useState<string | null>(null);
	// Set when payment succeeded but org create / link / invites then failed — the org
	// isn't set up yet but the customer HAS paid, so we offer a retry (no second charge)
	// instead of the payment form.
	const [needsSetupRetry, setNeedsSetupRetry] = useState(false);

	const effSlug = slug || "org";
	const seats = 1 + invites.length;
	const meta = planMeta(plan);

	const monthly =
		plan === "community" ? 0 : plan === "team" ? seats * 29 : -1;
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
		form.reset({ name: "", slug: "" });
		setSlugTouched(false);
		setStep("details");
		setPlan("team");
		setInvites([]);
		setInviteEmail("");
		setInviteRole("operator");
		setBusy(false);
		setClientSecret(null);
		setCreatedOrgId(null);
		setSubscriptionId(null);
		setCustomerId(null);
		setNeedsSetupRetry(false);
	}
	function handleOpenChange(next: boolean) {
		if (!next) reset();
		onOpenChange(next);
	}

	function addInvite() {
		const email = inviteEmail.trim();
		if (!z.string().email().safeParse(email).success) {
			toast.error("Enter a valid email to invite.");
			return;
		}
		setInvites((prev) => [...prev, { email, role: inviteRole }]);
		setInviteEmail("");
	}

	/**
	 * Community: create the org now (it's free). Paid: nothing is persisted yet — we
	 * validate the slug, open a subscription intent for an org that doesn't exist, and
	 * move to payment. The org is only created once the charge succeeds (handlePaid), so
	 * a Stripe failure here can never leave an orphan org behind.
	 */
	async function onCreate(data: FormData) {
		setBusy(true);
		try {
			if (plan === "community") {
				const { data: org, error } = await authClient.organization.create({
					name: data.name,
					slug: data.slug,
				});
				if (error || !org) {
					if (/slug|unique|exist|taken/i.test(error?.message ?? "")) {
						form.setError("slug", { message: "That slug is taken — try another." });
						return;
					}
					throw new Error(error?.message ?? "Couldn't create the organization");
				}
				await setActiveOrganization(org.id);
				await fetchWorkspace();
				toast.success("Organization created.");
				finishAndClose();
				return;
			}
			if (plan === "enterprise") {
				contactSales();
				return;
			}

			// Paid (team): make sure the slug is free BEFORE charging, so a collision
			// surfaces inline rather than after the customer has paid.
			if (!(await isOrgSlugAvailable(data.slug))) {
				form.setError("slug", { message: "That slug is taken — try another." });
				return;
			}

			// Reuse the customer / replace the prior incomplete sub on a Back→retry or a
			// seat change, so neither piles up in Stripe.
			const intent = await createNewOrgSubscriptionIntent(plan, {
				seats,
				orgName: data.name,
				priorSubscriptionId: subscriptionId ?? undefined,
				customerId: customerId ?? undefined,
			});
			setSubscriptionId(intent.subscriptionId);
			setCustomerId(intent.customerId);
			setClientSecret(intent.clientSecret);
			setStep("payment");
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Something went wrong");
		} finally {
			setBusy(false);
		}
	}

	function contactSales() {
		window.location.href = "mailto:sales@alethialabs.io?subject=Alethia%20Enterprise";
	}

	function finishAndClose() {
		fetchWorkspace();
		handleOpenChange(false);
		router.refresh();
	}

	/**
	 * Payment has succeeded — now do the deferred setup: create the org, link the paid
	 * subscription to it (which writes the billing record synchronously, so the
	 * `organizations` entitlement is live immediately — no webhook race), then send the
	 * queued invites. Idempotent on retry via `createdOrgId`: if any step fails after the
	 * charge, we keep the payment refs and offer a retry rather than re-charging.
	 */
	async function handlePaid() {
		setBusy(true);
		setNeedsSetupRetry(false);
		try {
			if (!subscriptionId || !customerId) {
				throw new Error("Missing payment reference — please retry.");
			}

			let orgId = createdOrgId;
			if (!orgId) {
				const values = form.getValues();
				const { data: org, error } = await authClient.organization.create({
					name: values.name,
					slug: values.slug,
				});
				if (error || !org) {
					throw new Error(error?.message ?? "Couldn't create the organization");
				}
				orgId = org.id;
				setCreatedOrgId(orgId);
				await setActiveOrganization(orgId);
			}

			await linkSubscriptionToNewOrg({ orgId, subscriptionId, customerId });
			await fetchWorkspace();
			toast.success("Subscription active — your organization is ready.");

			// Entitlement is already active — send queued invites and report any misses once.
			const failed: string[] = [];
			for (const inv of invites) {
				try {
					await authClient.organization.inviteMember({
						email: inv.email,
						role: inv.role,
					});
				} catch {
					failed.push(inv.email);
				}
			}
			if (failed.length > 0) {
				toast.error(
					`Couldn't invite ${failed.join(", ")} — finish from the Members page.`,
				);
			}
			finishAndClose();
		} catch (e) {
			// Payment went through but setup didn't — let the user retry without re-paying.
			setNeedsSetupRetry(true);
			toast.error(
				e instanceof Error
					? e.message
					: "Payment succeeded but setup failed — retry, you won't be charged again.",
			);
		} finally {
			setBusy(false);
		}
	}

	const submit = form.handleSubmit(onCreate);

	return (
		<Sheet open={open} onOpenChange={handleOpenChange}>
			<SheetContent
				side="right"
				showCloseButton={false}
				className="w-[92vw] gap-0 p-0 sm:max-w-[1112px]"
			>
				<SheetTitle className="sr-only">Create organization</SheetTitle>
				<SheetDescription className="sr-only">
					Set up a new organization, choose a plan, and invite your team.
				</SheetDescription>

				{step === "details" ? (
					<div className="flex h-full flex-col">
						{/* header + stepper */}
						<div className="flex items-start justify-between gap-4 border-b border-border px-7 py-5">
							<div>
								<span className="vx-eyebrow">New organization</span>
								<h1 className="mt-1.5 font-display text-[22px] font-semibold tracking-[-0.02em] text-text-primary">
									Create organization
								</h1>
								<p className="mt-1 max-w-prose text-[12.5px] text-text-tertiary">
									An organization groups your Zones, Specs, and team under shared billing,
									roles, and audit. You can change your plan anytime.
								</p>
								<Stepper />
							</div>
							<button
								type="button"
								aria-label="Close"
								onClick={() => handleOpenChange(false)}
								className="rounded-sm p-1.5 text-text-tertiary transition-colors hover:bg-surface-muted hover:text-text-primary"
							>
								<X size={15} />
							</button>
						</div>

						{/* body + rail */}
						<div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_344px]">
							{/* main column */}
							<form
								onSubmit={submit}
								className="space-y-7 overflow-y-auto px-7 py-6"
							>
								{/* 01 Details */}
								<Block num="01" title="Organization details">
									<div className="flex items-center gap-4">
										<div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-[18px] font-semibold text-ink-foreground">
											{initials(name)}
										</div>
										<div className="text-[11.5px] text-text-tertiary">
											<div className="text-text-secondary">
												Avatar generated from the organization name.
											</div>
											<div>Square · replaceable after setup</div>
										</div>
									</div>

									<Field
										label="Organization name"
										required
										error={form.formState.errors.name?.message}
									>
										<Input
											placeholder="Acme Cloud"
											autoComplete="off"
											{...form.register("name")}
											onChange={(e) => {
												const v = e.target.value;
												form.setValue("name", v, { shouldValidate: true });
												if (!slugTouched)
													form.setValue("slug", slugify(v), { shouldValidate: true });
											}}
										/>
									</Field>

									<Field label="Slug" error={form.formState.errors.slug?.message}>
										<div className="flex h-9 items-center overflow-hidden rounded-sm border border-input bg-transparent focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
											<span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-[12px] text-text-tertiary">
												alethialabs.io/
											</span>
											<input
												className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-[12px] text-text-primary outline-none"
												placeholder="acme-cloud"
												autoComplete="off"
												value={slug}
												onChange={(e) => {
													setSlugTouched(true);
													form.setValue("slug", slugify(e.target.value), {
														shouldValidate: true,
													});
												}}
											/>
										</div>
									</Field>
								</Block>

								{/* 02 Plan */}
								<Block num="02" title="Choose a plan">
									<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
										{CARDS.map((card) => {
											const sel = card.id === plan;
											return (
												<button
													type="button"
													key={card.id}
													onClick={() => setPlan(card.id)}
													className={cn(
														"relative flex flex-col rounded-lg border p-4 text-left transition-colors",
														sel
															? "border-ink ring-1 ring-ink"
															: "border-border hover:border-border-strong",
													)}
												>
													{card.recommended && (
														<span className="absolute right-3 top-3 rounded-full bg-ink px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-ink-foreground">
															Recommended
														</span>
													)}
													<div className="flex items-center gap-2">
														<span className="text-[15px] font-semibold text-text-primary">
															{planMeta(card.id).name}
														</span>
														{sel && (
															<span className="flex size-4 items-center justify-center rounded-full bg-ink text-ink-foreground">
																<Check size={11} strokeWidth={3} />
															</span>
														)}
													</div>
													<p className="mt-1 text-[11.5px] text-text-tertiary">{card.who}</p>
													<div className="mt-3 flex items-baseline gap-1">
														<span className="font-display text-[20px] font-semibold tracking-[-0.02em] text-text-primary">
															{card.price}
														</span>
														{card.per && (
															<span className="font-mono text-[11px] text-text-tertiary">
																{card.per}
															</span>
														)}
													</div>
													<div className="mt-0.5 font-mono text-[10px] text-text-tertiary">
														{card.billed}
													</div>
													<div className="my-3 h-px bg-border" />
													<ul className="space-y-1.5">
														{planMeta(card.id).highlights.map((f) => (
															<li
																key={f}
																className="flex items-center gap-2 text-[12px] text-text-secondary"
															>
																<Check
																	size={12}
																	strokeWidth={2.4}
																	className="shrink-0 text-text-tertiary"
																/>
																<span>{f}</span>
															</li>
														))}
													</ul>
												</button>
											);
										})}
									</div>
									<p className="mt-3 flex items-start gap-2 text-[11.5px] text-text-tertiary">
										<Info size={13} className="mt-0.5 shrink-0" />
										Add-ons billed as used — runner-minutes beyond plan and AI repo-scans
										are metered. Cloud spend is always billed by your own provider.
									</p>
								</Block>

								{/* 03 Team */}
								<Block num="03" title="Invite your team" optional>
									{plan === "community" ? (
										<p className="rounded-lg border border-dashed border-border bg-surface-sunken px-4 py-3 text-[12px] text-text-tertiary">
											Inviting teammates is available on a paid plan — your personal
											workspace is just you.
										</p>
									) : (
										<>
											<div className="flex gap-2">
												<Input
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
												<RoleField
													value={inviteRole}
													onChange={setInviteRole}
													className="w-[120px] shrink-0"
												/>
												<Button
													type="button"
													variant="outline"
													size="sm"
													className="shrink-0"
													onClick={addInvite}
												>
													<Plus size={14} />
													Invite
												</Button>
											</div>

											<div className="mt-3 space-y-1.5">
												<Seat avatar="YO" name="You" meta="Organization creator">
													<span className="rounded-full border border-border-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text-secondary">
														Owner
													</span>
												</Seat>
												{invites.map((inv, i) => (
													<Seat
														key={`${inv.email}-${i}`}
														avatar={inv.email.slice(0, 2).toUpperCase()}
														name={inv.email}
														meta="Invited · pending"
													>
														<RoleField
															value={inv.role}
															onChange={(role) =>
																setInvites((prev) =>
																	prev.map((p, j) => (j === i ? { ...p, role } : p)),
																)
															}
															className="w-[110px]"
														/>
														<button
															type="button"
															aria-label="Remove"
															onClick={() =>
																setInvites((prev) => prev.filter((_, j) => j !== i))
															}
															className="rounded-sm p-1 text-text-tertiary hover:bg-surface-muted hover:text-text-primary"
														>
															<X size={15} />
														</button>
													</Seat>
												))}
											</div>
											<p className="mt-2 flex items-center gap-2 text-[11.5px] text-text-tertiary">
												<Users size={13} />
												<span>
													<b className="font-medium text-text-secondary">{seats}</b> seat
													{seats === 1 ? "" : "s"}
													{plan === "team" ? " · billed per seat" : ""}.
												</span>
											</p>
										</>
									)}
								</Block>
							</form>

							{/* order-summary rail */}
							<aside className="flex flex-col border-t border-border lg:border-l lg:border-t-0">
								<div className="flex-1 space-y-4 overflow-y-auto p-6">
									<span className="vx-eyebrow">Order summary</span>
									<div className="flex items-center gap-3">
										<div className="flex size-9 items-center justify-center rounded-lg bg-ink font-display text-[13px] font-semibold text-ink-foreground">
											{initials(name)}
										</div>
										<div className="flex min-w-0 flex-col">
											<span className="truncate text-[13px] font-medium text-text-primary">
												{name || "Untitled"}
											</span>
											<span className="truncate font-mono text-[11px] text-text-tertiary">
												alethialabs.io/{effSlug}
											</span>
										</div>
									</div>

									<div className="space-y-2 text-[12.5px]">
										<RailLine k="Plan" v={meta.name} strong />
										<RailLine k="Seats" v={String(seats)} />
									</div>

									<div className="h-px bg-border" />

									<div className="space-y-2 text-[12.5px]">
										<RailLine
											k={plan === "team" ? `Team · $29 × ${seats}` : `${meta.name} plan`}
											v={monthly < 0 ? "custom" : money(Math.max(0, monthly))}
										/>
										<RailLine k="Runner-minutes" v="metered" />
										<div className="flex items-start justify-between pt-2">
											<span className="text-[13px] font-medium text-text-primary">
												Due today
											</span>
											<span className="text-right">
												<span className="font-display text-[16px] font-semibold text-text-primary">
													{totalLabel}
												</span>
												<div className="font-mono text-[10px] text-text-tertiary">
													{totalSub}
												</div>
											</span>
										</div>
									</div>
								</div>

								<div className="space-y-2 border-t border-border p-6">
									<Button
										className="w-full"
										disabled={busy}
										onClick={plan === "enterprise" ? contactSales : () => void submit()}
									>
										{busy ? "Setting up…" : ctaLabel}
										<ArrowRight size={15} />
									</Button>
									<Button
										variant="ghost"
										className="w-full"
										onClick={() => handleOpenChange(false)}
									>
										Cancel
									</Button>
									<p className="text-center font-mono text-[10px] text-text-tertiary">
										No charge until you confirm payment.
									</p>
								</div>
							</aside>
						</div>
					</div>
				) : (
					/* payment step */
					<div className="mx-auto flex h-full w-full max-w-md flex-col justify-center gap-5 p-7">
						{!needsSetupRetry && (
							<button
								type="button"
								onClick={() => {
									// Keep the sub/customer refs so the next attempt reuses the
									// customer and cancels this incomplete sub instead of leaking it.
									setStep("details");
									setClientSecret(null);
								}}
								className="self-start text-[12.5px] text-text-tertiary hover:text-text-primary"
							>
								← Back
							</button>
						)}
						<div className="flex items-center justify-between rounded-lg border border-border bg-surface-sunken px-4 py-3">
							<span className="text-[13px] font-medium text-text-primary">
								{meta.name} plan
							</span>
							<span className="font-mono text-[13px] text-text-primary">{totalLabel}</span>
						</div>
						{needsSetupRetry ? (
							/* Paid, but org create / link failed — finish setup without re-charging. */
							<div className="space-y-3">
								<p className="rounded-lg border border-border bg-surface-sunken px-4 py-3 text-[12.5px] text-text-secondary">
									Your payment went through, but we couldn&apos;t finish setting up the
									organization. You won&apos;t be charged again — retry to complete
									setup.
								</p>
								<Button
									className="w-full"
									disabled={busy}
									onClick={() => void handlePaid()}
								>
									{busy ? "Finishing…" : "Complete setup"}
									<ArrowRight size={15} />
								</Button>
							</div>
						) : (
							clientSecret && (
								<StripeElementsProvider clientSecret={clientSecret}>
									<PaymentForm
										mode="payment"
										submitLabel={`Subscribe — ${totalLabel}`}
										onSuccess={handlePaid}
									/>
								</StripeElementsProvider>
							)
						)}
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** The 01 → 02 → 03 stepper (details is the only interactive step). */
function Stepper() {
	const steps = [
		{ n: "01", label: "Details" },
		{ n: "02", label: "Plan" },
		{ n: "03", label: "Team" },
	];
	return (
		<div className="mt-4 flex items-center gap-2">
			{steps.map((s, i) => (
				<div key={s.n} className="flex items-center gap-2">
					<div
						className={cn(
							"flex items-center gap-2 rounded-full border px-2.5 py-1",
							i === 0 ? "border-ink bg-ink text-ink-foreground" : "border-border",
						)}
					>
						<span className="font-mono text-[10px]">{s.n}</span>
						<span
							className={cn(
								"text-[11.5px] font-medium",
								i === 0 ? "text-ink-foreground" : "text-text-tertiary",
							)}
						>
							{s.label}
						</span>
					</div>
					{i < steps.length - 1 && <span className="h-px w-5 bg-border" />}
				</div>
			))}
		</div>
	);
}

/** A numbered section block (01/02/03 + title + rule). */
function Block({
	num,
	title,
	optional,
	children,
}: {
	num: string;
	title: string;
	optional?: boolean;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-3">
			<div className="flex items-center gap-3">
				<span className="font-mono text-[10px] text-text-tertiary">{num}</span>
				<h2 className="font-display text-[14.5px] font-semibold tracking-[-0.01em] text-text-primary">
					{title}
				</h2>
				<span className="h-px flex-1 bg-border" />
				{optional && (
					<span className="font-mono text-[10px] uppercase tracking-wide text-text-tertiary">
						optional
					</span>
				)}
			</div>
			{children}
		</section>
	);
}

/** A labeled form field with an optional error. */
function Field({
	label,
	required,
	error,
	children,
}: {
	label: string;
	required?: boolean;
	error?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-1.5 text-[13px] font-medium text-text-primary">
				{label}
				{required && (
					<span className="font-mono text-[10px] uppercase tracking-wide text-text-tertiary">
						required
					</span>
				)}
			</div>
			{children}
			{error && <p className="text-[11px] text-destructive">{error}</p>}
		</div>
	);
}

/** A seat row in the invite list. */
function Seat({
	avatar,
	name,
	meta,
	children,
}: {
	avatar: string;
	name: string;
	meta: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
			<span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface-muted font-mono text-[10px] text-text-secondary">
				{avatar}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[12.5px] text-text-primary">{name}</span>
				<span className="font-mono text-[10px] text-text-tertiary">{meta}</span>
			</div>
			{children}
		</div>
	);
}

/** A key/value line in the order-summary rail. */
function RailLine({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-text-tertiary">{k}</span>
			<span
				className={cn(
					"text-right",
					strong ? "font-medium text-text-primary" : "text-text-secondary",
				)}
			>
				{v}
			</span>
		</div>
	);
}
