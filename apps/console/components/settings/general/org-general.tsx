"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · General — the authored claude.ai/design panel (Organization profile / Danger zone),
// composed from the shared settings primitives. The Defaults panel (data region, default
// environment, Terraform version) was removed in #7147: nothing read those values.
//
// #6128: the values arrive with the page (`settings.org`, prefetched by the route and hydrated), so
// there is no client fetch on mount and no skeleton after the route's; the form is react-hook-form
// over the SAME zod schema the server action validates (lib/validations/org-general.ts); a save is
// `saveOrgGeneral` through `useActionMutation` — pending, double-submit guarded, field errors inline,
// and every key that shows the org's name invalidated (the switcher reads the workspace context).
// The logo saves itself through its own upload control; ownership transfer is not built yet.
//
// #7204: Leave organization sits in the danger zone beside Delete. It calls better-auth's
// `organization.leave` through the mutation contract (`viaAuth`), confirmed by `ConfirmAction`; the
// org's last ACTIVE owner sees it disabled with the reason, the rule the auth route applies to
// `/organization/leave` (member-guards.ts, lib/authz/active-owner.ts). On success the person lands
// in their next organization, or `/dashboard` resolves where they go when there is none.

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Controller, type FieldPath, useForm } from "react-hook-form";
import {
  deleteOrganization,
  saveOrgGeneral,
} from "@/app/server/actions/org-settings";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useLeavePageGuard } from "@/components/confirm/use-unsaved-guard";
import { RegionError } from "@repo/ui/region-error";
import { OrgLogoUpload } from "@/components/org/org-logo-upload";
import { GeneralRefusal } from "@/components/settings/general/general-states";
import { viaAuth } from "@/components/settings/members/auth-action";
import {
  ORG_CONTROL_NOTES,
  ORG_DANGER_ROWS,
  ORG_GENERAL_SECTIONS,
  ORG_PROFILE_ROWS,
  ORG_PROFILE_SAVE_NOTE,
  ORG_PROFILE_UNSAVED_NOTE,
} from "@/components/settings/general/org-general-copy";
import { OrgGeneralSkeleton } from "@/components/settings/general/org-general-skeleton";
import {
  SettingsCardFoot,
  SettingsColumns,
  SettingsDangerRow,
  SettingsField,
  SettingsInput,
  SettingsPanel,
  SettingsSection,
  SettingsTextarea,
  settingsControl,
  settingsControlSize,
} from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { FieldErrors } from "@/lib/actions/result";
import { authClient } from "@/lib/auth/client";
import { toPdpRole } from "@/lib/authz/org-access-control";
import type { OrgPrimaryAddress, OrgSettings } from "@/lib/org/settings";
import { orgHost } from "@/lib/org-url";
import { orgHref } from "@/lib/routing";
import { orpc } from "@/lib/rpc/client";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { finishSlugDraft, slugifyDraft } from "@/lib/utils/slugify";
import {
  ORG_DESCRIPTION_MAX_LENGTH,
  ORG_NAME_MAX_LENGTH,
  type OrgGeneralInput,
  type OrgGeneralValues,
  orgGeneralSchema,
} from "@/lib/validations/org-general";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { EmptyState } from "@repo/ui/empty";
import { ReadOnlyValue } from "@repo/ui/read-only-value";
import { cn } from "@repo/ui/utils";

/** Why Save is disabled for anyone but the owner (the plugin updates the org for the owner only). */
const EDIT_REFUSED = "Only the organization's owner can change these settings";
/** Why Delete is disabled for anyone but the owner (better-auth deletes the org for the owner only). */
const DELETE_REFUSED = "Only the organization's owner can delete it";

/**
 * What the delete confirmation says before anything is sent: the rule the server applies
 * (`deleteOrganization` refuses while an environment is live or in flight), then what the delete
 * does and does not do.
 */
const DELETE_RULE =
  "An organization with a live or in-flight environment cannot be deleted: destroy those environments first. This cannot be undone.";

/** Why Leave is disabled for the org's last active owner — the auth route refuses that leave. */
const LEAVE_SOLE_OWNER =
  "You are this organization's only active owner. Make another active member an owner before you leave.";
/** Why Leave is disabled while the org's owners are being read. */
const LEAVE_CHECKING = "Checking whether another active owner remains";
/** Why Leave is disabled when the page does not know which organization it is on. */
const LEAVE_UNKNOWN_ORG = "Reload the page to leave this organization";

/** What the leave confirmation says before anything is sent. */
const LEAVE_RULE =
  "You lose access to its Projects and settings right away. To come back, someone in the organization has to invite you again.";

/**
 * Where the person lands after leaving `leftOrgId`: their next organization that has an address,
 * else `/dashboard`, which resolves their primary organization or their personal workspace.
 */
function leaveDestination(
  organizations: readonly { id: string; slug: string | null }[],
  leftOrgId: string,
): string {
  const next = organizations.find((o) => o.id !== leftOrgId && o.slug);
  return next?.slug ? orgHref(next.slug) : "/dashboard";
}

/**
 * Whether the caller is the org's last active owner: an owner by `toPdpRole`, and no more than one
 * active member of the org holds that role (the caller's own row is one of them). The same count
 * `removalOwnerRefusal` makes on the server.
 */
function isSoleActiveOwner(
  callerRole: string,
  members: readonly { role: string; status: string }[],
): boolean {
  if (toPdpRole(callerRole) !== "owner") return false;
  const activeOwners = members.filter(
    (m) => m.status === "active" && toPdpRole(m.role) === "owner",
  );
  return activeOwners.length <= 1;
}

/** What the delete removes and what it leaves, listed in the typed confirmation. */
const DELETE_CONSEQUENCES = [
  "The organization, its Projects, its members and its access grants are removed.",
  "Nothing is destroyed in your cloud accounts.",
] as const;

/** The form's fields — the keys a server field error may name. */
const FORM_FIELDS: readonly FieldPath<OrgGeneralInput>[] = [
  "name",
  "slug",
  "description",
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
        description="This is your personal workspace. An organization's name and URL are set in the organization."
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
  // the cache, never fetched for this. The organization plugin grants `organization: ["update",
  // "delete"]` to the OWNER only (lib/authz/org-access-control.ts — an admin manages members and
  // invitations, not the org itself); the server still decides (this only saves a refused round trip). An
  // unknown role (no context cached) leaves the controls enabled for the server to rule on.
  const context = useQuery(orpc.workspace.context.queryOptions({ enabled: false }));
  const role =
    context.data?.organizations.find((o) => o.id === context.data?.activeOrgId)?.role ?? null;
  const canEdit = role === null || role === "owner";
  const canDelete = role === null || role === "owner";

  // Leave: an owner may leave only while another ACTIVE owner remains, so an owner's page reads the
  // org's members (the shared `members.list` universe) to know before the click. Anyone else may
  // always leave, and reads nothing for it. An unreadable member list leaves the control enabled
  // for the auth route to rule on; it refuses the last active owner with its own sentence.
  const orgId = context.data?.activeOrgId ?? null;
  const callerIsOwner = role !== null && toPdpRole(role) === "owner";
  const members = useQuery(
    orpc.members.list.queryOptions({ input: undefined, enabled: callerIsOwner }),
  );
  const leaveRefusal =
    orgId === null
      ? LEAVE_UNKNOWN_ORG
      : callerIsOwner && members.isPending
        ? LEAVE_CHECKING
        : role !== null && members.data && isSoleActiveOwner(role, members.data)
          ? LEAVE_SOLE_OWNER
          : null;
  // Where to land is decided from the orgs the switcher lists, before the membership is gone.
  const leaveTarget =
    orgId === null ? "/dashboard" : leaveDestination(context.data?.organizations ?? [], orgId);

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

  // The typed confirmation is open; the dialog stays mounted and is driven by this.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const remove = useActionMutation(deleteOrganization, {
    // The org is gone, so nothing under this address can be read again; `/dashboard` resolves the
    // next org and its own cache. Invalidating here would only refetch into a refusal.
    invalidates: [],
    successMessage: "Organization deleted.",
    onSuccess: () => router.push("/dashboard"),
  });

  // The leave confirmation is open; driven the same way as the delete's.
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const leave = useActionMutation(
    ({ organizationId }: { organizationId: string }) =>
      viaAuth(() => authClient.organization.leave({ organizationId })),
    {
      // The membership is gone, so this org's reads would only answer with a refusal; the
      // destination's own server render fills its cache. Nothing here is invalidated.
      invalidates: [],
      successMessage: `You left ${settings.name}.`,
      onSuccess: () => router.push(leaveTarget),
    },
  );

  // `mutateAsync` inside `handleSubmit` keeps `isSubmitting` true until the save has settled, so
  // the buttons stay disabled for the whole round trip — three rapid clicks are one save (F015).
  // A failure is already routed by the mutation (field errors, or one toast), so it is not rethrown.
  const onSubmit = form.handleSubmit(async (values) => {
    if (save.isPending) return;
    await save.mutateAsync(values).catch(() => undefined);
  });

  const busy = isSubmitting || save.isPending;
  // Unsaved profile edits are not dropped silently (R6 E-17): a reload or a closed tab asks first and
  // the Save band says so — the same page-level guard Preview settings use. A save resets the form.
  const unsaved = isDirty && canEdit;
  useLeavePageGuard(unsaved);
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
            button says why. */}
        <fieldset disabled={!canEdit} className="m-0 min-w-0 border-0 p-0">
          <SettingsColumns>
            <SettingsSection title={ORG_GENERAL_SECTIONS.profile}>
              <SettingsPanel>
                <div className="py-1">
                  <SettingsField
                    label={ORG_PROFILE_ROWS.logo.label}
                    hint={ORG_PROFILE_ROWS.logo.hint}
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
                    label={ORG_PROFILE_ROWS.name.label}
                    hint={ORG_PROFILE_ROWS.name.hint}
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
                    label={ORG_PROFILE_ROWS.slug.label}
                    hint={ORG_PROFILE_ROWS.slug.hint}
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
                        {ORG_CONTROL_NOTES.slug}
                      </span>
                    )}
                  </SettingsField>
                  <SettingsField
                    label={ORG_PROFILE_ROWS.description.label}
                    hint={ORG_PROFILE_ROWS.description.hint}
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
                    label={ORG_PROFILE_ROWS.address.label}
                    hint={ORG_PROFILE_ROWS.address.hint}
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
                <SettingsCardFoot note={unsaved ? ORG_PROFILE_UNSAVED_NOTE : ORG_PROFILE_SAVE_NOTE}>
                  {saveBtn}
                </SettingsCardFoot>
              </SettingsPanel>
            </SettingsSection>
          </SettingsColumns>
        </fieldset>
      </form>

      <SettingsSection title={ORG_GENERAL_SECTIONS.danger} className="mb-0">
        <SettingsPanel danger>
          <SettingsDangerRow
            title={ORG_DANGER_ROWS.transfer.title}
            description={ORG_DANGER_ROWS.transfer.description}
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
            title={ORG_DANGER_ROWS.leave.title}
            description={ORG_DANGER_ROWS.leave.description}
          >
            {leaveRefusal ? (
              <DisabledReason reason={leaveRefusal}>
                <Button variant="outline" size="sm" aria-label="Leave organization" disabled>
                  Leave
                </Button>
              </DisabledReason>
            ) : (
              // Named for what it leaves, as Delete is: the dialog it opens says "Leave <org>?".
              <Button
                variant="outline"
                size="sm"
                aria-label="Leave organization"
                disabled={leave.isPending}
                onClick={() => setConfirmingLeave(true)}
              >
                {leave.isPending ? "Leaving…" : "Leave"}
              </Button>
            )}
          </SettingsDangerRow>
          <SettingsDangerRow
            title={ORG_DANGER_ROWS.delete.title}
            description={
              <>
                {ORG_DANGER_ROWS.delete.before}{" "}
                {/* A name with no spaces in it must still wrap inside the card (F014). */}
                <span className="[overflow-wrap:anywhere]">{settings.name}</span>{" "}
                {ORG_DANGER_ROWS.delete.after}
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
              // The name says WHAT it deletes. The dialog this opens is titled "Delete this
              // organization?"; a trigger announced only "Delete" disagreed with its own dialog, on
              // a control that cannot be undone (#4462).
              <Button
                variant="outline"
                size="sm"
                aria-label="Delete organization"
                disabled={remove.isPending}
                onClick={() => setConfirmingDelete(true)}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </Button>
            )}
          </SettingsDangerRow>
        </SettingsPanel>
      </SettingsSection>

      {/* The console's one confirmation, at the destroy level (CON-SM2): the consequences are
          listed and Delete stays disabled until the organization's name is typed. It stays open
          while the delete runs, and stays up beside the reason when the server refuses — the
          commonest refusal being a live environment. */}
      <ConfirmAction
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this organization?"
        description={DELETE_RULE}
        confirmLabel="Delete organization"
        pendingLabel="Deleting…"
        severity={{ level: "destroy", subject: settings.name, consequences: DELETE_CONSEQUENCES }}
        mutation={remove}
        variables={confirmingDelete ? {} : null}
      />

      {/* A yes/no question: leaving removes the person's own access, not the organization, and
          an admin can invite them back. It stays up beside the reason when the server refuses. */}
      <ConfirmAction
        open={confirmingLeave}
        onOpenChange={setConfirmingLeave}
        title={`Leave ${settings.name}?`}
        description={LEAVE_RULE}
        confirmLabel="Leave organization"
        pendingLabel="Leaving…"
        severity={{ level: "confirm" }}
        mutation={leave}
        variables={confirmingLeave && orgId !== null ? { organizationId: orgId } : null}
      />
    </div>
  );
}
