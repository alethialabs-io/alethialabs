// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var runnerCmd = &cobra.Command{
	Use:   "runner",
	Short: "Add, list and remove the runners that execute your jobs",
	Long: fmt.Sprintf(`A runner is the process that executes infrastructure jobs: every deploy, preview and
destroy is claimed and run by one.

Start with "alethia runner list". On the hosted control plane the managed fleet runs your jobs
and you need no runner of your own. To add one of your own:

  alethia runner register   A runner you run yourself, on any cloud. This is the first runner
                            of an organization with none: it needs nothing to exist already.
  alethia runner deploy     Alethia builds the runner inside your %s account. Building a
                            runner is itself a job, so this needs a runner that is already
                            online (or the managed fleet) to run it.

"alethia runner destroy" tears a deployed runner's cloud resources down; "alethia runner
remove" deletes a runner's record and tears nothing down.`, runners.DeployProvidersLabel()),
}

func init() {
	rootCmd.AddCommand(runnerCmd)
}

// runnerLister is the slice of the API client the runner-group resolvers need — kept small so
// resolution is unit-testable with a fake (the concrete *api.Client satisfies it), and so the
// group needs no edit to the shared apiClient interface.
type runnerLister interface {
	GetRunners() ([]api.Runner, error)
}

// resolveRunnerRef maps a runner reference — its NAME or its id — to the id the API wants.
// An empty ref returns empty, so the caller's own "then ask" arm runs.
//
// This is the handoff removal for the group. Every runner command used to take an opaque id a
// reader had to copy out of `alethia runner list`, which is the manual step this programme
// exists to delete; a name is what the operator already knows.
//
// An id is never RESHAPED — the value returned is the listed runner's own `ID` field, byte for
// byte — and both failure modes are loud:
//
//   - no match lists the names that do exist, so a typo is a correction and not a server 404;
//   - two matches is a hard error naming both ids. Nothing stops two runners sharing a name,
//     and the callers of this function DESTROY and REMOVE what it returns. Choosing the first
//     match would tear down a plausible, wrong runner and report success.
//
// flag names the flag being resolved, because the same resolver serves `--runner` and
// `--assigned-runner` and "runner %q not found" alone does not say which one was wrong.
func resolveRunnerRef(c runnerLister, flag, ref string) (string, error) {
	if ref == "" {
		return "", nil
	}
	list, err := c.GetRunners()
	if err != nil {
		return "", fmt.Errorf("resolve %s %q: %w", flag, ref, err)
	}
	var matches []api.Runner
	for _, r := range list {
		if r.ID == ref {
			return r.ID, nil
		}
		if r.Name == ref {
			matches = append(matches, r)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0].ID, nil
	case 0:
		return "", refusal(clierr.CodeNotFound, "alethia runner list",
			"%s: no runner named %q (have: %s)", flag, ref, knownRunnerNames(list))
	default:
		ids := make([]string, len(matches))
		for i, m := range matches {
			ids[i] = m.ID
		}
		sort.Strings(ids)
		return "", refusal(clierr.CodeValidationFailed, "alethia runner list --output json",
			"%s: runner name %q is ambiguous — %d runners share it (%s). Pass the id instead",
			flag, ref, len(matches), strings.Join(ids, ", "))
	}
}

// knownRunnerNames renders the runner names a resolution failure should offer, sorted and
// de-duplicated so a name shared by two runners is offered once.
func knownRunnerNames(list []api.Runner) string {
	seen := map[string]bool{}
	names := make([]string, 0, len(list))
	for _, r := range list {
		if r.Name == "" || seen[r.Name] {
			continue
		}
		seen[r.Name] = true
		names = append(names, r.Name)
	}
	if len(names) == 0 {
		return "none — register one with `alethia runner register`"
	}
	sort.Strings(names)
	return strings.Join(names, ", ")
}

// runnerIDFrom resolves the runner a command acts on from the PAIR of inputs that name it.
//
// TWO inputs for one field, which needs its reason stated — the same reason jobProjectFlags
// records for `--project` / `--project-id`. The id form is what these commands have always
// taken and scripts pass it; removing it for a tidier surface would break them. The ref form
// is the one a person uses, takes the name, and is what the docs now show.
//
// Passing both is an ERROR and not a precedence rule. They name the same field, so a caller who
// set both either believes one is being ignored or has an unnoticed leak from a wrapper script —
// and the command they are calling is `destroy`. Silently preferring one would let the wrong
// belief survive until it had torn down the other runner.
func runnerIDFrom(c runnerLister, ref, id, refFlag, idFlag string) (string, error) {
	if ref != "" && id != "" {
		return "", refusal(clierr.CodeInvalidUsage, "",
			"%s and %s both name the runner: pass one (%s takes the name or the id)",
			refFlag, idFlag, refFlag)
	}
	if ref != "" {
		return resolveRunnerRef(c, refFlag, ref)
	}
	return id, nil
}

// runnerDeployIdentityID resolves the cloud account a deploy targets, from the same pair shape:
// a LABEL-or-id ref, or the raw id form scripts already pass.
//
// The ref form is narrowed to the clouds a runner can actually be built into — the same
// narrowing selectRunnerDeployCloudIdentity applies to the picker. A flag path that skipped it
// would make the two halves of one field disagree: the picker cannot offer a GCP account and
// the flag would have accepted one, so the refusal would arrive from the server instead of from
// the command line that is already wrong. The raw id form is passed through unresolved, exactly
// as `--project-id` is, and stays the server's to reject.
func runnerDeployIdentityID(c cloudIdentityLister, ref, id string) (string, error) {
	if ref != "" && id != "" {
		return "", errBothCloudAccountForms()
	}
	if ref == "" {
		return id, nil
	}
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return "", fmt.Errorf("resolve --cloud-account %q: %w", ref, err)
	}
	deployable := runners.FilterDeployable(identities)
	var matches []api.CloudIdentity
	for _, cid := range deployable {
		if cid.ID == ref {
			return cid.ID, nil
		}
		if cid.Label == ref {
			matches = append(matches, cid)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0].ID, nil
	case 0:
		// Naming the two lists separately is the whole value of the message: "you have no such
		// account" and "you have that account and a runner cannot be built into it" have
		// different next steps, and only the second one points at `runner register`.
		for _, cid := range identities {
			if cid.ID == ref || cid.Label == ref {
				return "", errRunnerDeployUnsupported(ref, cid.Provider)
			}
		}
		return "", refusal(clierr.CodeNotFound, "alethia connector list",
			"cloud account %q not found (deployable: %s)", ref, knownDeployableLabels(deployable))
	default:
		ids := make([]string, len(matches))
		for i, m := range matches {
			ids[i] = m.ID
		}
		sort.Strings(ids)
		return "", refusal(clierr.CodeValidationFailed, "alethia connector list --output json",
			"cloud account label %q is ambiguous — %d accounts share it (%s). Pass the id instead",
			ref, len(matches), strings.Join(ids, ", "))
	}
}

// errBothCloudAccountForms is the refusal for a command line that names the cloud account twice.
func errBothCloudAccountForms() error {
	return refusal(clierr.CodeInvalidUsage, "",
		"--cloud-account and --cloud-identity-id both name the cloud account: pass one "+
			"(--cloud-account takes the label or the id)")
}

// errRunnerDeployUnsupported is the one sentence for a deploy asked of a cloud Alethia cannot
// build a runner in, with the command that works there instead. Nothing was sent.
func errRunnerDeployUnsupported(ref, provider string) error {
	return refusal(clierr.CodeValidationFailed, "alethia runner register",
		"cloud account %q: %s", ref, runners.UnsupportedMessage(provider))
}

// knownDeployableLabels renders the labels a deploy can actually target.
func knownDeployableLabels(identities []api.CloudIdentity) string {
	if len(identities) == 0 {
		return fmt.Sprintf("none — a deployed runner needs %s, so use `alethia runner register` instead",
			runners.DeployProvidersLabel())
	}
	labels := make([]string, 0, len(identities))
	for _, id := range identities {
		labels = append(labels, id.Label)
	}
	sort.Strings(labels)
	return strings.Join(labels, ", ")
}

// runnerAskOrDefault fills one optional free-text field: it asks on a terminal, and under
// --no-input takes the default WITHOUT opening a form.
//
// The second half is the fix. `runner deploy --no-input` reached huh for the name and the
// region even though both have a default, and huh answered `could not open a new TTY` — so a
// command whose every field had a default could not be scripted at all. Taking the default is
// what pressing Enter through the form already does, so the two paths now agree; the default is
// announced rather than applied silently, because a region chosen for you is a region you must
// be able to see in a CI log.
func runnerAskOrDefault(target *string, title, description, def string) error {
	if *target != "" {
		return nil
	}
	if !canPromptForm() {
		*target = def
		printer.Note(fmt.Sprintf("%s: %s (default)", title, def))
		return nil
	}
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewInput().
				Title(title).
				Description(description).
				Value(target).
				Placeholder(def),
		),
	); err != nil {
		return err
	}
	if *target == "" {
		*target = def
	}
	return nil
}

// ── what runs a runner job ────────────────────────────────────────────────────────────────

// runnerJobExecutor checks that something can run a DEPLOY_RUNNER or DESTROY_RUNNER job before
// one is queued, and refuses with the next step when nothing can.
//
// Building a runner and tearing one down are jobs, and a job is run by a runner. So an
// organization with no runner online cannot deploy its first one, and a runner cannot tear itself
// down: the job would be queued and never start. The rule is the one `alethia up` applies before a
// deploy (ensureRunner): a runner that is online, else the managed fleet where there is one.
//
// assignedID is the executor the caller named, or empty. excludeID is the runner the job is
// about, which cannot be its own executor; empty for a deploy. verb is what the job does, for the
// sentence.
func runnerJobExecutor(c runnerSource, list []api.Runner, verb, assignedID, excludeID string) error {
	if assignedID != "" {
		i := slices.IndexFunc(list, func(r api.Runner) bool { return r.ID == assignedID })
		// An id the list does not hold is passed through, as it always was: the control plane
		// answers for it.
		if i >= 0 && list[i].Status != runnerStatusOnline {
			return refusal(clierr.CodeConflict, "alethia runner list",
				"runner %q is %s, so it cannot %s: name one that is online, or omit the flag to leave the job for any that is",
				list[i].Name, list[i].Status, verb)
		}
		return nil
	}
	for _, r := range list {
		if r.ID != excludeID && r.Status == runnerStatusOnline {
			return nil
		}
	}
	if hostedControlPlane(WebOrigin()) || fleetWillStartARunner(c) {
		return nil
	}
	if excludeID != "" {
		return refusal(clierr.CodeConflict, "alethia runner register",
			"nothing can %s: a runner cannot tear itself down, no other runner is online, and %s shows no managed fleet. "+
				"No job was queued. Bring another runner online first (`alethia runner register` adds one you run yourself); "+
				"if the cloud resources are already gone, `alethia runner remove` deletes the record",
			verb, WebOrigin())
	}
	return refusal(clierr.CodeConflict, "alethia runner register",
		"nothing can %s: building a runner is itself a job, no runner is online to run it, and %s shows no managed fleet. "+
			"Nothing was created and no job was queued. Register your first runner instead (`alethia runner register`): "+
			"it provisions nothing, so it needs no runner to exist",
		verb, WebOrigin())
}

// runnerByID returns the listed runner with this id, or false.
func runnerByID(list []api.Runner, id string) (api.Runner, bool) {
	i := slices.IndexFunc(list, func(r api.Runner) bool { return r.ID == id })
	if i < 0 {
		return api.Runner{}, false
	}
	return list[i], true
}

// runnerConfirmName is what a person types to confirm destroying or removing a runner: its name,
// or its id when the list holds no name for it.
func runnerConfirmName(list []api.Runner, id string) string {
	if r, ok := runnerByID(list, id); ok && r.Name != "" {
		return r.Name
	}
	return id
}

// pickRunnerToEnd asks which runner a destroy or a remove is about. With nobody to ask it is the
// refusal that names the flag; "Any available" is the picker's answer for an executor and is not
// a runner, so it is refused too.
func pickRunnerToEnd(token, verb, flagHint string) (string, error) {
	if !canPromptForm() {
		return "", refusal(clierr.CodeInputRequired, "alethia runner list",
			"no runner given: pass %s. Nothing can ask for it (--no-input, stdin is not a terminal, or stderr is redirected)",
			flagHint)
	}
	id, err := selectRunner(token, "")
	if err != nil {
		return "", err
	}
	if id == "" {
		return "", refusal(clierr.CodeInvalidUsage, "alethia runner list",
			"select a specific runner to %s, not %q", verb, "Any available")
	}
	return id, nil
}

// ── the result of a runner job ────────────────────────────────────────────────────────────

// runnerJobRequest is what a runner deploy or destroy would send, as its dry run reports it.
type runnerJobRequest struct {
	JobType          string `json:"job_type"`
	RunnerID         string `json:"runner_id,omitempty"`
	Name             string `json:"name,omitempty"`
	CloudIdentityID  string `json:"cloud_identity_id,omitempty"`
	Region           string `json:"region,omitempty"`
	AssignedRunnerID string `json:"assigned_runner_id,omitempty"`
}

// runnerJobObject is the `object` of a runner deploy or destroy result.
type runnerJobObject struct {
	// Name is the runner's name. It is empty when a destroy was given an id no listed runner has.
	Name string `json:"name"`
	// Request is what would be sent. It is present only on a dry run.
	Request *runnerJobRequest `json:"request,omitempty"`
	// JobStatus is the job's status when the command stopped looking at it. Empty on a dry run.
	JobStatus string `json:"job_status,omitempty"`
	// Warnings is what the finished job recorded as warnings. Always present; empty for a job
	// that was not waited for.
	Warnings []string `json:"warnings"`
}

// followRunnerJob announces a queued runner job on stderr, waits for it when asked to, and
// records where it stands in obj. The error of a wait that did not end in success is already
// classified (awaitJob).
func followRunnerJob(ctx context.Context, p *Printer, c jobPoller, wait waitFlags, job JobRef, obj *runnerJobObject) error {
	p.JobQueued(job.Type, job.ID)
	if !wait.Wait {
		return nil
	}
	done, err := awaitJob(ctx, c, job.ID, wait.options(job.Type, p))
	if err != nil {
		return err
	}
	obj.JobStatus = done.Status
	obj.Warnings = jobWarnings(done)
	return nil
}

// renderRunnerJob writes a runner job result for a person: one line saying what was queued, or
// what a dry run would have queued.
func renderRunnerJob(w io.Writer, r MutationResult, obj runnerJobObject) {
	name := obj.Name
	if name == "" {
		name = r.ID
	}
	switch {
	case r.DryRun:
		fmt.Fprintln(w, ui.MutedStyle.Render(fmt.Sprintf(
			"Would queue a %s job for runner %s. Nothing was sent.", obj.Request.JobType, name)))
	case strings.EqualFold(obj.JobStatus, jobStatusSuccess):
		fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("%s job %s finished for runner %s (%s)", r.Job.Type, r.Job.ID, name, r.ID)))
	default:
		fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("%s job %s queued for runner %s (%s)", r.Job.Type, r.Job.ID, name, r.ID)))
	}
}

// printRunnerJob prints a runner job result in the command's format.
func printRunnerJob(cmd *cobra.Command, result MutationResult) error {
	return printerFor(cmd).Result(result, func(w io.Writer) {
		if obj, ok := result.Object.(runnerJobObject); ok {
			renderRunnerJob(w, result, obj)
		}
	})
}
