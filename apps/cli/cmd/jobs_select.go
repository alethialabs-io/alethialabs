// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/dustin/go-humanize"
	"github.com/spf13/cobra"
)

// Which job? — the one field spec behind `jobs get`, `jobs logs` and `jobs cancel`.
//
// All three used to take the id as a REQUIRED positional, which made every one of them the
// second half of a copy: the tutorial, the quickstart and `plan-and-apply.mdx` each told the
// reader to run `project plan`, read an opaque uuid out of its output, and paste it back in.
// `plan-and-apply.mdx` shipped a `grep | awk` to do the pasting. That copied token is a
// HANDOFF, and removing the handoffs is what this programme is for.
//
// So the id now has three sources, and they are the same three renderings of ONE spec:
//
//	positional   alethia jobs logs 8f3c…            an id you already have
//	--latest     alethia jobs logs --latest -f      the newest matching job — works under --no-input
//	the picker   alethia jobs logs                  a list to choose from, on a terminal
//
// The narrowing fields below are what makes `--latest` safe to script: `--latest --type PLAN
// --project web` names ONE job in a busy org. The flag set is a COMPLETE contract — anything
// the picker can be narrowed by, a flag can set — so `--no-input` is never a dead end.

// jobSelectorField is one narrowing field of the "which job" spec.
//
// The spec is a VALUE, not three hand-copied lists, because the same three fields have to appear
// as cobra flags, in the picker's description, and in the docs table — and a hand-written list
// in each place is a list that stops agreeing. `TestJobsSelector_DocsTableMatchesTheSpec` reads
// the flags back off the real cobra commands and the rows out of the shipped MDX, so a field
// added here and nowhere else fails the build.
type jobSelectorField struct {
	// Flag is the long flag name, and the first column of the docs table.
	Flag string
	// Usage is the flag's help text.
	Usage string
	// Target returns the field's slot in a selector, so one loop can bind every flag.
	Target func(*jobSelector) *string
	// Allowed is the closed set of values, from the generated enum. Nil means free text.
	//
	// A function rather than a slice so it is read from `packages/core/types` at call time: a
	// job type added to the drizzle enum reaches this validation without anyone editing it.
	Allowed func() []string
	// Match reports whether a job satisfies this field's value. Never called with an empty value.
	Match func(api.ProvisionJob, string) bool
}

// jobSelectorFields is the spec. Order is the order of the docs table and of `--help`.
var jobSelectorFields = []jobSelectorField{
	{
		Flag:    "type",
		Usage:   "Narrow to a job type",
		Target:  func(s *jobSelector) *string { return &s.jobType },
		Allowed: jobTypeValues,
		Match:   func(j api.ProvisionJob, v string) bool { return strings.EqualFold(j.JobType, v) },
	},
	{
		Flag:    "status",
		Usage:   "Narrow to a job status",
		Target:  func(s *jobSelector) *string { return &s.status },
		Allowed: jobStatusValues,
		Match:   func(j api.ProvisionJob, v string) bool { return strings.EqualFold(j.Status, v) },
	},
	{
		Flag:   "project",
		Usage:  "Narrow to a project, by name or by an id prefix",
		Target: func(s *jobSelector) *string { return &s.project },
		Match: func(j api.ProvisionJob, v string) bool {
			return strings.EqualFold(j.ProjectName, v) ||
				(j.ProjectID != "" && strings.HasPrefix(strings.ToLower(j.ProjectID), strings.ToLower(v)))
		},
	},
}

// jobSelector holds one command's answers to the spec above.
type jobSelector struct {
	latest  bool
	jobType string
	status  string
	project string
}

// jobTypeValues is every provision_job_type, from the generated enum.
func jobTypeValues() []string {
	out := make([]string, len(types.AllJobTypes))
	for i, t := range types.AllJobTypes {
		out[i] = string(t)
	}
	return out
}

// jobStatusValues is every provision_job_status, from the generated enum.
func jobStatusValues() []string {
	out := make([]string, len(types.AllJobStatuses))
	for i, s := range types.AllJobStatuses {
		out[i] = string(s)
	}
	return out
}

// addJobSelectorFlags registers `--latest` plus every narrowing field on a command that acts on
// one job, so the three of them cannot drift apart.
func addJobSelectorFlags(cmd *cobra.Command, sel *jobSelector) {
	cmd.Flags().BoolVar(&sel.latest, "latest", false,
		"Act on the most recent matching job instead of naming one (works with --no-input)")
	for _, f := range jobSelectorFields {
		usage := f.Usage
		if f.Allowed != nil {
			usage += " (" + strings.Join(f.Allowed(), ", ") + ")"
		}
		cmd.Flags().StringVar(f.Target(sel), f.Flag, "", usage)
	}
}

// set returns the narrowing fields this selector actually carries, in spec order.
func (s jobSelector) set() []jobSelectorField {
	var out []jobSelectorField
	for _, f := range jobSelectorFields {
		if *f.Target(&s) != "" {
			out = append(out, f)
		}
	}
	return out
}

// describe renders the narrowing as prose for an error message: "type PLAN, project web".
// Returns "" when nothing narrows, which callers read as "any recent job".
func (s jobSelector) describe() string {
	var parts []string
	for _, f := range s.set() {
		parts = append(parts, f.Flag+" "+*f.Target(&s))
	}
	return strings.Join(parts, ", ")
}

// validate rejects a value outside a closed enum.
//
// This is the "provable subset" rule the programme states: the CLI may only reject what the
// server would CERTAINLY reject. A status outside provision_job_status matches no row by
// construction, so refusing it here cannot hide a job that exists — while the server's answer to
// a typo is an empty page, which reads as "no jobs" rather than "you misspelled PROCESSING".
func (s jobSelector) validate() error {
	for _, f := range s.set() {
		if f.Allowed == nil {
			continue
		}
		v := *f.Target(&s)
		allowed := f.Allowed()
		if !containsFold(allowed, v) {
			return fmt.Errorf("--%s %q is not a job %s (want one of: %s)",
				f.Flag, v, f.Flag, strings.Join(allowed, ", "))
		}
	}
	return nil
}

// containsFold reports whether vals holds v, ignoring case.
func containsFold(vals []string, v string) bool {
	for _, a := range vals {
		if strings.EqualFold(a, v) {
			return true
		}
	}
	return false
}

// jobLister is the slice of the API client the resolver needs — small enough that the resolution
// logic is unit-testable against a fake, and satisfied by the concrete *api.Client.
type jobLister interface {
	GetJobs(status string, limit, offset int) (*api.JobsPage, error)
}

// jobSelectorPageSize is how far back `--latest` and the picker look.
//
// Fifty, because the server caps `limit` at 100 and orders by created_at DESC, and a job older
// than the last fifty is one nobody is picking out of a list — they have its id. It is a
// variable so a test can prove the resolver passes it through rather than defaulting.
var jobSelectorPageSize = 50

// jobRef is a resolved job: its id, plus the one-line summary of how it was found.
//
// Summary is EMPTY when the id came from the command line, and set when the CLI chose the job.
// Callers use that difference: `jobs cancel --latest` prints what it resolved to before it acts,
// because "cancel job 8f3c…" is not something a reader can check, and a destructive command
// that resolved its own target must say what the target was.
type jobRef struct {
	ID      string
	Summary string
}

// errJobIDRequired is the refusal when no id was given, nothing may be prompted, and the caller
// did not opt into `--latest`.
//
// Failing here rather than after the fetch is deliberate: the answer does not depend on what the
// server holds, so asking it would only slow the error down.
// The narrowing flags are listed FROM THE SPEC. A hand-typed list here would be a fourth
// rendering of the spec that nothing keeps in step, and the reader of this message is exactly
// the person who cannot afford to be told about two of the three flags that exist.
var errJobIDRequired = errors.New(
	"no job id given, and interactive prompts are disabled (--no-input, or stdin is not a terminal): " +
		"pass the job id, or --latest to take the most recent job (narrow it with " +
		strings.Join(jobSelectorFlagNames(), "/") + ")",
)

// jobSelectorFlagNames renders the narrowing flags as `--type`, `--status`, `--project`.
func jobSelectorFlagNames() []string {
	out := make([]string, len(jobSelectorFields))
	for i, f := range jobSelectorFields {
		out[i] = "--" + f.Flag
	}
	return out
}

// announceResolvedJob tells the reader which job the CLI chose, on STDERR.
//
// Stderr and not stdout, because `jobs logs` is a command people pipe: the tofu output is the
// document, and a line about which job it came from is a diagnostic. On stdout it would land in
// the middle of a grep, and in a `-o json` document it would break the parse. Nothing is
// announced when the caller named the job — describing an id back at the person who typed it is
// noise, and it is the resolved case that needs saying.
func announceResolvedJob(ref jobRef, verb string) {
	if ref.Summary == "" {
		return
	}
	fmt.Fprintln(os.Stderr, ui.MutedStyle.Render(ui.SymbolPoint+" "+verb+" "+ref.Summary))
}

// resolveJob answers "which job" from the positional argument, `--latest`, or the picker.
func resolveJob(client jobLister, args []string, sel jobSelector) (jobRef, error) {
	if len(args) > 0 && args[0] != "" {
		if sel.latest {
			return jobRef{}, fmt.Errorf("pass a job id or --latest, not both (%q was given)", args[0])
		}
		if narrowed := sel.describe(); narrowed != "" {
			// Silently ignoring the narrowing would be the worse answer: `jobs logs <id> --type
			// DEPLOY` on a PLAN job would print the PLAN's logs and look like it had filtered.
			return jobRef{}, fmt.Errorf("a job id selects one job, so %s cannot also apply — drop the id, or drop the narrowing", narrowed)
		}
		return jobRef{ID: args[0]}, nil
	}

	if err := sel.validate(); err != nil {
		return jobRef{}, err
	}
	if !sel.latest {
		if err := requireInteractive(); err != nil {
			return jobRef{}, errJobIDRequired
		}
	}

	matches, err := narrowJobs(client, sel)
	if err != nil {
		return jobRef{}, err
	}
	if len(matches) == 0 {
		scope := fmt.Sprintf("in the last %d jobs", jobSelectorPageSize)
		if narrowed := sel.describe(); narrowed != "" {
			scope = "with " + narrowed + " " + scope
		}
		return jobRef{}, fmt.Errorf("no job %s — run `alethia jobs list` to see what there is", scope)
	}

	if sel.latest {
		return jobRef{ID: matches[0].ID, Summary: jobOptionLabel(matches[0])}, nil
	}
	return pickJob(matches)
}

// narrowJobs fetches a page of recent jobs and keeps the ones every set field matches.
//
// `--status` is handed to the server, which indexes it; the rest are applied here because
// GET /api/jobs takes no other filter. That split is invisible to the caller and stays correct
// if the endpoint grows one (#3672).
func narrowJobs(client jobLister, sel jobSelector) ([]api.ProvisionJob, error) {
	page, err := client.GetJobs(strings.ToUpper(sel.status), jobSelectorPageSize, 0)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch jobs: %w", err)
	}
	if page == nil {
		return nil, nil
	}
	var out []api.ProvisionJob
	for _, j := range page.Jobs {
		keep := true
		for _, f := range sel.set() {
			if !f.Match(j, *f.Target(&sel)) {
				keep = false
				break
			}
		}
		if keep {
			out = append(out, j)
		}
	}
	return out, nil
}

// jobOptionLabel renders one job as a single line: "Plan · SUCCESS · web · 2 minutes ago · 8f3c…".
//
// It reads through the same jobTypeLabels map and ui.TruncID the jobs table uses, so a job reads
// the same in the picker as it does in `jobs list`.
func jobOptionLabel(j api.ProvisionJob) string {
	typeLabel := jobTypeLabels[j.JobType]
	if typeLabel == "" {
		typeLabel = j.JobType
	}
	project := j.ProjectName
	if project == "" && j.ProjectID != "" {
		project = ui.TruncID(j.ProjectID)
	}
	if project == "" {
		project = ui.SymbolDash
	}
	sep := " " + ui.SymbolBullet + " "
	return strings.Join([]string{
		typeLabel, j.Status, project, humanize.Time(j.CreatedAt), ui.TruncID(j.ID),
	}, sep)
}

// pickJob shows the interactive picker over already-narrowed jobs.
//
// The option VALUE is the index rather than the job id, so the answer needs no lookup and there
// is no "the picker returned an id I do not recognise" branch to write, test, or get wrong. huh
// can only write back one of the values it was given, and every index it was given is in range.
func pickJob(jobs []api.ProvisionJob) (jobRef, error) {
	options := make([]huh.Option[int], len(jobs))
	for i, j := range jobs {
		options[i] = huh.NewOption(jobOptionLabel(j), i)
	}
	chosen := 0
	if err := runHuhForm(
		huh.NewGroup(
			huh.NewSelect[int]().
				Title("Select Job").
				Description("Most recent first").
				Options(options...).
				Value(&chosen),
		),
	); err != nil {
		return jobRef{}, err
	}
	return jobRef{ID: jobs[chosen].ID, Summary: jobOptionLabel(jobs[chosen])}, nil
}
