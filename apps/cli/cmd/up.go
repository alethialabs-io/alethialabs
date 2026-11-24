// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/manifest"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/runners"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/spf13/cobra"
)

// `alethia up` — the whole golden path (#3662) as one command: a person with a repository, or with
// nothing at all, reaches a running cluster.
//
// It is `init` and `apply` composed, and every step is SKIPPED WHEN ALREADY SATISFIED, which is
// what makes it resumable rather than a script that must be run exactly once:
//
//	1. a control-plane URL   — persisted already? skip
//	2. a login               — a live credential? skip
//	3. a cloud account       — one connected? skip; otherwise STOP and name the command, because
//	                           attaching one is a per-cloud keyless flow, not a question
//	4. a runner              — something that will claim the deploy? say what; otherwise STOP and
//	                           name the command, because a deploy nothing claims waits for ever
//	5. alethia.yaml          — a file in this directory? skip; otherwise author one
//	6. apply                 — the plan, the confirmation, the deploys
//
// Steps 3 and 4 are the two that can stop the run, and that is deliberate. The others either have
// an answer or can ask for one. A connector is `alethia connector <cloud>`, one keyless flow per
// cloud with its own arguments, and re-implementing the choice inside `up` would be one more
// surface that drifts from them. A runner is a process somebody has to start.
//
// Everything `up` says about its own progress goes to stderr. Stdout carries what `apply` prints:
// the plan and the result.

// upSpec is what `up` takes. It is `apply`'s spec plus the manifest-authoring fields `init` takes,
// because `up` is the two commands composed and must be scriptable as either.
var upSpec = spec.Spec{
	Command: "alethia up",
	Fields: []spec.Field{
		{Command: "alethia up", Key: "file", Title: "Manifest",
			Description: "The alethia.yaml to apply, written when it does not exist yet",
			Flag:        "file", Shorthand: "f", Default: manifest.FileName, Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "project", Title: "Project name",
			Description: "Name for a project this authors (asked for on a terminal when the file is missing)",
			Flag:        "project", ManifestKey: "project", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "region", Title: "Region",
			Description: "Cloud region for a project this authors", Flag: "region",
			EnvVar: "ALETHIA_REGION", ManifestKey: "cloud.region", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "account", Title: "Cloud account",
			Description: "Cloud account to link, by its LABEL or its id", Flag: "cloud-account",
			Selector: "label", ManifestKey: "cloud.account", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "stage", Title: "Stage",
			Description: "Stage for the environment this authors", Flag: "stage",
			Default: string(stageDevelopment), Options: "stages",
			ManifestKey: "stage", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: fieldKeyInstanceType, Title: "Machine type",
			Description: instanceTypeDescription, Flag: fieldKeyInstanceType, Page: docsPlanApplyPage},
		{Command: "alethia up", Key: fieldKeyNodeSize, Title: "Node size",
			Description: nodeSizeDescription, Flag: fieldKeyNodeSize, Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "runner", Title: "Runner",
			Description: "Runner to deploy with, by NAME or id. Omitted: the only online runner, or asked on a terminal",
			Flag:        "runner", Selector: "name", Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "yes", Title: "Confirm",
			Description: "Apply without asking (required with --no-input)",
			Flag:        "yes", Shorthand: "y", Bool: true, Page: docsPlanApplyPage},
		{Command: "alethia up", Key: "no-wait", Title: "Wait",
			Description: "Queue the deploys and return instead of waiting for them or for a person's approval (exits 9 when one is needed)",
			Flag:        "no-wait", Bool: true, Page: docsPlanApplyPage},
	},
	Options: map[string][]string{"stages": environmentStages()},
}

var upBinder *spec.Binder

var upCmd = &cobra.Command{
	Use:   "up",
	Short: "From nothing to a running project: sign in, write alethia.yaml, and deploy it",
	Long: `The whole first run in one command. Use it in a new directory to go from nothing to a
running cluster, and run it again whenever a run stopped: it resumes where the last one ended.

It works through six steps and skips each one that is already done:

  1. the control-plane URL    asked for once, then kept
  2. the sign-in              a browser approval of a device code
  3. a cloud account          checked, never created here
  4. a runner                 checked, never created here
  5. alethia.yaml             written when this directory has none
  6. apply                    the plan, one confirmation, one deploy per environment

Steps 3 and 4 are the two that can stop the run. Connecting a cloud account is a separate flow
for each cloud, and a runner is a process that has to be started, so "up" stops and prints the
command to run. Run that command, then run "alethia up" again.

Progress is written to stderr. Stdout carries the plan and the result, so "--output json" is one
document. Each environment is previewed before it is deployed, and a deploy from the CLI waits for
a person's approval of its plan in the console, as "alethia apply" describes. While it waits for a
deploy it says so when no runner has claimed it yet; the job keeps its place if you stop waiting.
A preview or a deploy that fails exits 13 and names the job; "alethia jobs logs" shows why.

With alethia.yaml present, an account connected and a runner available, "alethia up" is
"alethia apply".`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, _ []string) {
		values, err := spec.Resolve(upBinder, spec.Sources{Env: os.LookupEnv})
		if err != nil {
			fail(err)
		}
		format := outputFormat(cmd)
		p := printer

		// 1 and 2. A live credential is the whole of "is this machine set up": `getAuthToken`
		// reads the persisted one, refreshes it, or takes ALETHIA_TOKEN. Only when there is none
		// does the origin get asked for, because asking a logged-in person which control plane
		// they meant is a question with an answer already on disk.
		token, err := ensureLoggedIn(p)
		if err != nil {
			fail(err)
		}
		client := api.NewClient(token)

		// 3. The first step that can stop the run.
		identities, err := ensureCloudAccount(client, p, values.Get("account"))
		if err != nil {
			fail(err)
		}

		// 4. The second. It runs BEFORE the manifest is authored whenever the cloud the deploy
		// goes to is already known, because a refusal is worth having before five questions
		// rather than after them. When the account is still an open question it runs after the
		// file has answered it.
		path := values.Get("file")
		runnerRef := values.Get("runner")
		account, known := upTargetAccount(identities, path, values.Get("account"))
		if known {
			if runnerRef, err = ensureRunner(client, p, runnerRef, account); err != nil {
				fail(err)
			}
		}

		// 5. The file, authored when this directory has none.
		if !manifest.Exists(path) {
			if _, err := authorManifest(client, token, path, values); err != nil {
				fail(err)
			}
			firstRunStep(p, "Wrote "+path)
		} else if err := refuseAuthoringFlags(cmd, path); err != nil {
			fail(err)
		}
		if !known {
			account, _ = upTargetAccount(identities, path, "")
			if runnerRef, err = ensureRunner(client, p, runnerRef, account); err != nil {
				fail(err)
			}
		}

		// 6. Everything `alethia apply` does, through the same code — a second implementation of
		// the plan, the confirmation and the deploy ordering is exactly what this epic exists to
		// stop having.
		yes, _ := upBinder.Bool("yes")
		noWait, _ := upBinder.Bool("no-wait")
		var applyWith applyClient = client
		if !noWait {
			applyWith = newDeployWatcher(client, p)
		}
		// No project name is passed: `runApply`'s closing line reads it from the manifest it just
		// applied, which is the project that actually came up. `values.Get("project")` is the
		// FLAG, and when the directory already held a manifest the two disagree.
		runApply(cmd, applyWith, token, applyOptions{
			file:   path,
			runner: runnerRef,
			yes:    yes,
			noWait: noWait,
			format: format,
		})
	},
}

// firstRunStep reports one finished step of the golden path on p's Err stream: a tick and the
// sentence for a person, the bare sentence for an agent.
func firstRunStep(p *Printer, msg string) {
	if p.Mode.Agent {
		fmt.Fprintln(p.Err, msg)
		return
	}
	fmt.Fprintf(p.Err, "%s %s\n", ui.SymbolSuccess, msg)
}

// firstRunEmit writes a command's result through the running Printer, and takes the fatal path
// when the result has no form in the format that was asked for.
func firstRunEmit(v any, human func(io.Writer)) {
	if err := printer.Result(v, human); err != nil {
		fail(err)
	}
}

// firstRunErr gives err the class of code and the next step hint, unless err already carries a
// class or a hint of its own: an error the control plane classified keeps what it said.
func firstRunErr(code string, err error, hint string) error {
	e := clierr.From(err)
	if e.Class == clierr.ClassUnclassified {
		e = clierr.Wrap(code, err)
	} else {
		// From may hand back a shared sentinel; the hint is set on a copy.
		shared := *e
		e = &shared
	}
	if e.Hint == "" {
		e.Hint = hint
	}
	return e
}

// authoringFlags are the `up` flags that only ever reach `authorManifest`. Each is read solely to
// WRITE the manifest, so once a manifest exists none of them can change anything.
var authoringFlags = []string{"project", "region", "stage", "cloud-account", fieldKeyInstanceType, fieldKeyNodeSize}

// refuseAuthoringFlags stops `up` when a manifest-authoring flag was passed for a manifest that
// already exists.
//
// Ignoring them silently is the failure this refuses: `alethia up --project boutique --region nbg1
// --cloud-account prod --yes` in a directory still holding `legacy-app`'s manifest would create and
// DEPLOY legacy-app without a word about the four flags it was handed — a flag that is silently
// dropped reads as a flag that worked. `--cloud-account` is the subtlest of the four, because it is
// validated a few lines above and then not applied, so it looks the most like it took effect.
//
// Only flags CHANGED on the command line count. The same keys also resolve from the environment and
// from the manifest itself (`ManifestKey`), and a value that came from the file cannot contradict
// it; `stage` additionally carries a default, so a non-empty value proves nothing.
func refuseAuthoringFlags(cmd *cobra.Command, path string) error {
	var given []string
	for _, f := range authoringFlags {
		if cmd.Flags().Changed(f) {
			given = append(given, "--"+f)
		}
	}
	if len(given) == 0 {
		return nil
	}
	list := strings.Join(given, ", ")
	e := clierr.New(clierr.CodeInvalidUsage, fmt.Sprintf(
		"%s already exists, so %s would be ignored: those flags only ever author a new manifest, and "+
			"this run applies the one on disk", path, list))
	e.Hint = "drop them and let the file speak, or point --file at a path that does not exist yet"
	return e
}

// ensureLoggedIn returns a usable token, running the first-run setup when there is none.
//
// It reports what it SKIPPED as well as what it did. "Already signed in" is the difference between
// a command that looks like it did nothing and one a person can trust to be resumable.
func ensureLoggedIn(p *Printer) (string, error) {
	if token, err := getAuthTokenInternal(false); err == nil && token != "" {
		firstRunStep(p, "Already signed in to "+WebOrigin())
		return token, nil
	}
	// A machine-readable run cannot carry the first-run setup. `performLoginFlow` writes the
	// device code to stdout — it is the point of the flow, so it cannot be silenced — and that
	// prose would land ahead of the result document and break the caller's parse.
	//
	// Checked BEFORE the terminal test because it does not depend on one: `up --output json` with
	// no credential cannot succeed on a terminal either, and this message names both remedies, so
	// nothing is lost by answering the output question first.
	if p.Format != ui.FormatTable {
		e := clierr.New(clierr.CodeAuthRequired, fmt.Sprintf(
			"not signed in, and --output %s cannot run the first-run sign-in: it prints a device code "+
				"that would corrupt the document", p.Format))
		e.Hint = "alethia login   (or set " + ServiceTokenEnv + " to a service token)"
		return "", e
	}
	if !canPromptForm() {
		e := clierr.New(clierr.CodeAuthRequired,
			"not signed in, and interactive prompts are unavailable (--no-input, or stdin is not a terminal)")
		e.Hint = "set " + ServiceTokenEnv + " to a service token, or run `alethia login` on a terminal first"
		return "", e
	}
	origin, err := promptWebOrigin("")
	if err != nil {
		return "", err
	}
	if err := runConfigSet(p.Err, "web-origin", origin); err != nil {
		return "", err
	}
	if err := performLoginFlow(); err != nil {
		return "", err
	}
	return getAuthToken()
}

// connectorCommands returns `alethia connector <cloud>` for every cloud this build offers, in the
// catalog's order. It is derived, never typed: a cloud the catalog hides is not named here.
func connectorCommands() []string {
	var out []string
	for _, provider := range EnabledCloudProviders() {
		out = append(out, "alethia connector "+string(provider))
	}
	return out
}

// ensureCloudAccount returns the organization's connected cloud accounts, and refuses, with the
// command to run, when there is none.
//
// It does not offer to attach one. `alethia connector <cloud>` is one keyless flow per cloud, each
// with its own arguments — cliDemoConnectorFlags in the e2e harness is the measurement of how
// different — so one more surface inside `up` would be one more thing to keep in step with them,
// and it would drift the way every other "one product, two implementations" pair in this epic
// drifted.
func ensureCloudAccount(c cloudIdentityLister, p *Printer, wanted string) ([]api.CloudIdentity, error) {
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return nil, fmt.Errorf("list cloud accounts: %w", err)
	}
	if len(identities) == 0 {
		commands := connectorCommands()
		e := clierr.New(clierr.CodeConflict,
			"no cloud account is connected, and a project needs one to deploy into. Connect one with: "+
				strings.Join(commands, " · "))
		if len(commands) > 0 {
			e.Hint = commands[0] + "   then run this command again"
		}
		return nil, e
	}
	if wanted != "" {
		// Resolved HERE rather than at apply time, because the refusal is worth having before a
		// form asks for a project name: an unknown label is a typo, and finding out after five
		// questions is worse than finding out before them.
		account, err := matchCloudIdentity(identities, wanted)
		if err != nil {
			return nil, firstRunErr(clierr.CodeNotFound, err, "alethia provider status")
		}
		firstRunStep(p, fmt.Sprintf("Cloud account %s (%s)", account.Label, account.Provider))
		return identities, nil
	}
	firstRunStep(p, plural(len(identities), "cloud account")+" connected")
	return identities, nil
}

// upTargetAccount returns the cloud account this run deploys into, and whether that is decided
// yet. An existing manifest decides it; without one, the --cloud-account value does, and so does
// an organization with exactly one account, which is the account authorManifest takes without
// asking. A reference that matches nothing is "not decided": the step that owns the reference
// reports it.
func upTargetAccount(identities []api.CloudIdentity, path, flagValue string) (api.CloudIdentity, bool) {
	ref := flagValue
	if manifest.Exists(path) {
		m, err := manifest.Load(path)
		if err != nil {
			// The apply reads the file again and reports why it cannot be read.
			return api.CloudIdentity{}, false
		}
		ref = m.Cloud.Account
	}
	if ref != "" {
		account, err := matchCloudIdentity(identities, ref)
		return account, err == nil
	}
	if len(identities) == 1 {
		return identities[0], true
	}
	return api.CloudIdentity{}, false
}

// ── the runner step ───────────────────────────────────────────────────────────────────────

// runnerStatusOnline is the status of a runner that is connected and claiming jobs.
const runnerStatusOnline = "ONLINE"

// runnerSource is what ensureRunner reads: the runners this caller can see, and the managed
// fleet's pools where the control plane shows them.
type runnerSource interface {
	GetRunners() ([]api.Runner, error)
	ListFleetPools() ([]api.FleetPool, error)
}

// runnerList answers GetRunners from a list already fetched, so resolveRunnerRef can name a
// runner without a second request.
type runnerList []api.Runner

// GetRunners returns the list.
func (l runnerList) GetRunners() ([]api.Runner, error) { return l, nil }

// runnerServes reports whether a runner takes jobs for a cloud. A runner that lists no cloud takes
// every one, and an unknown cloud is served by any runner.
func runnerServes(r api.Runner, cloud string) bool {
	return cloud == "" || len(r.SupportedProviders) == 0 || slices.Contains(r.SupportedProviders, cloud)
}

// runnerOwner says whose runner r is, for the line that names it.
func runnerOwner(r api.Runner) string {
	if r.Operator == "managed" {
		return "managed"
	}
	return "yours"
}

// hostedControlPlane reports whether origin is the hosted Alethia control plane: its host, or a
// host under it.
//
// This is how the CLI tells the two deployments apart, and the reason it has to: the hosted
// control plane runs a managed fleet that claims any organization's unassigned deploy, and does
// not list that fleet to its tenants. An empty runner list there is the ordinary case. Everywhere
// else the list is the whole truth, because a self-hosted control plane lists its managed runners
// too.
func hostedControlPlane(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	hosted := strings.TrimPrefix(types.DefaultWebOrigin, "https://")
	host := strings.ToLower(u.Hostname())
	return host == hosted || strings.HasSuffix(host, "."+hosted)
}

// fleetWillStartARunner reports whether the control plane shows an enabled managed pool. Such a
// pool starts a runner when a job is queued, so an empty runner list is not a dead end. A caller
// who may not read the pools gets false: nothing can be promised from a refusal.
func fleetWillStartARunner(c runnerSource) bool {
	pools, err := c.ListFleetPools()
	if err != nil {
		return false
	}
	for _, pool := range pools {
		if pool.Enabled && pool.Max > 0 {
			return true
		}
	}
	return false
}

// ensureRunner says what will claim this run's deploys, or refuses with the command that makes
// something able to. It returns the runner reference the apply should use: the one named, the
// only runner that can take the job, or "" to leave the job for whichever claims it.
//
// The rule, in order:
//
//   - a runner named with --runner must exist, be online, and serve the account's cloud;
//   - otherwise the online runners that serve the cloud are counted. One is named. Several are
//     counted, and the apply asks which on a terminal;
//   - with none, the managed fleet takes the deploy where there is one: on the hosted control
//     plane, or where an enabled pool is shown;
//   - with none of those, nothing would ever claim the deploy, and the run stops here, before a
//     project is created and a job is queued that would wait for ever.
func ensureRunner(c runnerSource, p *Printer, ref string, account api.CloudIdentity) (string, error) {
	list, err := c.GetRunners()
	if err != nil {
		return "", fmt.Errorf("list runners: %w", err)
	}
	cloud := account.Provider

	if ref != "" {
		id, err := resolveRunnerRef(runnerList(list), "--runner", ref)
		if err != nil {
			return "", firstRunErr(clierr.CodeNotFound, err, "alethia runner list")
		}
		named := list[slices.IndexFunc(list, func(r api.Runner) bool { return r.ID == id })]
		if named.Status != runnerStatusOnline {
			e := clierr.New(clierr.CodeConflict, fmt.Sprintf(
				"runner %q is %s, so it cannot take this deploy", named.Name, named.Status))
			e.Hint = "alethia runner list   then start it, or name another with --runner"
			return "", e
		}
		if !runnerServes(named, cloud) {
			e := clierr.New(clierr.CodeConflict, fmt.Sprintf(
				"runner %q does not take %s jobs (it takes %s)",
				named.Name, cloud, strings.Join(named.SupportedProviders, ", ")))
			e.Hint = "alethia runner list   then name one that does with --runner"
			return "", e
		}
		firstRunStep(p, fmt.Sprintf("Runner %s (%s) takes the deploy", named.Name, runnerOwner(named)))
		return id, nil
	}

	var usable []api.Runner
	for _, r := range list {
		if r.Status == runnerStatusOnline && runnerServes(r, cloud) {
			usable = append(usable, r)
		}
	}
	switch {
	case len(usable) == 1:
		firstRunStep(p, fmt.Sprintf("Runner %s (%s) takes the deploy", usable[0].Name, runnerOwner(usable[0])))
		return usable[0].ID, nil
	case len(usable) > 1:
		firstRunStep(p, fmt.Sprintf("%d runners are online and can take the deploy", len(usable)))
		return "", nil
	case hostedControlPlane(WebOrigin()):
		firstRunStep(p, "The Alethia managed fleet takes the deploy (no runner of your own is needed)")
		return "", nil
	case fleetWillStartARunner(c):
		firstRunStep(p, "The managed fleet takes the deploy, and starts a runner for it when it is queued")
		return "", nil
	}
	return "", noRunnerRefusal(list, account)
}

// noRunnerRefusal is the answer when nothing would claim the deploy: what was looked for, what
// is there instead, and the one command that fixes it for this account's cloud.
func noRunnerRefusal(list []api.Runner, account api.CloudIdentity) error {
	what := "no runner is online"
	if account.Provider != "" {
		what = "no online runner takes " + account.Provider + " jobs"
	}
	var there []string
	anyOnline := false
	for _, r := range list {
		there = append(there, fmt.Sprintf("%s is %s", r.Name, r.Status))
		anyOnline = anyOnline || r.Status == runnerStatusOnline
	}
	state := "it has no runner at all"
	if len(there) > 0 {
		state = strings.Join(there, ", ")
	}
	e := clierr.New(clierr.CodeConflict, fmt.Sprintf(
		"nothing would claim this deploy: %s on %s (%s), and it has no managed fleet. "+
			"Nothing was created and no job was queued", what, WebOrigin(), state))
	e.Hint = runnerCommandFor(account, anyOnline) + "   then run this command again"
	return e
}

// runnerCommandFor returns the command that adds a runner able to take account's jobs.
//
// `runner deploy` builds one inside the account, and is offered only where it can work: the cloud
// has a runner template, and a runner is already online to run the build, because building a
// runner is itself a job. Everywhere else the answer is `runner register`, which provisions
// nothing and works on every cloud.
func runnerCommandFor(account api.CloudIdentity, anyOnline bool) string {
	if anyOnline && account.Label != "" && runners.IsDeployProvider(account.Provider) {
		return fmt.Sprintf("alethia runner deploy --cloud-account %q", account.Label)
	}
	name := "first-runner"
	if account.Provider != "" {
		name = account.Provider + "-runner"
	}
	return "alethia runner register " + name
}

// ── the wait ──────────────────────────────────────────────────────────────────────────────

// jobStatusAwaitingApproval is the status of a job that is held until a person approves it in
// the console. No control plane sends it. The approval a CLI deploy needs (agent surface §4.3)
// is obtained BEFORE the job exists: the control plane refuses the deploy, the CLI asks for an
// approval of its plan and waits for it (approve.go), and only then is the job queued. This arm
// stays so a job that does report such a status is still said to wait on a person.
const jobStatusAwaitingApproval = "AWAITING_APPROVAL"

// queuedNoticeAfter is how long a deploy may sit unclaimed before the wait says so. It is a
// variable so a test can shorten it.
var queuedNoticeAfter = 2 * time.Minute

// deployWatcher is the client `up` hands to the apply when it waits: the same client, with every
// job poll also read for the two states in which a deploy is WAITING ON SOMEBODY rather than
// running. The wait loop itself treats any status it does not end on as "keep polling", which is
// right, and says only the status's name, which for these two is not enough:
//
//   - held for an approval: the person has to act, in the console, and the wait resumes on its
//     own once they have;
//   - queued and unclaimed for longer than queuedNoticeAfter: no runner has taken the job, and
//     the line names what to look at. The job keeps its place either way.
//
// Each is said once per job, on stderr, in every output format.
type deployWatcher struct {
	applyClient
	p     *Printer
	now   func() time.Time
	since map[string]time.Time
	said  map[string]bool
}

// newDeployWatcher wraps c so its job polls are narrated on p.
func newDeployWatcher(c applyClient, p *Printer) *deployWatcher {
	return &deployWatcher{
		applyClient: c, p: p, now: time.Now,
		since: map[string]time.Time{}, said: map[string]bool{},
	}
}

// GetJob polls the job through the wrapped client and narrates a waiting state it is in.
func (w *deployWatcher) GetJob(jobID string) (*api.ProvisionJob, error) {
	job, err := w.applyClient.GetJob(jobID)
	if err != nil || job == nil {
		return job, err
	}
	switch job.Status {
	case jobStatusAwaitingApproval:
		w.once(jobID+"/approval", fmt.Sprintf(
			"Job %s is waiting for approval. Approve it in the console at %s; this command "+
				"continues by itself once it is approved, and the job is not lost if you stop waiting.",
			jobID, WebOrigin()))
	case string(types.JobStatusQueued):
		first, seen := w.since[jobID]
		if !seen {
			w.since[jobID] = w.now()
			break
		}
		if w.now().Sub(first) >= queuedNoticeAfter {
			w.once(jobID+"/queued", fmt.Sprintf(
				"Job %s has been queued for %s and no runner has claimed it yet. `alethia runner list` "+
					"shows what is online. The job keeps its place: stop waiting with Ctrl+C and follow "+
					"it later with `alethia jobs logs %s --follow`.",
				jobID, queuedNoticeAfter, jobID))
		}
	}
	return job, nil
}

// once writes msg as one progress line the first time key is seen.
func (w *deployWatcher) once(key, msg string) {
	if w.said[key] {
		return
	}
	w.said[key] = true
	w.p.Progress(msg)
}

// ── the manifest ──────────────────────────────────────────────────────────────────────────

// authorManifest writes the alethia.yaml `up` is about to apply, and returns what it wrote.
//
// The values come through the SAME resolver every other command uses — flag, environment, manifest
// (there is none yet), form, default — so `up --no-input --project x --region y --cloud-account z`
// authors a file without a terminal, which is the contract that makes this scriptable at all.
//
// addons are written into the first environment; `init --addon` passes them and `up` passes none.
// It prints nothing: `up` reports the file as a step and `init` reports it as its result.
func authorManifest(
	c applyClient,
	token string,
	path string,
	values spec.Values,
	addons ...manifest.Addon,
) (*manifest.Manifest, error) {
	name, region, account := values.Get("project"), values.Get("region"), values.Get("account")
	// The node shape is checked FIRST, before any question: a malformed or doubled shape is a
	// mistake in the command line, and finding out after five answers is worse than before them.
	shape, err := nodeShapeFrom(values.Get(fieldKeyInstanceType), values.Get(fieldKeyNodeSize))
	if err != nil {
		return nil, firstRunErr(clierr.CodeInvalidFlag, err, "")
	}
	if canPromptForm() {
		if name == "" {
			if name, err = promptProjectName(); err != nil {
				return nil, err
			}
		}
		if region == "" {
			if region, err = promptRegion(); err != nil {
				return nil, err
			}
		}
		if account == "" {
			if account, err = promptCloudAccountLabel(c, token); err != nil {
				return nil, err
			}
		}
	}
	var missing []string
	for _, f := range []struct{ flag, value string }{
		{"--project", name}, {"--region", region}, {"--cloud-account", account},
	} {
		if f.value == "" {
			missing = append(missing, f.flag)
		}
	}
	if len(missing) > 0 {
		e := clierr.New(clierr.CodeInputRequired, fmt.Sprintf(
			"%s does not exist and cannot be written without %s, and there is no terminal to ask on",
			path, strings.Join(missing, ", ")))
		e.Hint = "pass " + strings.Join(missing, ", ") + ", or run this command on a terminal"
		return nil, e
	}

	// The matrix is the one thing a flag cannot say — it is a list of records. On a terminal it is
	// asked for; scripted, one environment at the given stage is the honest minimum, and `alethia
	// project env add` is how a second one arrives.
	environments := []api.EnvironmentSpec{
		{Name: values.Get("stage"), Stage: values.Get("stage"), PlacementMode: "dedicated", IsDefault: true},
	}
	if canPromptForm() {
		// Declining leaves the one-element fallback above — NOT a server-seeded pair. `apply`
		// creates exactly what this file says, so the question must describe the file.
		asked, err := promptEnvMatrix(fmt.Sprintf(
			"Otherwise the file declares one %s environment, and `alethia project env add` is how a second arrives",
			values.Get("stage")))
		if err != nil {
			return nil, err
		}
		if len(asked) > 0 {
			environments = asked
		}
	}

	m := manifestFromCreate(api.CreateProjectParams{
		ProjectName: name, Region: region, Environments: environments, NodeShape: shape,
	}, account)
	// `init --addon` (#5528): the first environment is the one the flags describe.
	if len(addons) > 0 && len(m.Environments) > 0 {
		m.Environments[0].Addons = addons
	}
	if err := manifest.Write(path, m, false); err != nil {
		return nil, err
	}
	return m, nil
}

// promptCloudAccountLabel asks which connected account to use and returns its LABEL, so what lands
// in the file is the name a person recognises rather than the id the picker resolves.
func promptCloudAccountLabel(c applyClient, token string) (string, error) {
	identities, err := c.GetCloudIdentities()
	if err != nil {
		return "", err
	}
	if len(identities) == 1 {
		// One account is not a question. The picker would show a list of one and make the person
		// press enter to confirm what they already have.
		return identities[0].Label, nil
	}
	id, err := selectCloudIdentity(token)
	if err != nil {
		return "", err
	}
	for _, i := range identities {
		if i.ID == id {
			return i.Label, nil
		}
	}
	return id, nil
}

func init() {
	upBinder = spec.RegisterFlags(upCmd, upSpec)
	rootCmd.AddCommand(upCmd)
}
