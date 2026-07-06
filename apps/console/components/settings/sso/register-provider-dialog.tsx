"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
	type Control,
	type FieldPath,
	type FieldValues,
	FormProvider,
	useForm,
} from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@repo/ui/dialog";
import { FormControl, FormField, FormItem, FormMessage } from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@repo/ui/tabs";
import { Textarea } from "@repo/ui/textarea";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const oidcSchema = z.object({
	providerId: z.string().min(1, "Required"),
	domain: z.string().min(1, "Required"),
	issuer: z.string().url("Must be a URL"),
	clientId: z.string().min(1, "Required"),
	clientSecret: z.string().min(1, "Required"),
});
type OidcData = z.infer<typeof oidcSchema>;

const samlSchema = z.object({
	providerId: z.string().min(1, "Required"),
	domain: z.string().min(1, "Required"),
	issuer: z.string().min(1, "IdP Entity ID"),
	entryPoint: z.string().url("Must be a URL"),
	cert: z.string().min(1, "Paste the IdP X.509 certificate"),
});
type SamlData = z.infer<typeof samlSchema>;

interface OidcBody {
	providerId: string;
	issuer: string;
	domain: string;
	organizationId: string | null;
	oidcConfig: { clientId: string; clientSecret: string };
}
interface SamlBody {
	providerId: string;
	issuer: string;
	domain: string;
	organizationId: string | null;
	samlConfig: { entryPoint: string; cert: string };
}

/** Pulls a `message` string off an unknown JSON error body (no unsafe cast). */
function errorMessage(data: unknown): string | null {
	if (typeof data === "object" && data !== null && "message" in data) {
		const m = data.message;
		return typeof m === "string" ? m : null;
	}
	return null;
}

/** POST to the @better-auth/sso register endpoint (present only in Enterprise). */
async function registerProvider(body: OidcBody | SamlBody): Promise<void> {
	const res = await fetch("/api/auth/sso/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const data: unknown = await res.json().catch(() => null);
		throw new Error(errorMessage(data) ?? "Failed to register provider");
	}
}

/** A labeled text/textarea field bound to a typed RHF control. */
function Field<T extends FieldValues>({
	control,
	name,
	label,
	placeholder,
	type = "text",
	multiline = false,
}: {
	control: Control<T>;
	name: FieldPath<T>;
	label: string;
	placeholder?: string;
	type?: string;
	multiline?: boolean;
}) {
	return (
		<FormField
			control={control}
			name={name}
			render={({ field }) => (
				<FormItem>
					<Label className="text-sm">{label}</Label>
					<FormControl>
						{multiline ? (
							<Textarea rows={4} placeholder={placeholder} className="font-mono text-xs" {...field} />
						) : (
							<Input type={type} placeholder={placeholder} {...field} />
						)}
					</FormControl>
					<FormMessage className="text-[11px]" />
				</FormItem>
			)}
		/>
	);
}

/** Register an OIDC or SAML identity provider for the active organization (Enterprise). */
export function RegisterProviderDialog({ onRegistered }: { onRegistered?: () => void }) {
	const [open, setOpen] = useState(false);
	const activeOrgId = useWorkspaceStore((s) => s.activeOrgId);

	const oidcForm = useForm<OidcData>({
		resolver: zodResolver(oidcSchema),
		defaultValues: { providerId: "", domain: "", issuer: "", clientId: "", clientSecret: "" },
		mode: "onChange",
	});
	const samlForm = useForm<SamlData>({
		resolver: zodResolver(samlSchema),
		defaultValues: { providerId: "", domain: "", issuer: "", entryPoint: "", cert: "" },
		mode: "onChange",
	});

	const done = (providerId: string) => {
		toast.success(`Registered ${providerId}`);
		setOpen(false);
		oidcForm.reset();
		samlForm.reset();
		onRegistered?.();
	};
	const fail = (err: unknown) =>
		toast.error(err instanceof Error ? err.message : "Failed to register provider");

	const onOidc = async (d: OidcData) => {
		try {
			await registerProvider({
				providerId: d.providerId,
				issuer: d.issuer,
				domain: d.domain,
				organizationId: activeOrgId,
				oidcConfig: { clientId: d.clientId, clientSecret: d.clientSecret },
			});
			done(d.providerId);
		} catch (err) {
			fail(err);
		}
	};
	const onSaml = async (d: SamlData) => {
		try {
			await registerProvider({
				providerId: d.providerId,
				issuer: d.issuer,
				domain: d.domain,
				organizationId: activeOrgId,
				samlConfig: { entryPoint: d.entryPoint, cert: d.cert },
			});
			done(d.providerId);
		} catch (err) {
			fail(err);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button size="sm" className="gap-2">
					<Plus className="h-4 w-4" />
					Register provider
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Register identity provider</DialogTitle>
					<DialogDescription>
						Connect an OIDC or SAML IdP for this organization. Members signing in with
						a matching email domain are routed to it.
					</DialogDescription>
				</DialogHeader>
				<Tabs defaultValue="oidc">
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="oidc">OIDC</TabsTrigger>
						<TabsTrigger value="saml">SAML</TabsTrigger>
					</TabsList>
					<TabsContent value="oidc">
						<FormProvider {...oidcForm}>
							<form onSubmit={oidcForm.handleSubmit(onOidc)} className="space-y-4">
								<Field control={oidcForm.control} name="providerId" label="Provider ID" placeholder="okta" />
								<Field control={oidcForm.control} name="domain" label="Email domain" placeholder="company.com" />
								<Field control={oidcForm.control} name="issuer" label="Issuer URL" placeholder="https://company.okta.com" />
								<Field control={oidcForm.control} name="clientId" label="Client ID" />
								<Field control={oidcForm.control} name="clientSecret" label="Client secret" type="password" />
								<DialogFooter>
									<Button type="submit" disabled={oidcForm.formState.isSubmitting}>
										Register provider
									</Button>
								</DialogFooter>
							</form>
						</FormProvider>
					</TabsContent>
					<TabsContent value="saml">
						<FormProvider {...samlForm}>
							<form onSubmit={samlForm.handleSubmit(onSaml)} className="space-y-4">
								<Field control={samlForm.control} name="providerId" label="Provider ID" placeholder="entra" />
								<Field control={samlForm.control} name="domain" label="Email domain" placeholder="company.com" />
								<Field control={samlForm.control} name="issuer" label="IdP Entity ID" placeholder="https://sts.windows.net/…" />
								<Field control={samlForm.control} name="entryPoint" label="SSO URL (entry point)" placeholder="https://login.microsoftonline.com/…/saml2" />
								<Field control={samlForm.control} name="cert" label="IdP X.509 certificate" placeholder="-----BEGIN CERTIFICATE-----" multiline />
								<DialogFooter>
									<Button type="submit" disabled={samlForm.formState.isSubmitting}>
										Register provider
									</Button>
								</DialogFooter>
							</form>
						</FormProvider>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
