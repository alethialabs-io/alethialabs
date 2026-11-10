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

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useId } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { removeProject, renameProject } from "@/app/server/actions/project-settings";
import { ClassificationControl } from "@/components/classification/classification-control";
import { RegionError } from "@/components/errors/region-error";
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
import { ReadOnlyValue } from "@repo/ui/read-only-value";
import { cn } from "@repo/ui/utils";

const nameForm = z.object({ name: projectNameSchema });
type NameForm = z.input<typeof nameForm>;

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
    onValidationError: (fields) => {
      // Carries the SERVER's refusal (a name another project holds) as well as the schema's.
      const message = fields.name?.[0] ?? fields.projectId?.[0];
      if (message) form.setError("name", { type: "server", message });
    },
    onSuccess: (saved) => form.reset({ name: saved.project_name }),
  });

  const remove = useActionMutation(removeProject, {
    invalidates: [orpc.workspace.projects.key()],
    successMessage: "Project deleted.",
    onSuccess: () => router.push(`/${orgSlug}`),
  });

  // `mutateAsync` inside `handleSubmit` keeps `isSubmitting` true for the whole round trip, so the
  // button stays disabled until the save settles; a failure is routed by the mutation itself.
  const onSave = form.handleSubmit(async (values) => {
    if (rename.isPending) return;
    await rename.mutateAsync({ projectId: project.id, name: values.name }).catch(() => undefined);
  });

  const busy = isSubmitting || rename.isPending;
  // The live-environment refusal is rendered IN the danger zone as well as toasted — the dialog
  // closes on click, so a toast alone leaves a user who looked away with a page that did nothing.
  const deleteRefusal =
    remove.error && remove.error.error.kind === "conflict" ? remove.error.error.message : null;

  return (
    <div>
      <SettingsSection title="Project profile">
        <SettingsPanel>
          <form noValidate onSubmit={onSave} aria-label="Project settings">
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
              {/* Classification (Workstream B) — chips + a picker for org editors. */}
              <SettingsField
                label="Classification"
                hint="Pin this project's classification values (e.g. Environment, Team)."
              >
                <ClassificationControl kind="project" id={project.id} canEdit />
              </SettingsField>
            </div>
            <SettingsCardFoot note="Applies across the console">
              <Button type="submit" size="sm" disabled={!isDirty || busy}>
                {busy ? "Saving…" : "Save changes"}
              </Button>
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
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  // See org-general.tsx — the trigger agrees with its own dialog (#4462).
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Delete project"
                    disabled={remove.isPending}
                  >
                    {remove.isPending ? "Deleting…" : "Delete"}
                  </Button>
                }
              />
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This permanently deletes the project and its environments, design, and
                    promotion history. Provisioned cloud resources are not touched — destroy the
                    environments first. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      if (!remove.isPending) remove.mutate({ projectId: project.id });
                    }}
                    disabled={remove.isPending}
                    variant="destructive"
                  >
                    {remove.isPending ? "Deleting…" : "Delete project"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SettingsDangerRow>
          {/* The server's reason, kept on the page after the dialog closes. `role="alert"` so a
              screen reader is told too — the visual change is below the fold of the click. */}
          {deleteRefusal && (
            <p role="alert" className="px-1 pb-1 text-ui-xs text-destructive">
              {deleteRefusal}
            </p>
          )}
        </SettingsPanel>
      </SettingsSection>
    </div>
  );
}
