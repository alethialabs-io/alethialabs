"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · General — the authored claude.ai/design panel (Organization profile / Defaults /
// Danger zone), composed from the shared settings primitives.
//
// #6128: the values arrive with the page (`settings.org`, prefetched by the route and hydrated), so
// there is no client fetch on mount and no skeleton after the route's; the form is react-hook-form
// over the SAME zod schema the server action validates (lib/validations/org-general.ts); a save is
// `saveOrgGeneral` through `useActionMutation` — pending, double-submit guarded, field errors inline,
// and every key that shows the org's name invalidated (the switcher reads the workspace context).
// The logo saves itself through its own upload control; ownership transfer is not built yet.

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId } from "react";
import { Controller, type FieldPath, useForm } from "react-hook-form";
import {
  deleteOrganization,
  saveOrgGeneral,
} from "@/app/server/actions/org-settings";
import { RegionError } from "@/components/errors/region-error";
import { OrgLogoUpload } from "@/components/org/org-logo-upload";
import {
  GeneralRefusal,
  OrgGeneralSkeleton,
} from "@/components/settings/general/general-states";
import {
  SettingsCardFoot,
  SettingsColumns,
  SettingsDangerRow,
  SettingsField,
  SettingsInput,
  SettingsPanel,
  SettingsSection,
  SettingsSelect,
  SettingsTextarea,
  settingsControl,
  settingsControlSize,
} from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { FieldErrors } from "@/lib/actions/result";
import type { OrgPrimaryAddress, OrgSettings } from "@/lib/org/settings";
import { orgHost } from "@/lib/org-url";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { finishSlugDraft, slugifyDraft } from "@/lib/utils/slugify";
import {
  ORG_DESCRIPTION_MAX_LENGTH,
  ORG_NAME_MAX_LENGTH,
  type OrgGeneralInput,
  type OrgGeneralValues,
  TERRAFORM_VERSION_MAX_LENGTH,
  orgGeneralSchema,
} from "@/lib/validations/org-general";
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
} from "@repo/ui/alert-dialog";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { ReadOnlyValue } from "@repo/ui/read-only-value";
import { cn } from "@repo/ui/utils";

const REGIONS = [
  "eu-west-1 · Frankfurt",
  "eu-north-1 · Stockholm",
  "us-east-1 · N. Virginia",
  "ap-southeast-1 · Singapore",
];
const ENVS = ["staging", "development", "production"];

/** Why Save is disabled for a role better-auth will refuse (it updates the org for owner and admin). */
const EDIT_REFUSED = "Only an owner or admin can change these settings";
/** Why Delete is disabled for anyone but the owner (better-auth deletes the org for the owner only). */
const DELETE_REFUSED = "Only the organization's owner can delete it";

/** The form's fields — the keys a server field error may name. */
const FORM_FIELDS: readonly FieldPath<OrgGeneralInput>[] = [
  "name",
  "slug",
  "description",
  "region",
  "defaultEnv",
  "terraformVersion",
];

/** Narrows a server field-error key to one of the form's fields. */
function isFormField(key: string): key is FieldPath<OrgGeneralInput> {
  return FORM_FIELDS.some((field) => field === key);
}

/** A compact, human-readable rendering of the org's primary (billing) address. */
function formatPrimaryAddress(a: OrgPrimaryAddress): string {
  const cityLine = [a.city, a.state, a.postalCode].filter(Boolean).join(" ");
  return [a.name, a.line1, a.line2, cityLine, a.country]
    .filter((part) => part && part.trim())
    .join(", ");
}

/** The form's values for a settings read. */
function formValues(s: OrgSettings): OrgGeneralInput {
  return {
    name: s.name,
    slug: s.slug,
    description: s.description,
    region: s.region,
    defaultEnv: s.defaultEnv,
    terraformVersion: s.terraformVersion,
  };
}

/**
 * A field's inline error. `role="alert"` because a server refusal (a slug taken since the page
 * loaded) changes nothing else on screen.
 */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-ui-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * The org General settings page body. Four renders, never confused (RUBRIC B4): the form (data),
 * the personal workspace's note (an explicit answer, not an empty form), a refusal, and an error
 * with a retry. The skeleton shows only if the server's prefetch did not land.
 */
export function OrgGeneral() {
  const query = useQuery(
    orpc.settings.org.queryOptions({ retry: retryUnlessRefused }),
  );

  if (query.data === undefined) {
    if (query.isError) {
      const refusal = readRefusalOf(query.error);
      if (refusal) return <GeneralRefusal refusal={refusal} />;
      return (
        <RegionError
          title="Couldn't load organization settings"
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <OrgGeneralSkeleton />;
  }

  if (query.data.scope === "personal") {
    return (
      <EmptyState
        data-state="personal"
        className="border border-dashed border-border p-6 md:p-6"
        icon={<Building2 size={18} aria-hidden />}
        title="No organization settings here"
        description="This is your personal workspace. An organization's name, URL and defaults are set in the organization."
      />
    );
  }

  return <OrgGeneralForm settings={query.data.settings} />;
}

/** The form, over a loaded org. */
function OrgGeneralForm({ settings }: { settings: OrgSettings }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ids = {
    name: useId(),
    slug: useId(),
    description: useId(),
    terraformVersion: useId(),
  };

  const form = useForm<OrgGeneralInput, unknown, OrgGeneralValues>({
    resolver: zodResolver(orgGeneralSchema),
    defaultValues: formValues(settings),
  });
  const { errors, isDirty, isSubmitting } = form.formState;

  // Another admin's save arrives through the `organization` topic, which refetches this read. A
  // pristine form follows it; a form with edits in it is left alone — the user's edits are not
  // overwritten under their cursor, and their save writes what they see.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset(formValues(settings));
  }, [settings, form]);

  /** Every key that shows this org's name, slug, logo or settings. */
  const orgKeys = [orpc.settings.org.key(), orpc.workspace.context.key()];

  // What the caller may do here, from the workspace context the layout already hydrated — read from
  // the cache, never fetched for this. better-auth lets an owner or admin update the org and only
  // the owner delete it; the server still decides (this only saves a refused round trip). An
  // unknown role (no context cached) leaves the controls enabled for the server to rule on.
  const context = useQuery(orpc.workspace.context.queryOptions({ enabled: false }));
  const role =
    context.data?.organizations.find((o) => o.id === context.data?.activeOrgId)?.role ?? null;
  const canEdit = role === null || role === "owner" || role === "admin";
  const canDelete = role === null || role === "owner";

  const save = useActionMutation(saveOrgGeneral, {
    // A slug rename leaves this address naming nothing: a refetch under it would only paint a
    // refusal before the navigation lands. The new address is a new tenant cache, filled by its own
    // server render, so nothing is invalidated here then; otherwise every key showing the org is.
    invalidates: (saved) => (saved && saved.slug !== settings.slug ? [] : orgKeys),
    successMessage: "Organization updated.",
    onValidationError: (fields: FieldErrors) => {
      for (const [key, messages] of Object.entries(fields)) {
        const message = messages?.[0];
        if (message && isFormField(key)) form.setError(key, { type: "server", message });
      }
    },
    onSuccess: (saved, variables) => {
      // The baseline is what was SAVED, so Save re-disables and the slug field shows the finished
      // slug rather than the draft that was typed.
      form.reset({ ...variables, name: saved.name, slug: saved.slug });
      // The org's URL changed: this page's address no longer names it. Go to where it lives now.
      if (saved.slug !== settings.slug) router.replace(`/${saved.slug}/~/settings/general`);
    },
  });

  const remove = useActionMutation(deleteOrganization, {
    // The org is gone, so nothing under this address can be read again; `/dashboard` resolves the
    // next org and its own cache. Invalidating here would only refetch into a refusal.
    invalidates: [],
    successMessage: "Organization deleted.",
    onSuccess: () => router.push("/dashboard"),
  });

  // `mutateAsync` inside `handleSubmit` keeps `isSubmitting` true until the save has settled, so
  // the buttons stay disabled for the whole round trip — three rapid clicks are one save (F015).
  // A failure is already routed by the mutation (field errors, or one toast), so it is not rethrown.
  const onSubmit = form.handleSubmit(async (values) => {
    if (save.isPending) return;
    await save.mutateAsync(values).catch(() => undefined);
  });

  const busy = isSubmitting || save.isPending;
  const saveBtn = canEdit ? (
    <Button type="submit" size="sm" disabled={!isDirty || busy}>
      {busy ? "Saving…" : "Save changes"}
    </Button>
  ) : (
    <DisabledReason reason={EDIT_REFUSED}>
      <Button type="submit" size="sm" disabled>
        Save changes
      </Button>
    </DisabledReason>
  );

  return (
    <div>
      <form noValidate onSubmit={onSubmit} aria-label="Organization settings">
        {/* A role that cannot save cannot edit either: every field is read-only, and the Save
            buttons say why. */}
        <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
          <SettingsColumns>
            <SettingsSection title="Organization profile">
              <SettingsPanel>
                <div className="py-1">
                  <SettingsField
                    label="Logo"
                    hint="A square avatar, generated from the name until you upload one."
                  >
                    <OrgLogoUpload
                      name={settings.name}
                      logo={settings.logo}
                      onChange={() => {
                        for (const queryKey of orgKeys) void queryClient.invalidateQueries({ queryKey });
                      }}
                    />
                  </SettingsField>
                  <SettingsField
                    label="Organization name"
                    hint="Shown across the console and in invitations."
                  >
                    <SettingsInput
                      className={cn(settingsControl, settingsControlSize)}
                      autoComplete="off"
                      maxLength={ORG_NAME_MAX_LENGTH}
                      aria-invalid={errors.name ? true : undefined}
                      aria-describedby={errors.name ? ids.name : undefined}
                      {...form.register("name")}
                    />
                    <FieldError id={ids.name} message={errors.name?.message} />
                  </SettingsField>
                  <SettingsField
                    label="Organization URL"
                    hint="The slug for your organization's URL."
                  >
                    <Controller
                      control={form.control}
                      name="slug"
                      render={({ field }) => (
                        <div className="flex h-[38px] items-center overflow-hidden rounded-sm border border-border-strong bg-surface-sunken">
                          <span className="whitespace-nowrap pl-3 pr-0.5 font-mono text-ui-sm text-text-tertiary">
                            {orgHost()}/
                          </span>
                          <SettingsInput
                            className="h-full min-w-0 flex-1 border-0 bg-transparent pl-0.5 pr-3 font-mono text-ui-sm text-text-primary outline-none"
                            name={field.name}
                            ref={field.ref}
                            value={field.value}
                            // A draft, so a hyphen can be typed: trimming it on every keystroke made
                            // `acme-` into `acme` before the next letter arrived (#5453). The dash at
                            // the end is trimmed on blur and by the schema on save.
                            onChange={(e) => field.onChange(slugifyDraft(e.target.value))}
                            onBlur={() => {
                              field.onChange(finishSlugDraft(field.value));
                              field.onBlur();
                            }}
                            aria-invalid={errors.slug ? true : undefined}
                            aria-describedby={errors.slug ? ids.slug : undefined}
                            autoComplete="off"
                          />
                        </div>
                      )}
                    />
                    {errors.slug ? (
                      <FieldError id={ids.slug} message={errors.slug.message} />
                    ) : (
                      <span className="font-mono text-ui-2xs text-text-tertiary">
                        Lowercase, numbers and hyphens.
                      </span>
                    )}
                  </SettingsField>
                  <SettingsField
                    label="Description"
                    hint="Optional. A short line for teammates and audit context."
                  >
                    <SettingsTextarea
                      className={cn(settingsControl, "min-h-16 resize-y py-2.5 leading-normal")}
                      placeholder="What does this organization manage?"
                      maxLength={ORG_DESCRIPTION_MAX_LENGTH}
                      aria-invalid={errors.description ? true : undefined}
                      aria-describedby={errors.description ? ids.description : undefined}
                      {...form.register("description")}
                    />
                    <FieldError id={ids.description} message={errors.description?.message} />
                  </SettingsField>
                  <SettingsField
                    label="Primary address"
                    hint="Set from billing checkout when you opt to reuse the billing address."
                  >
                    {settings.primaryAddress ? (
                      // Set from checkout, not here — so plain text, not the input surface (#6117).
                      <ReadOnlyValue>
                        <address className="not-italic leading-relaxed">
                          {formatPrimaryAddress(settings.primaryAddress)}
                        </address>
                      </ReadOnlyValue>
                    ) : (
                      <span className="font-mono text-ui-xs text-text-tertiary">
                        Not set — check &ldquo;use as primary address&rdquo; during checkout.
                      </span>
                    )}
                  </SettingsField>
                </div>
                <SettingsCardFoot note="Applies across the console">{saveBtn}</SettingsCardFoot>
              </SettingsPanel>
            </SettingsSection>

            <SettingsSection title="Defaults">
              <SettingsPanel>
                <div className="py-1">
                  <SettingsField
                    label="Data region"
                    hint="Residency for the control plane and Project state."
                  >
                    <Controller
                      control={form.control}
                      name="region"
                      render={({ field }) => (
                        <SettingsSelect
                          value={field.value}
                          onChange={field.onChange}
                          options={REGIONS.map((r) => ({ value: r.split(" ")[0], label: r }))}
                        />
                      )}
                    />
                    <span className="font-mono text-ui-2xs text-text-tertiary">
                      Region migration requires a support request.
                    </span>
                  </SettingsField>
                  <SettingsField
                    label="Default Project environment"
                    hint="Pre-selected stage for newly planted Projects."
                  >
                    <Controller
                      control={form.control}
                      name="defaultEnv"
                      render={({ field }) => (
                        <SettingsSelect
                          value={field.value}
                          onChange={field.onChange}
                          options={ENVS.map((en) => ({ value: en, label: en }))}
                        />
                      )}
                    />
                  </SettingsField>
                  <SettingsField
                    label="Terraform version"
                    hint="Pinned across runners unless a Project overrides it."
                  >
                    <SettingsInput
                      className={cn(settingsControl, settingsControlSize, "font-mono text-ui-sm")}
                      autoComplete="off"
                      maxLength={TERRAFORM_VERSION_MAX_LENGTH}
                      aria-invalid={errors.terraformVersion ? true : undefined}
                      aria-describedby={errors.terraformVersion ? ids.terraformVersion : undefined}
                      {...form.register("terraformVersion")}
                    />
                    <FieldError id={ids.terraformVersion} message={errors.terraformVersion?.message} />
                  </SettingsField>
                </div>
                <SettingsCardFoot note="Applies to new resources only">{saveBtn}</SettingsCardFoot>
              </SettingsPanel>
            </SettingsSection>
          </SettingsColumns>
        </fieldset>
      </form>

      <SettingsSection title="Danger zone" className="mb-0">
        <SettingsPanel danger>
          <SettingsDangerRow
            title="Transfer ownership"
            description="Move this organization to another owner. They take over billing and the Owner role."
          >
            {/* Not built yet. It used to be a live button whose click only toasted "coming soon",
                which reads as a control that works (#4996); disabled, it says why through
                DisabledReason — a disabled button's own `title` is never shown. */}
            <DisabledReason reason="Ownership transfer is coming soon">
              <Button variant="outline" size="sm">
                Transfer
              </Button>
            </DisabledReason>
          </SettingsDangerRow>
          <SettingsDangerRow
            title="Delete organization"
            description={
              <>
                Permanently delete{" "}
                {/* A name with no spaces in it must still wrap inside the card (F014). */}
                <span className="[overflow-wrap:anywhere]">{settings.name}</span> and all its
                Projects. This destroys no cloud resources — run destroy first. Cannot be undone.
              </>
            }
          >
            {!canDelete ? (
              <DisabledReason reason={DELETE_REFUSED}>
                <Button variant="outline" size="sm" aria-label="Delete organization" disabled>
                  Delete
                </Button>
              </DisabledReason>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    // The name says WHAT it deletes. The dialog this opens is titled "Delete
                    // organization"; a trigger announced only "Delete" disagreed with its own
                    // dialog, on a control that cannot be undone (#4462).
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Delete organization"
                      disabled={remove.isPending}
                    >
                      {remove.isPending ? "Deleting…" : "Delete"}
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete this organization?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently deletes the organization, its members, and its access
                      grants. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        if (!remove.isPending) remove.mutate({});
                      }}
                      disabled={remove.isPending}
                      variant="destructive"
                    >
                      Delete organization
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </SettingsDangerRow>
        </SettingsPanel>
      </SettingsSection>
    </div>
  );
}
