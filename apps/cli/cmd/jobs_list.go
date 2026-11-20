// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/format"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

var jobListColumns = []string{"Type", "Status", "Project", "Runner", "Created", "Duration"}

var (
	jobsListStatus string
	jobsListLimit  int
	jobsListOffset int
	jobsListAll    bool
)

// jobsListDefaultLimit is the page size when --limit is absent or not positive.
const jobsListDefaultLimit = 20

// jobsListMaxPages bounds --all. The loop already stops at a short or empty page; this is the
// backstop for a server that never sends one, at a size no organization's history reaches.
const jobsListMaxPages = 1000

// jobTypeLabels maps every provision_job_type to a friendly table label. Keyed by the
// generated types.JobType constants so a removed enum value is a compile error here; a
// test (TestJobTypeLabels_CoverAllJobTypes) asserts every job type has a label, so an
// added one fails the build.
var jobTypeLabels = map[string]string{
	string(types.JobTypePlan):           "Plan",
	string(types.JobTypeDeploy):         "Deploy",
	string(types.JobTypeDestroy):        "Destroy",
	string(types.JobTypeAnalyzeRepo):    "Analyze Repo",
	string(types.JobTypeDetectDrift):    "Detect Drift",
	string(types.JobTypeAudit):          "Audit",
	string(types.JobTypeDeployRunner):   "Deploy Runner",
	string(types.JobTypeUpdateRunner):   "Update Runner",
	string(types.JobTypeDestroyRunner):  "Destroy Runner",
	string(types.JobTypeChartScan):      "Chart Scan",
	string(types.JobTypeIacScan):        "IaC Scan",
	string(types.JobTypeStateSurgery):   "State Surgery",
	string(types.JobTypeProbeCluster):   "Probe Cluster",
	string(types.JobTypeBuild):          "Build",
	string(types.JobTypeMintKubeconfig): "Mint Kubeconfig",
}

// jobsListEveryStatusLabel is how the picker spells "do not filter".
//
// Its VALUE is the empty string — the same value `--status` carries when nobody set it — so the
// answered form and the skipped one converge on ONE code path instead of two that have to agree
// about what "no filter" means.
const jobsListEveryStatusLabel = "Every status"

// jobsListStatusOptions is the picker's option list: every status first, then the lifecycle.
//
// The vocabulary is jobStatusValues() — the generated provision_job_status enum — and not a list
// typed here, for the same reason `--status`'s help text reads it: a hand-typed copy of a
// generated set is a copy that stops covering it silently. It is a function, and separate from
// the form, because a huh.Group answers no question about the options it was handed: this is the
// only shape of the picker a test can read.
func jobsListStatusOptions() []huh.Option[string] {
	values := jobStatusValues()
	opts := make([]huh.Option[string], 0, len(values)+1)
	opts = append(opts, huh.NewOption(jobsListEveryStatusLabel, ""))
	for _, s := range values {
		opts = append(opts, huh.NewOption(s, s))
	}
	return opts
}

// promptJobsListStatus asks which slice of the lifecycle to list.
//
// It is a package variable for the reason config.go's promptConfigSet records: stubbing
// runHuhForm stops the prompt blocking, but no stub can answer THROUGH the pointer the huh group
// owns, so the answered branch is otherwise unreachable from a test.
//
// The seed is what the caller already holds, and "Every status" is FIRST, so a reader who only
// wants the list presses Enter and gets exactly what `alethia jobs list` printed before this form
// existed. A form that cannot be completed returns the seed with its error; the caller decides.
var promptJobsListStatus = func(current string) (string, error) {
	chosen := current
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Which jobs?").
			Description("The closed set the --status flag takes, from the schema's job-status enum").
			Options(jobsListStatusOptions()...).
			Value(&chosen),
	)); err != nil {
		return current, err
	}
	return chosen, nil
}

// jobsListStatusFor answers "which status is this run filtered by" from the flag or the picker.
//
// Three conditions, and each removes a way the question would be wrong to ask:
//
//   - a `--status` already given is the answer. Asking again would let a form overwrite what the
//     operator typed, which is the one thing a picker must never do.
//   - `interactiveTable(cmd)` — a reader about to BROWSE the list on screen. `-o json`, a pipe and
//     `--no-input` have already said what they want, and a document that will not appear until a
//     question is answered is `jobs list -o json > jobs.json` with the spinner in it one level up.
//   - `canPromptForm()` — the gate every other prompt in this package reads, and the one that
//     knows a form draws on STDERR. It is the predicate and not requireInteractiveForm because
//     this field has a working answer when nobody types one: listing every job is what the command
//     did before, so a caller that cannot be asked must be SERVED, never refused. `jobs list` takes
//     no required input, so refuseNoForm's arm — the one `config set` needs, because a key and a
//     value have no default — has nothing here to refuse.
//
// The flag contract stays complete: anything the picker can choose, `--status` can set.
//
// A form that FAILED is not a form that was answered "no", and the two get different answers. An
// ABORT — the reader pressed Esc or Ctrl-C at the picker — is an instruction and is returned, so
// the command stops. Any other error means the picker could not be SHOWN, and a filter that could
// not be offered must not take the list away: `canPromptForm` is a TTY question and huh needs a
// /dev/tty it can open, so the gate can say yes to a form that then cannot draw. That is the whole
// reason this field uses the predicate rather than requireInteractiveForm — falling back is the
// contract, not an accident — and the fallback SAYS so on stderr rather than being silent, because
// an unfiltered list nobody asked for should be explicable.
func jobsListStatusFor(cmd *cobra.Command, flag string) (string, error) {
	if flag != "" || !interactiveTable(cmd) || !canPromptForm() {
		return flag, nil
	}
	chosen, err := promptJobsListStatus(flag)
	if err != nil {
		if errors.Is(err, huh.ErrUserAborted) {
			return flag, err
		}
		// STDERR, for announceResolvedJob's reason: the table is the document and a line about a
		// choice the CLI made for the reader is a diagnostic. ui.Muted would put it on stdout.
		fmt.Fprintln(os.Stderr, ui.MutedStyle.Render(
			fmt.Sprintf("%s Listing every status — the picker could not be shown (%v).", ui.SymbolPoint, err)))
		return flag, nil
	}
	return chosen, nil
}

var jobsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List provisioning jobs, newest first",
	Long: `List the organization's provisioning jobs, newest first: plans, deploys, destroys, drift
detections and scans.

At a terminal it opens a table you can page through. In a pipe, with --no-input or with -o json or
csv it prints one page: --limit sets its size and --offset where it starts. --all walks every page
and prints the whole history, which is what a script that must not miss a job wants.

Under -o json the result is one object: the jobs, the total number that match, the limit and offset
that were served, and has_more, which says whether another page follows.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		// Validated against the generated enum before the request. The server answers a
		// misspelled status with an empty page, which reads as "you have no jobs" rather than
		// "you typed PROCESSNG" — and no job can carry a status outside the enum, so refusing
		// one here can never hide a job that exists.
		if jobsListStatus != "" && !containsFold(jobStatusValues(), jobsListStatus) {
			fail(clierr.New(clierr.CodeInvalidFlag, fmt.Sprintf("invalid --status %q (want one of: %s)",
				jobsListStatus, strings.Join(jobStatusValues(), ", "))))
		}
		if jobsListOffset < 0 {
			fail(clierr.New(clierr.CodeInvalidFlag, "--offset cannot be negative"))
		}

		// Asked before the fetch, because the answer is what gets fetched. A local and not the
		// flag variable: jobsListStatus is a package global bound by cobra, and a form answer
		// written back into it would outlive this run.
		statusFilter, err := jobsListStatusFor(cmd, jobsListStatus)
		if err != nil {
			fail(err)
		}

		token, err := getAuthToken()
		if err != nil {
			fail(err)
		}

		apiClient := api.NewClient(token)
		query := jobsListQuery{
			// Upper-cased for the wire. The column is a Postgres enum compared as text, so
			// `success` would match no row — accepting a spelling and then sending it verbatim
			// would turn a friendly flag into a silent empty page.
			Status: strings.ToUpper(statusFilter),
			Limit:  jobsListLimit,
			Offset: jobsListOffset,
			All:    jobsListAll,
		}
		if query.Limit <= 0 {
			query.Limit = jobsListDefaultLimit
		}

		// A caller who named a slice gets that slice printed. The navigable table always starts
		// at the first page and fetches as it goes, so it cannot honour either flag.
		if !interactiveTable(cmd) || query.All || query.Offset > 0 {
			p := printerFor(cmd)
			var result jobsListResult
			runSpinner("Fetching jobs...", func() {
				result, err = runJobsList(apiClient, query)
			})
			if err != nil {
				fail(err)
			}
			if err := result.print(p); err != nil {
				fail(err)
			}
			return
		}

		var page *api.JobsPage
		runSpinner("Fetching jobs...", func() {
			page, err = apiClient.GetJobs(query.Status, query.Limit, 0)
		})
		if err != nil {
			fail(fmt.Errorf("failed to fetch jobs: %w", err))
		}

		if page.Total == 0 {
			ui.MutedTo(printer.Out, jobsEmptyState)
			return
		}

		columns := jobColumns()
		rows := jobRows(page.Jobs)

		m := ui.NewPaginatedTableModel(columns, rows, "jobs", page.Total, query.Limit)

		p := tea.NewProgram(jobsPaginatedModel{
			PaginatedTableModel: m,
			apiClient:           apiClient,
			pageSize:            query.Limit,
			status:              query.Status,
		})
		if _, err := p.Run(); err != nil {
			fail(fmt.Errorf("table error: %w", err))
		}
	},
}

// jobsEmptyState is the one sentence both renderings of an empty list print.
const jobsEmptyState = "No jobs found."

// jobsListQuery is which jobs one `jobs list` asks for.
type jobsListQuery struct {
	// Status is the wire status to filter by, or empty for every status.
	Status string
	// Limit is the page size. Always positive.
	Limit int
	// Offset is how many of the newest matching jobs to skip.
	Offset int
	// All walks every page from Offset instead of stopping after one.
	All bool
}

// jobsListResult is the result of `jobs list`: the jobs, and where they sit in the whole set.
type jobsListResult struct {
	Jobs []api.ProvisionJob `json:"jobs"`
	// Total is how many jobs match the filter. TotalExact is false when the control plane stopped
	// counting at a ceiling, in which case Total is a floor.
	Total      int  `json:"total"`
	TotalExact bool `json:"total_exact"`
	// Limit and Offset are the page size and start that were served.
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
	// HasMore reports whether jobs older than the last one here match the filter.
	HasMore bool `json:"has_more"`
}

// runJobsList fetches one page of jobs, or with q.All every page from q.Offset.
//
// A walk stops at the first page that comes back short or empty: that is the end of the set
// whether or not the total is exact, so it never depends on a count the server may have capped.
func runJobsList(client jobLister, q jobsListQuery) (jobsListResult, error) {
	result := jobsListResult{Jobs: []api.ProvisionJob{}, Limit: q.Limit, Offset: q.Offset, TotalExact: true}
	offset := q.Offset
	for pages := 0; pages < jobsListMaxPages; pages++ {
		page, err := client.GetJobs(q.Status, q.Limit, offset)
		if err != nil {
			return jobsListResult{}, fmt.Errorf("failed to fetch jobs: %w", err)
		}
		if page == nil {
			break
		}
		result.Jobs = append(result.Jobs, page.Jobs...)
		result.Total = page.Total
		result.TotalExact = !page.Page.IsCapped()
		// The size the server served, which is smaller than the one asked for when it clamps.
		served := q.Limit
		if page.Limit > 0 && page.Limit < served {
			served = page.Limit
		}
		offset += len(page.Jobs)
		full := len(page.Jobs) > 0 && len(page.Jobs) >= served
		if !q.All || !full {
			// More remain when this page was full and the count, where it can be trusted, says so.
			result.HasMore = full && (!result.TotalExact || offset < page.Total)
			break
		}
	}
	return result, nil
}

// Table returns the jobs as csv rows, so Printer.Result has a csv form for the list.
func (r jobsListResult) Table() ui.TableSpec {
	return ui.TableSpec{Columns: jobListColumns, Rows: jobRowsPlain(r.Jobs, ui.FormatCSV)}
}

// print writes the list on p.Out in p's format. For a person, a list that stops short of the set
// says so on p.Err, with the two flags that reach the rest.
func (r jobsListResult) print(p *Printer) error {
	if p.Format != ui.FormatTable {
		return p.Result(r, nil)
	}
	if err := renderJobs(p.Out, p.Format, r.Jobs); err != nil {
		return err
	}
	if r.HasMore {
		of := fmt.Sprintf("%d", r.Total)
		if !r.TotalExact {
			of = "more than " + of
		}
		p.Note(fmt.Sprintf("Showing %d of %s jobs. Next page: --offset %d. Everything: --all.",
			len(r.Jobs), of, r.Offset+len(r.Jobs)))
	}
	return nil
}

// renderJobs writes jobs to out in the requested format: the static table, the records as json,
// or the rows as csv. `jobs list` prints its json through jobsListResult, which adds the paging
// facts; this is the table and csv form, and the bare array other callers render.
func renderJobs(out io.Writer, outFormat string, jobs []api.ProvisionJob) error {
	if len(jobs) == 0 && outFormat == ui.FormatTable {
		fmt.Fprintln(out, ui.MutedStyle.Render(jobsEmptyState))
		return nil
	}
	return ui.Render(out, outFormat, ui.TableSpec{
		Columns: jobListColumns,
		Rows:    jobRowsPlain(jobs, outFormat),
	}, jobs)
}

// jobRowsPlain projects each job into a plain table row.
func jobRowsPlain(jobs []api.ProvisionJob, outFmt string) [][]string {
	rows := make([][]string, len(jobs))
	for i, j := range jobs {
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

		runner := j.RunnerName
		if runner == "" && j.RunnerID != "" {
			runner = ui.TruncID(j.RunnerID)
		}
		if runner == "" {
			runner = ui.SymbolDash
		}

		rows[i] = []string{
			typeLabel,
			j.Status,
			project,
			runner,
			ui.Cell(outFmt, wireTime(j.CreatedAt), ui.SmartTime(j.CreatedAt)),
			formatDuration(j.StartedAt, j.CompletedAt),
		}
	}
	return rows
}

// formatDuration renders how long a job ran, with "…" while it is still running.
//
// The elapsed rule itself is `packages/core/format.Duration` and no longer lives here. It was
// the last hand-written copy of it in the CLI, and it is the rule the epic ruled ON: a job that
// takes two hours reads `2h 5m`, not `125m 5s`, on BOTH surfaces. What stays local is the part
// that is genuinely this command's — the dash for a job that never started, and the ellipsis
// that says the number is still climbing. `apps/cli/pkg/utils/ui/render.go` records why this
// function was left out of the render hoist: its rule was about to be replaced wholesale, and
// this is that replacement.
func formatDuration(started, completed *time.Time) string {
	if started == nil {
		return ui.SymbolDash
	}
	end := time.Now()
	suffix := "…"
	if completed != nil {
		end = *completed
		suffix = ""
	}
	return format.Duration(end.Sub(*started)) + suffix
}

func init() {
	jobsCmd.AddCommand(jobsListCmd)
	// The status vocabulary is read from the generated enum, not typed here. The literal list
	// this replaced was already a hand-maintained copy of provision_job_status, and a hand-typed
	// list of a generated set is a list that stops covering it silently.
	jobsListCmd.Flags().StringVar(&jobsListStatus, "status", "",
		"Filter by status ("+strings.Join(jobStatusValues(), ", ")+")")
	jobsListCmd.Flags().IntVarP(&jobsListLimit, "limit", "n", jobsListDefaultLimit, "Jobs per page (the control plane serves at most 100)")
	jobsListCmd.Flags().IntVar(&jobsListOffset, "offset", 0, "Skip this many of the newest matching jobs, to print a later page")
	jobsListCmd.Flags().BoolVar(&jobsListAll, "all", false, "Print every matching job, walking every page")
}
