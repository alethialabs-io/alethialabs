// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The BYO (bring-your-own) WRITE commands: attach, detach and scan your own Helm charts and your own
// Terraform/OpenTofu source. Both surfaces were read-only from the CLI — you could see what was
// attached and never attach anything — so a repeatable or CI-driven flow had to stop at the console
// exactly where the customer's own code enters the picture.
//
// Every one of the six reports through the Printer: the result — a MutationResult — on stdout in the
// format asked for, and the next step, the queued-job notice and the replay line on stderr.

package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var (
	chartAttachRepo       string
	chartAttachPath       string
	chartAttachRef        string
	chartAttachNamespace  string
	chartAttachValuesFile string
	chartAttachSet        []string
	chartDetachYes        bool
	chartScanWait         waitFlags

	iacAttachRepo string
	iacAttachRef  string
	iacAttachPath string
	iacAttachVar  []string
	iacDetachYes  bool
	iacScanWait   waitFlags
)

// The kinds and job types the BYO results name. The job types are the ones the control plane queues
// for a scan (apps/console/app/server/actions/byo-charts.ts and byo-iac.ts).
const (
	byoChartKind     = "byo_chart"
	byoIacKind       = "iac_source"
	chartScanJobType = "CHART_SCAN"
	iacScanJobType   = "IAC_SCAN"
)

// jobStatusQueued is the status a scan job is reported in before anyone has polled it.
const jobStatusQueued = "QUEUED"

// byoTarget is where a BYO write landed: the project and the environment as the caller named them.
// An empty Env is the project's default environment.
type byoTarget struct {
	Project string `json:"project"`
	Env     string `json:"env"`
}

// chartAttachObject is the `object` of a chart attach result: what was attached and where. The
// values override and the --set values are not echoed back; they are the caller's own input and
// may be large.
type chartAttachObject struct {
	byoTarget
	RepoURL   string `json:"repo_url"`
	ChartPath string `json:"chart_path"`
	Ref       string `json:"ref"`
	Namespace string `json:"namespace"`
}

// iacAttachObject is the `object` of an IaC attach result.
type iacAttachObject struct {
	byoTarget
	RepoURL string `json:"repo_url"`
	Path    string `json:"path"`
	Ref     string `json:"ref"`
}

// byoScanObject is the `object` of a scan result. JobStatus is the status the job last reported:
// the queued status without --wait, the final one with it.
type byoScanObject struct {
	byoTarget
	JobStatus string   `json:"job_status"`
	Warnings  []string `json:"warnings"`
}

// readChartValuesFile reads the raw Helm-values override, or returns "" when no file was named. The
// content is NOT parsed here: the server validates it as a YAML mapping through the same action the
// console uses, so a local pre-parse would be a second opinion that can disagree with the one that
// decides. A file that cannot be read is a bad flag value: nothing was sent.
func readChartValuesFile(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", clierr.Wrap(clierr.CodeInvalidFlag, fmt.Errorf("read --values-file: %w", err))
	}
	return string(raw), nil
}

// confirmOrRefuse reports whether a destructive BYO or add-on action may proceed. yes is the
// command's --yes flag. With nobody to ask it is the standard refusal (input required, exit 9);
// on a terminal it asks through confirm. A declined prompt is (false, nil): a choice, not an error.
func confirmOrRefuse(yes bool, title, description string) (bool, error) {
	if yes {
		return true, nil
	}
	if !canPromptForm() {
		return false, errConfirmRequiresYes
	}
	return confirm(title, description), nil
}

// byoInterruptContext is the context a scan waits under: it ends when the person presses Ctrl-C,
// which awaitJob reports as an interrupt (exit 130) rather than a failure.
func byoInterruptContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt)
}

// byoNotFoundHint adds the listing command to a not-found answer, so the person reading it knows
// where the names that do exist are.
func byoNotFoundHint(err error, hint string) error {
	e := *clierr.From(err)
	if e.Hint == "" && e.Class == clierr.ClassNotFound {
		e.Hint = hint
	}
	return &e
}

// --- charts ---

var chartAttachCmd = &cobra.Command{
	Use:   "attach [id]",
	Short: "Attach (or update) your own Helm chart in an environment",
	Args:  cobra.MaximumNArgs(1),
	Long: `Attaches a chart from your own repository — git or OCI — to one environment.

  git:  --repo https://github.com/acme/charts --chart-path charts/api
  OCI:  --repo oci://registry.example.com/acme/api

A git chart needs --chart-path; an OCI chart is named by the URL's last segment and does not.
The chart is not deployable until it has been scanned — "alethia chart scan" follows.

Omit a value on a terminal and you are asked for it, and the repository is CHOSEN from the ones
Alethia can already see rather than copied out of "alethia repo list". Every question has a flag,
so the same attach runs unattended; the run prints the flags that would have produced it. With
nobody to ask, a missing id or --repo is refused (exit 9) and nothing is sent.

Re-attaching the same id UPDATES it, so this is also how you move a chart to a new ref. The result
says "updated" either way: the control plane does not say whether the id was new.

A PRIVATE repository needs no credential here. The runner fetches a short-lived token at job
time from your linked GitHub/GitLab account, scoped to the repositories this project declares.
Link that account once in the console; nothing is stored against the chart.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runChartAttachCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runChartAttachCmd is `chart attach` from the command line to the printed result.
func runChartAttachCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	mayAsk := interactiveTable(cmd)
	project, err := byoProject(cmd, token, mayAsk)
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	values, err := parseSetValues(chartAttachSet)
	if err != nil {
		return err
	}
	valuesYAML, err := readChartValuesFile(chartAttachValuesFile)
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	params := api.AttachChartParams{
		Project: project, Env: env, ID: firstArg(args),
		RepoURL: chartAttachRepo, ChartPath: chartAttachPath, Ref: chartAttachRef,
		Namespace: chartAttachNamespace, ValuesYAML: valuesYAML,
		Values: values,
	}
	params, asked, err := askChartAttach(params, client.GetRepositories, mayAsk)
	if err != nil {
		return err
	}
	result, err := chartAttach(client, params)
	if err != nil {
		return err
	}
	if err := printChartAttach(p, result); err != nil {
		return err
	}
	printReplay(p.Err, p.Format, asked, chartAttachReplayArgs(params)...)
	return nil
}

// firstArg returns the single optional positional, or "".
//
// Every leaf in this group that took a mandatory id now takes an optional one, and each of them
// reached for args[0] behind an ExactArgs(1) that no longer holds.
func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return strings.TrimSpace(args[0])
}

// askChartAttach fills in whatever `chart attach` was not told, and reports whether it asked.
//
// Only MISSING values are asked for: a flag that was passed is never re-questioned, so a partly
// scripted invocation stays scripted for the parts it specified. `mayAsk` false leaves the params
// exactly as the flags set them — chartAttach then refuses the empty required ones and names them.
//
// --chart-path is asked for GIT repositories only, the rule this command's help has always stated:
// an OCI chart is named by its URL's last segment and a path there is ignored. That is a decision
// about which QUESTION to put, never a refusal — an OCI URL with a path still reaches the server,
// which owns that verdict.
//
// --values-file and --set are deliberately NOT asked. A filesystem path and a repeatable, JSON-typed
// key=value are poor single-line questions, and neither is required to attach a chart; both stay
// flags, and the replay line carries them when they were used.
func askChartAttach(p api.AttachChartParams, list repoLister, mayAsk bool) (api.AttachChartParams, bool, error) {
	if !mayAsk {
		return p, false, nil
	}
	asked := false
	if p.ID == "" {
		f := mustByoField("alethia chart attach", byoKeyChartID)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		p.ID, asked = v, true
	}
	if p.RepoURL == "" {
		f := mustByoField("alethia chart attach", byoKeyRepo)
		v, err := promptRepoURL(list, f)
		if err != nil {
			return p, asked, err
		}
		p.RepoURL, asked = strings.TrimSpace(v), true
	}
	if p.ChartPath == "" && !isOCIRepo(p.RepoURL) {
		f := mustByoField("alethia chart attach", byoKeyChartPath)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		p.ChartPath, asked = v, true
	}
	for _, q := range []struct {
		key string
		dst *string
	}{
		{byoKeyRef, &p.Ref},
		{byoKeyNamespace, &p.Namespace},
	} {
		if *q.dst != "" {
			continue
		}
		f := mustByoField("alethia chart attach", q.key)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		*q.dst, asked = v, true
	}
	return p, asked, nil
}

// isOCIRepo reports whether a repository reference is an OCI registry URL.
//
// Lower-cased before the compare because a scheme is case-insensitive and `OCI://` is the same
// registry. This decides which question to ask and nothing else; it is not a grammar the CLI
// enforces against the server's.
func isOCIRepo(repo string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(repo)), "oci://")
}

// chartAttachReplayArgs renders the flags that reproduce an attach without the questions.
//
// It is built from the RESOLVED params rather than from the flags, which is what keeps "flags are a
// complete contract" honest rather than aspirational: a value the form can produce and the line
// cannot express would show up here as a missing flag.
func chartAttachReplayArgs(p api.AttachChartParams) []string {
	args := []string{"alethia", "chart", "attach"}
	if p.ID != "" {
		args = append(args, p.ID)
	}
	for _, kv := range [][2]string{
		{"--project", p.Project},
		{"--env", p.Env},
		{"--repo", p.RepoURL},
		{"--chart-path", p.ChartPath},
		{"--ref", p.Ref},
		{"--namespace", p.Namespace},
	} {
		if kv[1] != "" {
			args = append(args, kv[0], kv[1])
		}
	}
	// --values-file, not the YAML it held: the replay line is a command someone runs again, and the
	// file is what they would edit. --set is rendered per pair, the way it was typed.
	if chartAttachValuesFile != "" {
		args = append(args, "--values-file", chartAttachValuesFile)
	}
	for _, set := range chartAttachSet {
		args = append(args, "--set", set)
	}
	return args
}

// chartAttach attaches the chart and returns the result, whose id is the one the SERVER stored — it
// slugifies what you send, and the next command you run needs the stored one.
//
// A missing id or --repo is refused before anything is sent, as input_required: the same invocation
// on a terminal would have asked for it. Both are refused LOCALLY only because the server certainly
// refuses them too — the CLI adds no rule of its own about their shape.
func chartAttach(c apiClient, p api.AttachChartParams) (MutationResult, error) {
	result := MutationResult{Kind: byoChartKind, Action: ResultUpdated}
	var missing []string
	if p.ID == "" {
		missing = append(missing, "a chart id (the positional argument)")
	}
	if p.RepoURL == "" {
		missing = append(missing, "--repo")
	}
	if len(missing) > 0 {
		verb := "is"
		if len(missing) > 1 {
			verb = "are"
		}
		return result, refusal(clierr.CodeInputRequired, "alethia repo list",
			"%s %s required (omit them on a terminal and you are asked)", strings.Join(missing, " and "), verb)
	}
	res, err := c.AttachChart(p)
	if err != nil {
		return result, fmt.Errorf("attach chart %s: %w", p.ID, err)
	}
	result.ID = p.ID
	if res != nil && res.ID != "" {
		result.ID = res.ID
	}
	result.Object = chartAttachObject{
		byoTarget: byoTarget{Project: p.Project, Env: p.Env},
		RepoURL:   p.RepoURL, ChartPath: p.ChartPath, Ref: p.Ref, Namespace: p.Namespace,
	}
	return result, nil
}

// printChartAttach prints an attach result, and on stderr the scan that has to follow it: a chart is
// refused at deploy until it has been scanned.
func printChartAttach(p *Printer, r MutationResult) error {
	if err := p.Result(r, func(w io.Writer) { renderChartAttach(w, r) }); err != nil {
		return err
	}
	p.Note(fmt.Sprintf("Scan it before deploying: alethia chart scan %s", r.ID))
	return nil
}

// renderChartAttach is the person's line for an attach result.
func renderChartAttach(w io.Writer, r MutationResult) {
	env := ""
	if obj, ok := r.Object.(chartAttachObject); ok {
		env = obj.Env
	}
	fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Attached chart %s%s", r.ID, envSuffix(env))))
}

var chartDetachCmd = &cobra.Command{
	Use:   "detach [id]",
	Short: "Detach your own Helm chart from an environment",
	Args:  cobra.MaximumNArgs(1),
	Long: `Detaches one of your own Helm charts from an environment. Its workloads leave the cluster
on the next sync.

The id is optional: omit it on a terminal and the environment's attached charts are offered, so
nothing has to be copied out of "alethia chart list". The confirmation always NAMES the chart it
resolved to — a prompt about "this chart" is not a prompt anyone can answer when they did not type
an id. Scripts pass the id and --yes; without --yes and with nobody to ask, the command refuses
(exit 9) and detaches nothing.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runChartDetachCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runChartDetachCmd is `chart detach` from the command line to the printed result.
func runChartDetachCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	mayAsk := interactiveTable(cmd)
	project, err := byoProject(cmd, token, mayAsk)
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	client := api.NewClient(token)
	id, err := resolveChartID(client, firstArg(args), project, env, mayAsk, byoKeyChartID, "alethia chart detach")
	if err != nil {
		return err
	}
	// The chart is resolved BEFORE the confirmation so the question can name it. It is also why
	// the picker is not itself the confirmation: choosing which chart and agreeing to destroy it
	// are two answers, and a select that doubles as consent has no way to say no.
	ok, err := confirmOrRefuse(chartDetachYes, fmt.Sprintf("Detach chart %s%s?", id, envSuffix(env)),
		"Its workloads are removed from the cluster on the next sync.")
	if err != nil || !ok {
		return err
	}
	result, err := chartDetach(client, project, env, id)
	if err != nil {
		return err
	}
	return p.Result(result, func(w io.Writer) { renderByoDetach(w, result) })
}

// renderByoDetach is the person's line for a chart or IaC detach result.
func renderByoDetach(w io.Writer, r MutationResult) {
	obj, _ := r.Object.(byoTarget)
	if r.Kind == byoIacKind {
		fmt.Fprintln(w, ui.FormatSuccess("Detached the IaC source"+envSuffix(obj.Env)))
		return
	}
	fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Detached chart %s%s", r.ID, envSuffix(obj.Env))))
}

// resolveChartID answers "which chart" from the positional argument or the environment's own list.
//
// An id on the command line is passed through BYTE FOR BYTE and no listing call is made for it: an
// id is a lookup key, and resolving one against a list would let a listing failure block a command
// that had already been told its answer.
//
// `mayAsk` false with no id is a refusal that names the argument (input required, exit 9), not a
// picker that cannot draw.
func resolveChartID(c apiClient, id, project, env string, mayAsk bool, key, command string) (string, error) {
	if id != "" {
		return id, nil
	}
	if !mayAsk {
		return "", refusal(clierr.CodeInputRequired, "alethia chart list",
			"a chart id is required (pass it as the argument; on a terminal you are offered the attached charts)")
	}
	f := mustByoField(command, key)
	return promptChartID(func() (*api.ProjectByoCharts, error) {
		return c.GetProjectByoCharts(project, env)
	}, f, env)
}

// chartDetach detaches the chart and returns the result.
func chartDetach(c apiClient, project, env, id string) (MutationResult, error) {
	result := MutationResult{ID: id, Kind: byoChartKind, Action: ResultDeleted}
	if id == "" {
		return result, refusal(clierr.CodeMissingArgument, "alethia chart list", "a chart id is required")
	}
	if err := c.DetachChart(project, env, id); err != nil {
		return result, byoNotFoundHint(fmt.Errorf("detach chart %s: %w", id, err), "alethia chart list")
	}
	result.Object = byoTarget{Project: project, Env: env}
	return result, nil
}

var chartScanCmd = &cobra.Command{
	Use:   "scan [id]",
	Short: "Scan an attached chart so it can be deployed",
	Args:  cobra.MaximumNArgs(1),
	Long: `Queues a scan of an attached chart. The scan renders it and records the verdict the
plan-time gate reads, so an unscanned chart is refused at deploy.

The id is optional: omit it on a terminal and the environment's attached charts are offered.

Re-scan whenever the chart's repository moves. The result carries the scan's job id. With --wait
the command follows the job to its end: it exits 13 when the scan fails and 12 when --timeout
passes first (the scan keeps running). Without --wait, follow it with
"alethia jobs logs --latest --follow".`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runChartScanCmd(cmd, args); err != nil {
			fail(err)
		}
	},
}

// runChartScanCmd is `chart scan` from the command line to the printed result.
func runChartScanCmd(cmd *cobra.Command, args []string) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	mayAsk := interactiveTable(cmd)
	project, err := byoProject(cmd, token, mayAsk)
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	client := api.NewClient(token)
	id, err := resolveChartID(client, firstArg(args), project, env, mayAsk, byoKeyChartID, "alethia chart scan")
	if err != nil {
		return err
	}
	ctx, stop := byoInterruptContext()
	defer stop()
	result, err := chartScan(ctx, p, client, chartScanWait, project, env, id)
	if err != nil {
		return err
	}
	return printByoScan(p, result, "chart "+id)
}

// chartScan queues the scan of one chart and, with --wait, follows its job to the end.
func chartScan(ctx context.Context, p *Printer, c apiClient, wait waitFlags, project, env, id string) (MutationResult, error) {
	result := MutationResult{ID: id, Kind: byoChartKind, Action: ResultQueued}
	if id == "" {
		return result, refusal(clierr.CodeMissingArgument, "alethia chart list", "a chart id is required")
	}
	res, err := c.ScanChart(project, env, id)
	if err != nil {
		return result, byoNotFoundHint(fmt.Errorf("scan chart %s: %w", id, err), "alethia chart list")
	}
	return followByoScan(ctx, p, c, wait, result, chartScanJobType, byoTarget{Project: project, Env: env}, res)
}

// followByoScan fills a scan result from the queued job and, with --wait, waits for it. A scan the
// control plane answered without a job id cannot be followed; the result then carries no job and
// --wait has nothing to wait for, which is said on stderr.
func followByoScan(ctx context.Context, p *Printer, c jobPoller, wait waitFlags, result MutationResult,
	jobType string, target byoTarget, res *api.ByoScanResult) (MutationResult, error) {
	obj := byoScanObject{byoTarget: target, Warnings: []string{}}
	result.Object = obj
	if res == nil || res.JobID == "" {
		if wait.Wait {
			p.Warn("The control plane queued the scan without a job id, so there is nothing to wait for.")
		}
		return result, nil
	}
	// No p.JobQueued here: its notice names the id in a `jobs logs <id>` line, and the result line
	// already carries the id while the follow-up note says `--latest`.
	result.Job = &JobRef{ID: res.JobID, Type: jobType}
	obj.JobStatus = jobStatusQueued
	if wait.Wait {
		done, err := awaitJob(ctx, c, res.JobID, wait.options(jobType, p))
		if err != nil {
			return result, err
		}
		obj.JobStatus = done.Status
		obj.Warnings = jobWarnings(done)
	}
	result.Object = obj
	return result, nil
}

// printByoScan prints a scan result: the result on stdout, and — when the job is still running —
// the command that follows it on stderr. A scan is asynchronous, so the job id is the useful part of
// the result; without it a caller has to go looking.
func printByoScan(p *Printer, r MutationResult, what string) error {
	obj, _ := r.Object.(byoScanObject)
	err := p.Result(r, func(w io.Writer) {
		switch {
		case r.Job == nil:
			fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Queued a scan of the %s%s", what, envSuffix(obj.Env))))
		case strings.EqualFold(obj.JobStatus, jobStatusSuccess):
			fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Scan of the %s%s finished (job %s)", what, envSuffix(obj.Env), r.Job.ID)))
		default:
			fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Queued a scan of the %s%s (job %s)", what, envSuffix(obj.Env), r.Job.ID)))
		}
	})
	if err != nil {
		return err
	}
	for _, warning := range obj.Warnings {
		p.Warn(warning)
	}
	// The follow-up names NO id: `--latest` resolves the same job without one. The id itself stays
	// in the result, because a script that wants to poll a SPECIFIC job still needs it.
	if r.Job != nil && !strings.EqualFold(obj.JobStatus, jobStatusSuccess) {
		p.Note("Follow it: alethia jobs logs --latest --follow")
	}
	return nil
}

// --- IaC ---

var iacAttachCmd = &cobra.Command{
	Use:   "attach",
	Short: "Attach your own Terraform/OpenTofu source to an environment",
	Args:  cobra.NoArgs,
	Long: `Attaches a git repository holding your own Terraform/OpenTofu to one environment.

Omit a value on a terminal and you are asked for it, and the repository is CHOSEN from the ones
Alethia can already see rather than copied out of "alethia repo list". Every question has a flag,
so the same attach runs unattended; the run prints the flags that would have produced it. With
nobody to ask, a missing --repo is refused (exit 9) and nothing is sent.

An environment holds at most ONE source, so re-attaching replaces it. --var sets scalar tfvars
(string, number or bool only — never a secret; the server refuses anything nested).

The source is not deployable until scanned: run "alethia iac scan" next.

A PRIVATE repository needs no credential here. The runner fetches a short-lived token at job
time from your linked GitHub/GitLab account, scoped to the repositories this project declares.
Link that account once in the console; nothing is stored against the source.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runIacAttachCmd(cmd); err != nil {
			fail(err)
		}
	},
}

// runIacAttachCmd is `iac attach` from the command line to the printed result.
func runIacAttachCmd(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	mayAsk := interactiveTable(cmd)
	project, err := byoProject(cmd, token, mayAsk)
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	vars, err := parseSetValues(iacAttachVar)
	if err != nil {
		return err
	}
	client := api.NewClient(token)
	params := api.AttachIacParams{
		Project: project, Env: env, RepoURL: iacAttachRepo, Ref: iacAttachRef,
		Path: iacAttachPath, VarValues: vars,
	}
	params, asked, err := askIacAttach(params, client.GetRepositories, mayAsk)
	if err != nil {
		return err
	}
	result, err := iacAttach(client, params)
	if err != nil {
		return err
	}
	if err := printIacAttach(p, result); err != nil {
		return err
	}
	printReplay(p.Err, p.Format, asked, iacAttachReplayArgs(params)...)
	return nil
}

// askIacAttach fills in whatever `iac attach` was not told, and reports whether it asked.
//
// The same three rules as askChartAttach: only missing values are asked for, `mayAsk` false leaves
// the params exactly as the flags set them, and --var is not asked because a repeatable scalar
// key=value is a poor single-line question and is never required to attach a source.
//
// --path is asked with an EMPTY answer allowed, and that emptiness is meaningful: it is the
// repository root, which is what an unset --path has always meant. The question exists so a reader
// learns the field is there, not to make it mandatory.
func askIacAttach(p api.AttachIacParams, list repoLister, mayAsk bool) (api.AttachIacParams, bool, error) {
	if !mayAsk {
		return p, false, nil
	}
	asked := false
	if p.RepoURL == "" {
		f := mustByoField("alethia iac attach", byoKeyRepo)
		v, err := promptRepoURL(list, f)
		if err != nil {
			return p, asked, err
		}
		p.RepoURL, asked = strings.TrimSpace(v), true
	}
	for _, q := range []struct {
		key string
		dst *string
	}{
		{byoKeyPath, &p.Path},
		{byoKeyRef, &p.Ref},
	} {
		if *q.dst != "" {
			continue
		}
		f := mustByoField("alethia iac attach", q.key)
		v, err := askLine(f.Title, f.Description)
		if err != nil {
			return p, asked, err
		}
		*q.dst, asked = v, true
	}
	return p, asked, nil
}

// iacAttachReplayArgs renders the flags that reproduce an attach without the questions.
func iacAttachReplayArgs(p api.AttachIacParams) []string {
	args := []string{"alethia", "iac", "attach"}
	for _, kv := range [][2]string{
		{"--project", p.Project},
		{"--env", p.Env},
		{"--repo", p.RepoURL},
		{"--path", p.Path},
		{"--ref", p.Ref},
	} {
		if kv[1] != "" {
			args = append(args, kv[0], kv[1])
		}
	}
	for _, v := range iacAttachVar {
		args = append(args, "--var", v)
	}
	return args
}

// iacAttach attaches the source and returns the result. A missing --repo is refused before anything
// is sent, as input_required.
func iacAttach(c apiClient, p api.AttachIacParams) (MutationResult, error) {
	result := MutationResult{Kind: byoIacKind, Action: ResultUpdated}
	if p.RepoURL == "" {
		return result, refusal(clierr.CodeInputRequired, "alethia repo list",
			"--repo is required (omit it on a terminal and you are asked)")
	}
	res, err := c.AttachIac(p)
	if err != nil {
		return result, fmt.Errorf("attach IaC source: %w", err)
	}
	if res != nil {
		result.ID = res.ID
	}
	result.Object = iacAttachObject{
		byoTarget: byoTarget{Project: p.Project, Env: p.Env},
		RepoURL:   p.RepoURL, Path: p.Path, Ref: p.Ref,
	}
	return result, nil
}

// printIacAttach prints an IaC attach result, and on stderr the scan that has to follow it.
func printIacAttach(p *Printer, r MutationResult) error {
	if err := p.Result(r, func(w io.Writer) { renderIacAttach(w, r) }); err != nil {
		return err
	}
	p.Note("Scan it before deploying: alethia iac scan")
	return nil
}

// renderIacAttach is the person's line for an IaC attach result.
func renderIacAttach(w io.Writer, r MutationResult) {
	obj, _ := r.Object.(iacAttachObject)
	fmt.Fprintln(w, ui.FormatSuccess(fmt.Sprintf("Attached IaC source %s%s", obj.RepoURL, envSuffix(obj.Env))))
}

var iacDetachCmd = &cobra.Command{
	Use:   "detach",
	Short: "Detach the environment's Terraform/OpenTofu source",
	Args:  cobra.NoArgs,
	Long: `Detaches the BYO Terraform/OpenTofu source from one environment. Alethia stops managing what
the source created; the resources it applied are NOT destroyed — run a destroy first if that is
what you want.

The confirmation names the environment. Scripts pass --yes; without it and with nobody to ask, the
command refuses (exit 9) and detaches nothing.`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runIacDetachCmd(cmd); err != nil {
			fail(err)
		}
	},
}

// runIacDetachCmd is `iac detach` from the command line to the printed result.
func runIacDetachCmd(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	project, err := byoProject(cmd, token, interactiveTable(cmd))
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	ok, err := confirmOrRefuse(iacDetachYes, "Detach the IaC source"+envSuffix(env)+"?",
		"Alethia stops managing what it created. Resources it applied are NOT destroyed — run a destroy first if that is what you want.")
	if err != nil || !ok {
		return err
	}
	result, err := iacDetach(api.NewClient(token), project, env)
	if err != nil {
		return err
	}
	return p.Result(result, func(w io.Writer) { renderByoDetach(w, result) })
}

// iacDetach detaches the source and returns the result. An environment holds at most one source, so
// the environment is the whole address and the result has no id of its own.
func iacDetach(c apiClient, project, env string) (MutationResult, error) {
	result := MutationResult{Kind: byoIacKind, Action: ResultDeleted}
	if err := c.DetachIac(project, env); err != nil {
		return result, byoNotFoundHint(fmt.Errorf("detach IaC source: %w", err), "alethia iac show")
	}
	result.Object = byoTarget{Project: project, Env: env}
	return result, nil
}

var iacScanCmd = &cobra.Command{
	Use:   "scan",
	Short: "Scan the environment's IaC source so it can be deployed",
	Args:  cobra.NoArgs,
	Long: `Queues a scan of the environment's BYO Terraform/OpenTofu source. The scan reads the
module's variables and records the verdict the plan-time gate reads, so an unscanned source is
refused at deploy. Re-scan whenever the repository moves.

The result carries the scan's job id. With --wait the command follows the job to its end: it
exits 13 when the scan fails and 12 when --timeout passes first (the scan keeps running). Without
--wait, follow it with "alethia jobs logs --latest --follow".`,
	Run: func(cmd *cobra.Command, args []string) {
		if err := runIacScanCmd(cmd); err != nil {
			fail(err)
		}
	},
}

// runIacScanCmd is `iac scan` from the command line to the printed result.
func runIacScanCmd(cmd *cobra.Command) error {
	token, err := getAuthToken()
	if err != nil {
		return err
	}
	p := printerFor(cmd)
	project, err := byoProject(cmd, token, interactiveTable(cmd))
	if err != nil {
		return err
	}
	env, _ := cmd.Flags().GetString("env")
	ctx, stop := byoInterruptContext()
	defer stop()
	result, err := iacScan(ctx, p, api.NewClient(token), iacScanWait, project, env)
	if err != nil {
		return err
	}
	return printByoScan(p, result, "IaC source")
}

// iacScan queues the scan of the environment's source and, with --wait, follows its job to the end.
func iacScan(ctx context.Context, p *Printer, c apiClient, wait waitFlags, project, env string) (MutationResult, error) {
	result := MutationResult{Kind: byoIacKind, Action: ResultQueued}
	res, err := c.ScanIac(project, env)
	if err != nil {
		return result, byoNotFoundHint(fmt.Errorf("scan IaC source: %w", err), "alethia iac show")
	}
	return followByoScan(ctx, p, c, wait, result, iacScanJobType, byoTarget{Project: project, Env: env}, res)
}

func init() {
	chartAttachCmd.Flags().StringVar(&chartAttachRepo, "repo", "", byoFlagUsage("alethia chart attach", byoKeyRepo))
	chartAttachCmd.Flags().StringVar(&chartAttachPath, "chart-path", "", byoFlagUsage("alethia chart attach", byoKeyChartPath))
	chartAttachCmd.Flags().StringVar(&chartAttachRef, "ref", "", byoFlagUsage("alethia chart attach", byoKeyRef))
	chartAttachCmd.Flags().StringVar(&chartAttachNamespace, "namespace", "", byoFlagUsage("alethia chart attach", byoKeyNamespace))
	chartAttachCmd.Flags().StringVar(&chartAttachValuesFile, "values-file", "", byoFlagUsage("alethia chart attach", byoKeyValuesFile))
	chartAttachCmd.Flags().StringArrayVar(&chartAttachSet, "set", nil, byoFlagUsage("alethia chart attach", byoKeySet))
	addYesFlag(chartDetachCmd, &chartDetachYes)
	addWaitFlags(chartScanCmd, &chartScanWait, false)
	chartCmd.AddCommand(chartAttachCmd, chartDetachCmd, chartScanCmd)

	iacAttachCmd.Flags().StringVar(&iacAttachRepo, "repo", "", byoFlagUsage("alethia iac attach", byoKeyRepo))
	iacAttachCmd.Flags().StringVar(&iacAttachRef, "ref", "", byoFlagUsage("alethia iac attach", byoKeyRef))
	iacAttachCmd.Flags().StringVar(&iacAttachPath, "path", "", byoFlagUsage("alethia iac attach", byoKeyPath))
	iacAttachCmd.Flags().StringArrayVar(&iacAttachVar, "var", nil, byoFlagUsage("alethia iac attach", byoKeyVar))
	addYesFlag(iacDetachCmd, &iacDetachYes)
	addWaitFlags(iacScanCmd, &iacScanWait, false)
	iacCmd.AddCommand(iacAttachCmd, iacDetachCmd, iacScanCmd)
}
