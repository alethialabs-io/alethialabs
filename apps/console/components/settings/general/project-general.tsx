"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Project · Settings · General — the project-native counterpart of OrgGeneral. Rename the project
// (the slug stays stable so URLs don't break) and a danger-zone delete, composed from the shared
// settings primitives.
//
// #6128: the project arrives with the page (`settings.project`, prefetched and hydrated); rename
// and delete are `renameProject` / `removeProject` through `useActionMutation` — pending, guarded
// against a double submit, refusals under the field, and the shell's project list invalidated, so
// the switcher, breadcrumb and palette show the new name at once (F040). Delete refuses
// server-side while any environment is live — destroy those first.
//
// R6 F-11 (#6824): the read carries the viewer's edit and delete decisions, asked with the same
// questions the writes ask. A viewer who may not rename sees the form read-only with Save disabled
// and the reason beside it; one who may not delete sees Delete disabled with the reason. Nothing is
// left enabled only to be refused, and nothing is hidden without a word.

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { removeProject, renameProject } from "@/app/server/actions/project-settings";
import { ClassificationControl } from "@/components/classification/classification-control";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { FormRootError } from "@/components/forms/form-root-error";
import { manageReason, MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { RegionError } from "@repo/ui/region-error";
import {
  GeneralRefusal,
  ProjectGeneralSkeleton,
} from "@/components/settings/general/general-states";
import {
  SettingsCardFoot,
  SettingsDangerRow,
  SettingsField,
  SettingsInput,
  SettingsPanel,
  SettingsSection,
  settingsControl,
  settingsControlSize,
} from "@/components/settings/settings-ui";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";
import type { ProjectGeneral as ProjectGeneralRow } from "@/lib/rpc/procedures/settings";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { PROJECT_NAME_MAX_LENGTH } from "@/lib/validations/project-form.schema";
import { projectNameSchema } from "@/lib/validations/project-name";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { ReadOnlyValue } from "@repo/ui/read-only-value";
import { cn } from "@repo/ui/utils";

const nameForm = z.object({ name: projectNameSchema });
type NameForm = z.input<typeof nameForm>;

/**
 * What the delete confirmation says before anything is sent: what goes, and the rule the server
 * applies (`removeProject` refuses while an environment is live or in flight).
 */
const DELETE_RULE = "This permanently deletes the project. This cannot be undone.";

/** What the typed delete confirmation lists above the name field. */
const DELETE_CONSEQUENCES = [
  "Its environments, design, and promotion history are removed.",
  "Provisioned cloud resources are not touched — destroy the environments first.",
] as const;

/**
 * The project General settings page body. Four renders, never confused (RUBRIC B4): the form, a
 * refusal (forbidden), an error with a retry, and "gone" — a project deleted or renamed away while
 * the page was open, which the `projects` topic brings here. The skeleton shows only if the
 * server's prefetch did not land.
 */
export function ProjectGeneral({ project, orgSlug }: { project: string; orgSlug: string }) {
  const query = useQuery(
    orpc.settings.project.queryOptions({ input: { project }, retry: retryUnlessRefused }),
  );

  if (query.data === undefined) {
    if (query.isError) {
      const refusal = readRefusalOf(query.error);
      if (refusal) return <GeneralRefusal refusal={refusal} />;
      return (
        <RegionError title="Couldn't load project settings" onRetry={() => void query.refetch()} />
      );
    }
    return <ProjectGeneralSkeleton />;
  }

  if (query.data === null) {
    return (
      <GeneralRefusal
        refusal="not-found"
        title="This project is gone"
        description="It was deleted, or its address changed, while this page was open."
      />
    );
  }

  return <ProjectGeneralForm project={query.data} orgSlug={orgSlug} />;
}

/** The rename form and danger zone, over a loaded project. */
function ProjectGeneralForm({
  project,
  orgSlug,
}: {
  project: ProjectGeneralRow;
  orgSlug: string;
}) {
  const router = useRouter();
  const nameErrorId = useId();
  const form = useForm<NameForm>({
    resolver: zodResolver(nameForm),
    defaultValues: { name: project.project_name },
  });
  const { errors, isDirty, isSubmitting } = form.formState;

  // A rename by someone else arrives through the `projects` topic; a pristine form follows it, a
  // form with an edit in it is left alone.
  useEffect(() => {
    if (!form.formState.isDirty) form.reset({ name: project.project_name });
  }, [project.project_name, form]);

  const rename = useActionMutation(renameProject, {
    // Every key that shows this project's name: this page, and the shell's list (the switcher,
    // breadcrumbs, palette and project list read `workspace.projects`).
    invalidates: [orpc.settings.project.key(), orpc.workspace.projects.key()],
    successMessage: "Project updated.",
    // The SERVER's refusal (a name another project holds) lands under the name field; a message
    // about anything else lands in the form's root error rather than nowhere.
    form: { instance: form, fields: ["name"] },
    onSuccess: (saved) => form.reset({ name: saved.project_name }),
  });

  // The confirmation is open; the dialog stays mounted and is driven by this.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const remove = useActionMutation(removeProject, {
    // The project is gone, so its own reads would only refetch into a 404; the shell's list is
    // what still shows it.
    invalidates: [orpc.workspace.projects.key()],
    successMessage: "Project deleted.",
    onSuccess: () => router.push(`/${orgSlug}`),
  });

  // `mutateAsync` inside `handleSubmit` keeps `isSubmitting` true for the whole round trip, so the
  // button stays disabled until the save settles; a failure is routed by the mutation itself.
  const onSave = form.handleSubmit(async (values) => {
    if (rename.isPending || !project.canManage) return;
    await rename.mutateAsync({ projectId: project.id, name: values.name }).catch(() => undefined);
  });

  const busy = isSubmitting || rename.isPending;
  const editReason = manageReason(project);
  const deleteReason = project.canDelete ? null : MANAGE_DENIED_REASON;
  // The live-environment refusal is rendered IN the danger zone as well as toasted, so it is still
  // on the page after the confirmation is dismissed.
  const deleteRefusal =
    remove.error && remove.error.error.kind === "conflict" ? remove.error.error.message : null;

  return (
    <div>
      <SettingsSection title="Project profile">
        <SettingsPanel>
          <form noValidate onSubmit={onSave} aria-label="Project settings">
            {/* A viewer who may not rename cannot edit either: the field is read-only, and Save
                says why. */}
            <fieldset disabled={!project.canManage} className="m-0 min-w-0 border-0 p-0">
              <div className="py-1">
                <SettingsField label="Project name" hint="Shown across the console and the CLI.">
                  <SettingsInput
                    className={cn(settingsControl, settingsControlSize)}
                    autoComplete="off"
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                    aria-invalid={errors.name ? true : undefined}
                    aria-describedby={errors.name ? nameErrorId : undefined}
                    {...form.register("name")}
                  />
                  {errors.name && (
                    // `role="alert"`: a rename refused by the server changes nothing else on screen.
                    <span id={nameErrorId} role="alert" className="text-ui-xs text-destructive">
                      {errors.name.message}
                    </span>
                  )}
                </SettingsField>
                <SettingsField
                  label="Project URL"
                  hint="The slug in this project's URLs — kept stable across renames."
                >
                  {/* Read-only, so NOT on the input surface (#6117, F039): a sunken bordered box
                      beside the editable name field read as a second field that ignored clicks. */}
                  <ReadOnlyValue mono>
                    /{orgSlug}/{project.slug ?? "—"}
                  </ReadOnlyValue>
                </SettingsField>
                {/* Classification (Workstream B) — chips, and a picker for a viewer who may edit
                    this project (the control also requires the org's classification edit). */}
                <SettingsField
                  label="Classification"
                  hint="Pin this project's classification values (e.g. Environment, Team)."
                >
                  <ClassificationControl kind="project" id={project.id} canEdit={project.canManage} />
                </SettingsField>
              </div>
            </fieldset>
            <FormRootError form={form} className="mx-[22px] mb-3" />
            <SettingsCardFoot note="Applies across the console">
              <DisabledReason reason={editReason}>
                <Button type="submit" size="sm" disabled={!isDirty || busy}>
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </DisabledReason>
            </SettingsCardFoot>
          </form>
        </SettingsPanel>
      </SettingsSection>

      <SettingsSection title="Danger zone" className="mb-0">
        <SettingsPanel danger>
          <SettingsDangerRow
            title="Delete project"
            description={
              <>
                Permanently delete{" "}
                {/* A name with no spaces in it must still wrap inside the card (F014). */}
                <span className="[overflow-wrap:anywhere]">{project.project_name}</span>, its
                environments, design, and history. This destroys no cloud resources — destroy the
                environments first. Cannot be undone.
              </>
            }
          >
            {/* The name says WHAT it deletes: the dialog is titled "Delete this project?", and a
                trigger announced only as "Delete" disagreed with it (#4462). */}
            <DisabledReason reason={deleteReason}>
              <Button
                variant="outline"
                size="sm"
                aria-label="Delete project"
                disabled={remove.isPending}
                onClick={() => setConfirmingDelete(true)}
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </Button>
            </DisabledReason>
          </SettingsDangerRow>
          {/* The server's reason, kept on the page after the dialog is dismissed. `role="alert"`
              so a screen reader is told too. */}
          {deleteRefusal && (
            <p role="alert" className="px-1 pb-1 text-ui-xs text-destructive">
              {deleteRefusal}
            </p>
          )}
        </SettingsPanel>
      </SettingsSection>

      {/* The console's one confirmation (CON-SM2), at the destroy severity (#7198): Delete project
          stays disabled until the project's name is typed. It stays open while the delete runs,
          closes itself on success, and stays up beside the toast when the server refuses. */}
      <ConfirmAction
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title="Delete this project?"
        description={DELETE_RULE}
        confirmLabel="Delete project"
        pendingLabel="Deleting…"
        severity={{
          level: "destroy",
          subject: project.project_name,
          consequences: DELETE_CONSEQUENCES,
        }}
        mutation={remove}
        variables={confirmingDelete ? { projectId: project.id } : null}
      />
    </div>
  );
}
