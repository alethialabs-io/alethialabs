"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Post-signup onboarding flow (/onboarding): organization → plan → invite → done. Operates
// on the user's auto-provisioned primary org (configures it in place — no second
// org). Community/Enterprise need no in-app payment; Team takes payment via the
// existing embedded Stripe flow (createSubscriptionIntent + PaymentForm) and sends
// queued invites once the entitlement is live. Reuses the billing/invite primitives
// rather than reinventing them.

import {
	ArrowLeft,
	ArrowRight,
	Check,
	Plus,
	Users,
	X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { createSubscriptionIntent } from "@/app/server/actions/billing";
import {
	configureOnboardingOrg,
	markOnboardingComplete,
} from "@/app/server/actions/onboarding";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { AuthCard } from "@/components/auth/auth-shell";
import { PaymentForm } from "@/components/billing/payment-form";
import { StripeElementsProvider } from "@/components/billing/stripe-elements";
import { authClient } from "@/lib/auth/client";
import type { PrimaryOrg } from "@/lib/auth/onboarding";
import { planMeta, type PlanId } from "@repo/plan-catalog";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { cn } from "@repo/ui/utils";

const ROLES = ["admin", "operator", "viewer"] as const;
type Role = (typeof ROLES)[number];
interface Invite {
	email: string;
	role: Role;
}

type Step = "org" | "plan" | "invite" | "payment" | "done";

const STEPPER: { key: Step; label: string }[] = [
	{ key: "org", label: "Organization" },
	{ key: "plan", label: "Plan" },
	{ key: "invite", label: "Invite" },
];

/** Per-card price display (the authoritative amounts live in Stripe). */
const PLAN_CARDS: {
	id: PlanId;
	who: string;
	price: string;
	per: string | null;
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
		billed: "Annual · self-managed option",
	},
];

const SALES_MAILTO =
	"mailto:sales@alethialabs.io?subject=Alethia%20Enterprise";

function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (!parts.length) return "OR";
	return ((parts[0][0] ?? "") + (parts[1] ? parts[1][0] : (parts[0][1] ?? "")))
		.toUpperCase()
		.padEnd(2, "R");
}
function slugify(s: string): string {
	return s
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

interface OnboardingWizardProps {
	org: PrimaryOrg;
}

/**
 * The /onboarding state machine. Renders the design's stepped card, configuring the
 * user's existing primary org and (for Team) taking payment inline.
 */
export function OnboardingWizard({ org }: OnboardingWizardProps) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const next = searchParams.get("next") || "/dashboard";
	const { data: session } = authClient.useSession();
	const email = session?.user?.email ?? "you@company.com";

	const [step, setStep] = useState<Step>("org");
	const [name, setName] = useState(org.name);
	const [slug, setSlug] = useState(org.slug);
	const [slugTouched, setSlugTouched] = useState(false);
	const [slugError, setSlugError] = useState<string | null>(null);

	const [plan, setPlan] = useState<PlanId>("team");
	const [invites, setInvites] = useState<Invite[]>([]);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("operator");

	const [busy, setBusy] = useState(false);
	const [clientSecret, setClientSecret] = useState<string | null>(null);

	const seats = 1 + invites.length;
	const invitesEnabled = plan === "team";

	const widthClass =
		step === "plan"
			? "max-w-[980px]"
			: step === "payment"
				? "max-w-[440px]"
				: "max-w-[496px]";

	// ── org step ──────────────────────────────────────────────────────────────
	async function continueOrg() {
		setBusy(true);
		setSlugError(null);
		try {
			const res = await configureOnboardingOrg({ name, slug });
			setSlug(res.slug);
			setStep("plan");
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Couldn't save the organization";
			if (/slug|name|reserved|taken/i.test(msg)) setSlugError(msg);
			else toast.error(msg);
		} finally {
			setBusy(false);
		}
	}

	// ── plan step ─────────────────────────────────────────────────────────────
	function continuePlan() {
		if (plan === "enterprise") window.location.href = SALES_MAILTO;
		setStep("invite");
	}

	// ── invite step ───────────────────────────────────────────────────────────
	function addInvite() {
		const value = inviteEmail.trim();
		if (!z.string().email().safeParse(value).success) {
			toast.error("Enter a valid email to invite.");
			return;
		}
		setInvites((prev) => [...prev, { email: value, role: inviteRole }]);
		setInviteEmail("");
	}

	async function continueInvite() {
		// Team needs a paid subscription before the org entitlement (and invites)
		// go live — take payment now. Community/Enterprise finish straight away.
		if (plan === "team") {
			setBusy(true);
			try {
				await setActiveOrganization(org.id);
				const intent = await createSubscriptionIntent("team", { seats });
				setClientSecret(intent.clientSecret);
				setStep("payment");
			} catch (e) {
				toast.error(
					e instanceof Error ? e.message : "Couldn't start the subscription.",
				);
			} finally {
				setBusy(false);
			}
			return;
		}
		await finish();
	}

	// ── payment step (team) ─────────────────────────────────────────────────────
	async function onPaid() {
		// Entitlement activates via the Stripe webhook; send the queued invites
		// (the org plugin is loaded on paid deployments) and report any misses once.
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
		await finish();
	}

	// ── done ────────────────────────────────────────────────────────────────────
	async function finish() {
		setBusy(true);
		try {
			await markOnboardingComplete();
		} catch {
			// Non-fatal — the user can still proceed; the gate will retry next login.
		} finally {
			setBusy(false);
			setStep("done");
		}
	}

	const planLabel = useMemo(() => {
		if (plan === "community") return `${planMeta(plan).name} · Free`;
		if (plan === "enterprise") return `${planMeta(plan).name} · custom`;
		return `${planMeta(plan).name} · $${seats * 29}/mo`;
	}, [plan, seats]);

	return (
		<div
			className={cn(
				"mx-auto w-full transition-[max-width] duration-[420ms] ease-[cubic-bezier(0.2,0,0,1)]",
				widthClass,
			)}
		>
			{step === "org" && (
				<AuthCard>
					<Stepper current="org" />
					<Head
						title="Create your organization"
						sub="An organization groups your Zones, Specs, and team under shared billing, roles, and audit. You can rename it later."
					/>

					<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="col-span-full flex items-center gap-4">
							<div className="flex size-[52px] shrink-0 items-center justify-center rounded-lg bg-ink font-grotesk text-xl font-semibold text-ink-foreground">
								{initials(name)}
							</div>
							<div className="text-[12.5px] leading-snug text-text-tertiary">
								Generated from the name.
								<br />
								Drop in a logo anytime from settings.
							</div>
						</div>

						<Field className="col-span-full" label="Organization name" required>
							<Input
								value={name}
								autoComplete="off"
								placeholder="Acme Cloud"
								className="h-[46px] rounded-sm border-border-strong bg-surface-sunken"
								onChange={(e) => {
									const v = e.target.value;
									setName(v);
									if (!slugTouched) setSlug(slugify(v));
								}}
							/>
						</Field>

						<Field label="Organization URL" error={slugError ?? undefined}>
							<Input
								value={slug}
								autoComplete="off"
								placeholder="acme-cloud"
								className="h-[46px] rounded-sm border-border-strong bg-surface-sunken font-mono text-[13px]"
								onChange={(e) => {
									setSlugTouched(true);
									setSlug(slugify(e.target.value));
									setSlugError(null);
								}}
							/>
							<span className="mt-1.5 inline-flex font-mono text-[11.5px] text-text-tertiary">
								console.alethialabs.io/
								<b className="font-medium text-text-secondary">{slug || "org"}</b>
							</span>
						</Field>
					</div>

					<Actions
						left={<span className="font-mono">{email} · owner</span>}
						right={
							<PrimaryButton
								busy={busy}
								disabled={name.trim().length < 2 || !slug}
								onClick={continueOrg}
							>
								Continue
							</PrimaryButton>
						}
					/>
				</AuthCard>
			)}

			{step === "plan" && (
				<AuthCard className="px-8 pb-7 pt-8">
					<Stepper current="plan" />
					<Head
						title="Choose your plan"
						sub="Start free and self-hosted, or have us operate the control plane for you. Change plans anytime — you're only billed when you confirm."
					/>

					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{PLAN_CARDS.map((card) => {
							const sel = card.id === plan;
							const meta = planMeta(card.id);
							return (
								<button
									type="button"
									key={card.id}
									onClick={() => setPlan(card.id)}
									className={cn(
										"relative flex flex-col rounded-lg border p-4 text-left transition-colors",
										sel
											? "border-text-primary bg-surface-muted ring-1 ring-text-primary"
											: "border-border hover:border-border-strong hover:bg-surface-muted",
									)}
								>
									{card.recommended && (
										<span className="absolute -top-px right-3.5 -translate-y-1/2 rounded-full bg-ink px-2 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-ink-foreground">
											Recommended
										</span>
									)}
									<div className="flex items-start justify-between">
										<span className="font-grotesk text-[15px] font-semibold text-text-primary">
											{meta.name}
										</span>
										<span
											className={cn(
												"flex size-[18px] items-center justify-center rounded-full border",
												sel
													? "border-ink bg-ink text-ink-foreground"
													: "border-border-strong text-transparent",
											)}
										>
											<Check size={11} strokeWidth={3} />
										</span>
									</div>
									<p className="mt-1.5 min-h-[28px] text-[11px] leading-tight text-text-tertiary">
										{card.who}
									</p>
									<div className="mb-0.5 mt-1.5 flex items-baseline gap-1">
										<span className="font-grotesk text-[26px] font-semibold tracking-[-0.03em] text-text-primary">
											{card.price}
										</span>
										{card.per && (
											<span className="font-mono text-[10.5px] text-text-tertiary">
												{card.per}
											</span>
										)}
									</div>
									<div className="font-mono text-[9.5px] text-text-tertiary">
										{card.billed}
									</div>
									<div className="my-3 h-px bg-border" />
									<ul className="flex flex-col gap-2">
										{meta.highlights.map((f) => (
											<li
												key={f}
												className="flex items-start gap-2 text-[11.5px] leading-tight text-text-secondary"
											>
												<Check
													size={12}
													strokeWidth={2.4}
													className="mt-px shrink-0 text-text-tertiary"
												/>
												<span>{f}</span>
											</li>
										))}
									</ul>
								</button>
							);
						})}
					</div>

					<Actions
						left={
							<span>
								Selected:{" "}
								<b className="font-medium text-text-primary">{planLabel}</b>
							</span>
						}
						right={
							<>
								<BackButton onClick={() => setStep("org")} />
								<PrimaryButton busy={false} onClick={continuePlan}>
									{plan === "enterprise" ? "Contact sales" : "Continue"}
								</PrimaryButton>
							</>
						}
					/>
				</AuthCard>
			)}

			{step === "invite" && (
				<AuthCard>
					<Stepper current="invite" />
					<Head
						title="Invite your team"
						sub="Send invites now or skip and do it later from the console. Members join with the role you pick."
					/>

					{invitesEnabled ? (
						<>
							<div className="flex gap-2.5">
								<Input
									value={inviteEmail}
									placeholder="name@company.com"
									autoComplete="off"
									className="h-[46px] flex-1 rounded-sm border-border-strong bg-surface-sunken"
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
									className="h-[46px] w-[132px] shrink-0"
								/>
								<Button
									type="button"
									variant="outline"
									className="h-[46px] shrink-0 rounded-sm"
									onClick={addInvite}
								>
									<Plus size={14} />
									Invite
								</Button>
							</div>

							<div className="mt-3.5 overflow-hidden rounded-md border border-border">
								<Seat
									avatar={email.slice(0, 2).toUpperCase()}
									name={email}
									meta="Organization creator"
								>
									<span className="rounded-full border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
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
											className="h-[34px] w-[112px]"
										/>
										<button
											type="button"
											aria-label="Remove"
											onClick={() =>
												setInvites((prev) => prev.filter((_, j) => j !== i))
											}
											className="rounded-sm p-1.5 text-text-disabled transition-colors hover:bg-surface-muted hover:text-text-primary"
										>
											<X size={15} />
										</button>
									</Seat>
								))}
							</div>
							<p className="mt-3 flex items-center gap-2 text-xs text-text-tertiary">
								<Users size={13} className="shrink-0" />
								<span>
									<b className="font-medium text-text-secondary">{seats}</b> seat
									{seats === 1 ? "" : "s"} on the {planMeta(plan).name} plan.
								</span>
							</p>
						</>
					) : (
						<p className="rounded-md border border-dashed border-border bg-surface-sunken px-4 py-3 text-[12.5px] text-text-tertiary">
							Inviting teammates is available on the Team plan — your workspace
							is just you for now. You can upgrade and invite anytime from the
							console.
						</p>
					)}

					<Actions
						left={
							<button
								type="button"
								onClick={() => void finish()}
								className="text-text-tertiary transition-colors hover:text-text-primary"
							>
								Skip for now
							</button>
						}
						right={
							<>
								<BackButton onClick={() => setStep("plan")} />
								<PrimaryButton busy={busy} onClick={() => void continueInvite()}>
									Finish setup
								</PrimaryButton>
							</>
						}
					/>
				</AuthCard>
			)}

			{step === "payment" && clientSecret && (
				<AuthCard>
					<button
						type="button"
						onClick={() => {
							setStep("invite");
							setClientSecret(null);
						}}
						className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-text-tertiary transition-colors hover:text-text-primary"
					>
						<ArrowLeft size={14} /> Back
					</button>
					<div className="mb-4 flex items-center justify-between rounded-md border border-border bg-surface-sunken px-4 py-3">
						<span className="text-[13px] font-medium text-text-primary">
							{planMeta("team").name} · {seats} seat{seats === 1 ? "" : "s"}
						</span>
						<span className="font-mono text-[13px] text-text-primary">
							${seats * 29}/mo
						</span>
					</div>
					<StripeElementsProvider clientSecret={clientSecret}>
						<PaymentForm
							mode="payment"
							submitLabel={`Subscribe — $${seats * 29}/mo`}
							onSuccess={() => void onPaid()}
						/>
					</StripeElementsProvider>
				</AuthCard>
			)}

			{step === "done" && (
				<AuthCard>
					<div className="mb-6 flex flex-col gap-2.5">
						<div className="mb-1 flex size-14 items-center justify-center rounded-full border border-border-strong bg-surface-muted text-text-primary">
							<Check size={26} />
						</div>
						<p className="vx-eyebrow">Ready</p>
						<h1 className="font-grotesk text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary">
							{name || "Your org"} is live
						</h1>
						<p className="text-[14.5px] leading-[1.55] text-text-secondary">
							Your organization is set up. Jump into the console to connect a
							cloud and create your first Spec.
						</p>
					</div>

					<div className="overflow-hidden rounded-md border border-border">
						<SummaryRow k="Organization" v={`console.alethialabs.io/${slug}`} />
						<SummaryRow k="Plan" v={planMeta(plan).name} />
						<SummaryRow k="Seats" v={String(seats)} />
					</div>

					<Button
						className="mt-5 h-[46px] w-full rounded-sm bg-ink text-sm font-medium text-ink-foreground hover:bg-ink-hover"
						disabled={busy}
						onClick={() => router.push(next)}
					>
						Open the console
						<ArrowRight size={16} className="ml-1" />
					</Button>
				</AuthCard>
			)}
		</div>
	);
}

/** Organization → Plan → Invite stepper (account is already done on /signup). */
function Stepper({ current }: { current: Step }) {
	const idx = STEPPER.findIndex((s) => s.key === current);
	return (
		<div className="mb-7 flex items-center">
			{STEPPER.map((s, i) => {
				const state = i < idx ? "done" : i === idx ? "active" : "todo";
				return (
					<div key={s.key} className="flex items-center">
						<span className="inline-flex items-center gap-2.5">
							<span
								className={cn(
									"grid size-5 place-items-center rounded-full border font-mono text-[9px]",
									state === "done"
										? "border-ink bg-ink text-ink-foreground"
										: state === "active"
											? "border-text-primary text-text-primary"
											: "border-border-strong text-text-tertiary",
								)}
							>
								{state === "done" ? <Check size={11} /> : String(i + 1).padStart(2, "0")}
							</span>
							<span
								className={cn(
									"font-mono text-[10px] uppercase tracking-[0.1em]",
									state === "todo" ? "text-text-tertiary" : "text-text-secondary",
								)}
							>
								{s.label}
							</span>
						</span>
						{i < STEPPER.length - 1 && (
							<span className="mx-3.5 h-px w-4 min-w-4 flex-1 bg-border-strong" />
						)}
					</div>
				);
			})}
		</div>
	);
}

/** Step heading (display title + supporting copy). */
function Head({ title, sub }: { title: string; sub: string }) {
	return (
		<div className="mb-6 flex flex-col gap-2.5">
			<h1 className="font-grotesk text-[28px] font-semibold leading-[1.05] tracking-[-0.03em] text-text-primary">
				{title}
			</h1>
			<p className="text-[14.5px] leading-[1.55] text-text-secondary">{sub}</p>
		</div>
	);
}

/** Footer action row (left meta / right buttons) with a top rule. */
function Actions({
	left,
	right,
}: {
	left: React.ReactNode;
	right: React.ReactNode;
}) {
	return (
		<div className="mt-7 flex items-center justify-between gap-3 border-t border-border pt-5 text-[12.5px] text-text-tertiary">
			<div className="min-w-0 truncate">{left}</div>
			<div className="flex items-center gap-2.5">{right}</div>
		</div>
	);
}

/** Ink primary button with an arrow + busy state. */
function PrimaryButton({
	busy,
	children,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean }) {
	return (
		<Button
			{...props}
			disabled={busy || props.disabled}
			className="group h-[46px] rounded-sm bg-ink px-5 text-sm font-medium text-ink-foreground hover:bg-ink-hover"
		>
			{busy ? "Working…" : children}
			{!busy && (
				<ArrowRight
					size={16}
					className="ml-1 transition-transform group-hover:translate-x-[3px]"
				/>
			)}
		</Button>
	);
}

/** Ghost "← Back" button. */
function BackButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="inline-flex h-[46px] items-center gap-1.5 px-2 text-[13px] text-text-tertiary transition-colors hover:text-text-primary"
		>
			<ArrowLeft size={15} />
			Back
		</button>
	);
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
			<SelectTrigger aria-label="Role" className={cn("capitalize", className)}>
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
		<div className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">
			<span className="grid size-[30px] shrink-0 place-items-center rounded-full border border-border-strong bg-surface-muted font-mono text-[11px] text-text-secondary">
				{avatar}
			</span>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[13px] text-text-primary">{name}</span>
				<span className="font-mono text-[10px] text-text-tertiary">{meta}</span>
			</div>
			{children}
		</div>
	);
}

/** A key/value row in the done-step summary. */
function SummaryRow({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 text-[13px] last:border-b-0">
			<span className="shrink-0 text-text-tertiary">{k}</span>
			<span className="truncate text-right font-mono text-[12px] text-text-primary">
				{v}
			</span>
		</div>
	);
}

/** A labeled form field with an optional error. */
function Field({
	label,
	required,
	error,
	className,
	children,
}: {
	label: string;
	required?: boolean;
	error?: string;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<div className={cn("flex flex-col gap-2", className)}>
			<label className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-text-tertiary">
				{label}
				{required && <span className="ml-1 text-text-disabled">· required</span>}
			</label>
			{children}
			{error && <p className="text-[11px] text-destructive">{error}</p>}
		</div>
	);
}
