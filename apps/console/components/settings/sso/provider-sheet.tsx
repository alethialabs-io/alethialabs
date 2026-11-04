"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The SSO provider editor Sheet — the second AccordionForm consumer (Protocol → Identity provider
// → Domain & mapping → Review) with a persistent footer submit. Registration goes through
// @better-auth/sso's own /api/auth/sso/register endpoint; edits go through the updateSsoProvider
// server action (which merges into the stored config, so an untouched secret is preserved).
//
// #6129: both writes go through `useActionMutation` — pending state that disables the submit (the
// double-submit guard), field errors under their fields, the plugin's refusal shown in the form
// beside the values it is about (#5445), and every `sso.*` read invalidated. The sheet TRACKS DIRTY
// STATE: an edit with no change cannot be saved, and closing it with unsaved changes asks first.

import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { type SsoProviderRow, updateSsoProvider } from "@/app/server/actions/sso";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import {
	AccordionForm,
	type FormSectionDef,
} from "@/components/forms/accordion-form";
import { authActionError } from "@/components/settings/members/auth-action";
import type { ActionResult, FieldErrors } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { ssoReadKeys } from "@/lib/query/use-sso-query";
import {
	type SsoProviderInput,
	ssoProviderSchema,
} from "@/lib/validations/sso";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";

interface ProviderSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The provider being edited, or null to register a new one. */
	provider: SsoProviderRow | null;
	canManage: boolean;
	/** The ADDRESSED org (the page's bootstrap): a new provider is registered for this org. */
	orgId: string;
}

const BLANK: SsoProviderInput = {
	type: "oidc",
	providerId: "",
	domain: "",
	issuer: "",
	clientId: "",
	clientSecret: "",
	entryPoint: "",
	cert: "",
	mappingEmail: "",
	mappingName: "",
};

/** The form's fields a server validation message can be placed under. */
const SSO_FIELDS = [
	"providerId",
	"domain",
	"issuer",
	"clientId",
	"clientSecret",
	"entryPoint",
	"cert",
] as const satisfies readonly (keyof SsoProviderInput)[];

/** Drops empty strings so we never persist a blank mapping override. */
function mappingOf(v: SsoProviderInput): Record<string, string> | undefined {
	const m: Record<string, string> = {};
	if (v.mappingEmail) m.email = v.mappingEmail;
	if (v.mappingName) m.name = v.mappingName;
	return Object.keys(m).length > 0 ? m : undefined;
}

/** The plugin's own message in a refused registration's body, when it wrote one. */
function messageOf(data: unknown): string | undefined {
	return typeof data === "object" && data !== null && "message" in data && typeof data.message === "string"
		? data.message
		: undefined;
}

/**
 * Registers a provider through @better-auth/sso's own endpoint (it mints the domain-verification
 * token and enforces the Enterprise entitlement via the ee/ guard), answering in the console's
 * `ActionResult` shape so the registration rides `useActionMutation` like the edit does. A 4xx
 * carries the plugin's sentence; a 5xx or a dropped connection is `unexpected`.
 */
export async function registerSsoProvider(
	values: SsoProviderInput,
	orgId: string,
): Promise<ActionResult<{ registered: true }>> {
	const base = { providerId: values.providerId, issuer: values.issuer, domain: values.domain, organizationId: orgId };
	const body =
		values.type === "oidc"
			? {
					...base,
					oidcConfig: { clientId: values.clientId, clientSecret: values.clientSecret, mapping: mappingOf(values) },
				}
			: {
					...base,
					samlConfig: { entryPoint: values.entryPoint, cert: values.cert, mapping: mappingOf(values) },
				};
	try {
		const res = await fetch("/api/auth/sso/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (res.ok) return { ok: true, data: { registered: true } };
		const data: unknown = await res.json().catch(() => null);
		return {
			ok: false,
			error: authActionError({ status: res.status, message: messageOf(data) ?? "Couldn't register the provider" }),
		};
	} catch {
		return { ok: false, error: { kind: "unexpected", ref: "sso-register-network" } };
	}
}

export function ProviderSheet({
	open,
	onOpenChange,
	provider,
	canManage,
	orgId,
}: ProviderSheetProps) {
	const [openSection, setOpenSection] = useState("protocol");
	// Asked when the sheet is closed with unsaved changes: discard them, or keep editing.
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const isEdit = provider != null;
	const mode = isEdit ? "edit" : "create";

	// The signing-certificate textarea's `id`, paired with its `<Label htmlFor>`.
	const certId = useId();
	const form = useForm<SsoProviderInput>({
		resolver: zodResolver(ssoProviderSchema(mode)),
		defaultValues: BLANK,
		mode: "onChange",
	});

	const wasOpen = useRef(false);
	useEffect(() => {
		if (open && !wasOpen.current) {
			form.reset(
				provider
					? {
							...BLANK,
							// A row with neither config reports "unknown"; default the editor to OIDC.
							type: provider.type === "saml" ? "saml" : "oidc",
							providerId: provider.providerId,
							domain: provider.domain,
							issuer: provider.issuer,
							clientId: provider.clientId ?? "",
							entryPoint: provider.ssoUrl ?? "",
						}
					: BLANK,
			);
			setOpenSection("protocol");
		}
		wasOpen.current = open;
	}, [open, provider, form]);

	// Subscribing to `type` here re-renders the sheet, so the sections below (whose `fields` swap
	// per protocol) are rebuilt on a protocol switch.
	const type = form.watch("type");
	const errors = form.formState.errors;
	/** The IdP plugin's refusal of the last save or registration, shown above the footer. */
	const serverError = errors.root?.server?.message;

	/** The edit (the server action) or the registration (the plugin's endpoint) for these values. */
	function saveProvider(v: SsoProviderInput): Promise<ActionResult<unknown>> {
		if (!provider) return registerSsoProvider(v, orgId);
		return updateSsoProvider({
			id: provider.id,
			domain: v.domain || undefined,
			issuer: v.issuer || undefined,
			clientId: v.clientId || undefined,
			clientSecret: v.clientSecret || undefined,
			entryPoint: v.entryPoint || undefined,
			cert: v.cert || undefined,
			mapping: mappingOf(v),
		});
	}

	const save = useActionMutation(saveProvider, {
		invalidates: ssoReadKeys(),
		successMessage: () =>
			isEdit ? "Provider updated" : "Provider registered — verify its domain to enable sign-in",
		// The plugin's refusal stays in the form that caused it, beside the values it is about —
		// not a toast that is gone before an admin has read which value the IdP refused (#5445).
		onRefusal: (error) => form.setError("root.server", { message: error.message }),
		onValidationError: (fields: FieldErrors) => {
			let placed = false;
			for (const name of SSO_FIELDS) {
				const message = fields[name]?.[0];
				if (message) {
					form.setError(name, { type: "server", message });
					placed = true;
				}
			}
			if (!placed) {
				const first = Object.values(fields).find((m) => m && m.length > 0)?.[0];
				form.setError("root.server", { message: first ?? "Check the highlighted fields." });
			}
		},
		onSuccess: () => {
			form.reset(form.getValues());
			onOpenChange(false);
		},
	});
	const saving = save.isPending;

	function onSubmit(v: SsoProviderInput) {
		if (save.isPending) return;
		form.clearErrors("root.server");
		save.mutate(v);
	}

	const dirty = form.formState.isDirty;
	/** Closing asks first when there is something to lose; a pristine sheet just closes. */
	function requestOpenChange(next: boolean) {
		if (!next && dirty && !save.isPending) {
			setConfirmDiscard(true);
			return;
		}
		onOpenChange(next);
	}


	const sections: FormSectionDef<SsoProviderInput>[] = [
		{
			id: "protocol",
			title: "Protocol",
			hint: "Which standard your identity provider speaks.",
			fields: ["type"],
			summary: (v) => (v.type === "saml" ? "SAML 2.0" : "OIDC"),
			body: (v) => (
				<div className="flex gap-2">
					{(["oidc", "saml"] as const).map((t) => (
						<button
							key={t}
							type="button"
							disabled={!canManage || isEdit}
							onClick={() => form.setValue("type", t, { shouldValidate: true })}
							className={cn(
								"flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors",
								v.type === t
									? "border-border-strong bg-surface-muted"
									: "border-border hover:border-border-strong",
								(isEdit || !canManage) && "opacity-60",
							)}
						>
							<div className="text-ui-md font-medium text-text-primary">
								{t === "oidc" ? "OIDC" : "SAML 2.0"}
							</div>
							<div className="text-ui-xs text-text-tertiary">
								{t === "oidc"
									? "OpenID Connect (Okta, Entra ID, Auth0…)"
									: "SAML assertions (ADFS, OneLogin…)"}
							</div>
						</button>
					))}
				</div>
			),
		},
		{
			id: "idp",
			title: "Identity provider",
			hint:
				type === "oidc"
					? "From your IdP's OIDC application."
					: "From your IdP's SAML application metadata.",
			// Fields SWAP on protocol — AccordionForm reads `fields` fresh each render, so
			// validation/advance only ever considers the active branch.
			fields:
				type === "oidc"
					? ["issuer", "clientId", "clientSecret"]
					: ["issuer", "entryPoint", "cert"],
			summary: (v) => v.issuer,
			body: () => (
				<div className="space-y-3">
					<Field
						label={type === "oidc" ? "Issuer URL" : "IdP Entity ID (issuer)"}
						placeholder={
							type === "oidc" ? "https://acme.okta.com" : "https://idp.acme.com/metadata"
						}
						error={errors.issuer?.message}
						disabled={!canManage}
						{...form.register("issuer")}
					/>
					{type === "oidc" ? (
						<>
							<Field
								label="Client ID"
								placeholder="0oa1b2c3…"
								error={errors.clientId?.message}
								disabled={!canManage}
								{...form.register("clientId")}
							/>
							<Field
								label="Client secret"
								type="password"
								placeholder={isEdit ? "•••••• (unchanged)" : "…"}
								hint={isEdit ? "Leave blank to keep the stored secret." : undefined}
								error={errors.clientSecret?.message}
								disabled={!canManage}
								{...form.register("clientSecret")}
							/>
						</>
					) : (
						<>
							<Field
								label="IdP sign-on URL"
								placeholder="https://idp.acme.com/sso/saml"
								error={errors.entryPoint?.message}
								disabled={!canManage}
								{...form.register("entryPoint")}
							/>
							<div className="space-y-1.5">
								<Label htmlFor={certId} className="text-ui-xs text-text-tertiary">
									Signing certificate (X.509)
								</Label>
								<Textarea
									id={certId}
									rows={4}
									className="font-mono text-ui-xs"
									placeholder={
										isEdit
											? "•••••• (unchanged — paste a new cert to rotate)"
											: "-----BEGIN CERTIFICATE-----"
									}
									disabled={!canManage}
									{...form.register("cert")}
								/>
								{errors.cert && (
									<p className="text-destructive text-xs">{errors.cert.message}</p>
								)}
							</div>
						</>
					)}
				</div>
			),
		},
		{
			id: "domain",
			title: "Domain & mapping",
			hint: "The email domain this IdP is authoritative for. You'll prove ownership via DNS after saving.",
			fields: ["domain"],
			summary: (v) => v.domain,
			body: () => (
				<div className="space-y-3">
					{!isEdit && (
						<Field
							label="Provider id"
							placeholder="okta-prod"
							hint="A stable slug used in URLs and the DNS record."
							error={errors.providerId?.message}
							disabled={!canManage}
							{...form.register("providerId")}
						/>
					)}
					<Field
						label="Email domain"
						placeholder="acme.com"
						error={errors.domain?.message}
						disabled={!canManage}
						{...form.register("domain")}
					/>
					<div className="grid grid-cols-2 gap-2">
						<Field
							label="Email claim"
							placeholder="email (default)"
							disabled={!canManage}
							{...form.register("mappingEmail")}
						/>
						<Field
							label="Name claim"
							placeholder="name (default)"
							disabled={!canManage}
							{...form.register("mappingName")}
						/>
					</div>
				</div>
			),
		},
		{
			id: "review",
			title: "Review",
			fields: [],
			terminal: true,
			complete: () => true,
			summary: () => "",
			body: (v) => (
				<div className="space-y-1.5 text-ui-sm text-text-secondary">
					<Row k="Protocol" v={v.type === "saml" ? "SAML 2.0" : "OIDC"} />
					<Row k="Provider id" v={v.providerId || provider?.providerId || "—"} />
					<Row k="Domain" v={v.domain || "—"} />
					<Row k="Issuer" v={v.issuer || "—"} />
					{!isEdit && (
						<p className="pt-1 text-ui-xs text-text-tertiary">
							After registering, add the DNS TXT record shown on the provider to verify
							the domain — sign-in stays disabled until it&apos;s verified.
						</p>
					)}
				</div>
			),
		},
	];

	return (
		<>
		<Sheet open={open} onOpenChange={requestOpenChange}>
			<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
				<SheetHeader className="gap-3 border-b border-border/60 p-5">
					<div className="flex items-center gap-3">
						<span className="flex size-10 items-center justify-center rounded-lg border border-border/60 bg-muted/30">
							<KeyRound size={18} className="text-text-secondary" />
						</span>
						<div>
							<SheetTitle className="font-display text-base">
								{isEdit ? "Edit provider" : "Connect an identity provider"}
							</SheetTitle>
							<SheetDescription className="text-xs">
								{isEdit
									? provider.providerId
									: "Register your IdP so your team can sign in with SSO."}
							</SheetDescription>
						</div>
					</div>
				</SheetHeader>
				<FormProvider {...form}>
					<div className="flex-1 overflow-y-auto p-5">
						<AccordionForm
							sections={sections}
							open={openSection}
							onOpenChange={setOpenSection}
						/>
						{serverError && (
							<p
								role="alert"
								className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-ui-sm text-destructive"
							>
								{serverError}
							</p>
						)}
					</div>
					<SheetFooter className="flex-row items-center justify-between border-t border-border/60 p-4">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => requestOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							// An edit with nothing changed has nothing to save; a registration always does.
							disabled={!canManage || saving || (isEdit && !dirty)}
							onClick={() => void form.handleSubmit(onSubmit)()}
						>
							{saving
								? "Saving…"
								: isEdit
									? "Save changes"
									: "Register provider"}
						</Button>
					</SheetFooter>
				</FormProvider>
			</SheetContent>
		</Sheet>
		<ConfirmDialog
			open={confirmDiscard}
			onOpenChange={setConfirmDiscard}
			title="Discard your changes?"
			description={
				isEdit
					? "The changes to this provider are not saved. Closing the editor drops them."
					: "This provider is not registered yet. Closing the editor drops what you entered."
			}
			confirmLabel="Discard changes"
			onConfirm={() => {
				form.reset();
				onOpenChange(false);
			}}
		/>
		</>
	);
}

/** A labelled input with an optional hint + error. Forwards RHF's register props. */
function Field({
	label,
	hint,
	error,
	...props
}: React.ComponentProps<typeof Input> & {
	label: string;
	hint?: string;
	error?: string;
}) {
	const id = useId();
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id} className="text-ui-xs text-text-tertiary">
				{label}
			</Label>
			<Input id={id} autoComplete="off" {...props} />
			{hint && !error && (
				<p className="text-ui-xs text-text-tertiary">{hint}</p>
			)}
			{error && <p className="text-destructive text-xs">{error}</p>}
		</div>
	);
}

function Row({ k, v }: { k: string; v: string }) {
	return (
		<div className="flex gap-2">
			<span className="text-text-tertiary">{k}:</span>
			<span className="truncate">{v}</span>
		</div>
	);
}
