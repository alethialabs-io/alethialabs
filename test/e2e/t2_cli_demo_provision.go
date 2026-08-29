// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The CLI-only demo, ACTUALLY PERFORMED — MVP predicate 4's second clause.
//
// t2_cli_demo.go answers "does the command surface resolve": it runs `alethia <cmd> --help` for
// every step and ratchets both directions. That is a real claim and it is not this one. Nothing in
// this repo had ever PROVISIONED through the binary — the T2 spine writes the DEPLOY job straight
// into Postgres (controlplane.go's SeedDeployJob), so the CLI has never been the actor, and a
// prospect watching a demo is watching the actor.
//
// ── WHY A SECOND TABLE, AND WHY IT IS CROSS-CHECKED RATHER THAN MERGED ──
//
// CLIDemoSteps carries a command PREFIX (`{"project", "create"}`) because `--help` is all
// reachability needs. Performing the step needs a concrete invocation with real arguments, real
// ids threaded from the step before, and something to assert afterwards. Those are different
// shapes, so they are different tables.
//
// Two tables invite exactly one failure: they drift, and the bar silently stops performing a step
// while still reporting it. So every CLIDriven step must be accounted for in EXACTLY ONE of:
//
//	a BEAT           — the run performs it, with real arguments
//	cliDemoNotDriven — the run does not, and says why, in a sentence
//
// Neither a step with both nor a step with neither is allowed, and the check runs in the PURE half
// (t2_cli_demo_provision_pure_test.go) so it costs no cloud. That set difference is the same
// discipline MVP predicate 5 applies to the runbook beats, applied to its own harness — because
// "the bar does not quietly count a step it did not perform" is the only reason anyone should
// believe the bar.
//
// ── login IS THE RECORDED EXCEPTION, NOT A GAP ──
//
// The device flow needs a human by design; `ALETHIA_TOKEN` is the documented non-interactive
// substitute (apps/cli/cmd/auth_utils.go's ServiceTokenEnv, built for exactly this). That is
// written into cliDemoNotDriven rather than glossed, because a bar that quietly counted `login` as
// performed would be claiming the one thing it cannot do.

import (
	"fmt"
	"sort"
	"strings"
)

// CLIDemoRun is the state the beats thread through one another: ids the CLI mints as it goes.
//
// A struct rather than package-level vars because two beats read what a third wrote, and a
// half-populated run must be a visible zero value rather than a stale id left over from a previous
// invocation.
type CLIDemoRun struct {
	// Bin is the `alethia` binary under test.
	Bin string
	// Provider is the cloud this leg drives (hetzner|aws|gcp|azure|alibaba).
	Provider string
	// Region is the region the project provisions into.
	Region string
	// Project is the project NAME the run creates.
	Project string
	// EnvName is the environment the beats plan/apply/destroy against.
	EnvName string

	// ── minted as the run proceeds ──

	// ProjectID is captured from `project create`; every later beat addresses the project by id
	// rather than by name, because two projects may share a name (#2663) and resolving by name
	// would make the demo depend on which one the server picked.
	ProjectID string
	// IdentityID is the cloud identity `connector <cloud>` attached.
	IdentityID string
	// ApplyJobID is the DEPLOY job `project apply` enqueued — what `jobs logs` follows.
	ApplyJobID string
	// Token is the seeded service token the CLI authenticates with (ALETHIA_TOKEN).
	Token string
	// OrgID is the org that token is pinned to, and the org the harness MUST register its runner
	// in — see #392 and LoadCLIDemoCreds.
	OrgID string
	// APIBase is the REAL console the CLI talks to — never the runner shim, which serves no
	// user-facing endpoint and whose whole point is that faking those would prove the CLI against
	// a mock.
	APIBase string
	// RunnerID is the runner the harness registered. `project apply` REQUIRES it: without
	// --runner-id the CLI calls selectRunner(), which prompts — and a prompt in CI hangs until the
	// context kills it, reporting as "the CLI cannot reach apply" when the truth is that nobody
	// answered it.
	RunnerID string
}

// CLIDemoPhase says WHERE in the provisioning spine a beat can run. It exists because the demo's
// order and the harness's order are not the same order, and pretending otherwise deadlocks.
//
// The spine registers a runner row, enqueues a job, THEN starts the runner process, then waits.
// A beat that enqueues a job and blocks on it (`--wait`) before that process exists would wait
// forever on a claimer that has not started. A beat that reads the cluster before convergence
// would read nothing. So each beat declares the window it is valid in, and the driver runs one
// window at a time from the place in the spine that window means.
type CLIDemoPhase string

const (
	// CLIDemoAuthoring — needs the CONSOLE only: identity, the connector, and authoring the
	// project. No job, no runner, no cluster.
	CLIDemoAuthoring CLIDemoPhase = "authoring"
	// CLIDemoEnqueue — creates the PLAN and DEPLOY jobs. Runs where the spine used to seed its job
	// row, so the runner process starts immediately after and claims both. These beats must NOT
	// pass `--wait`: the CLI would block on a runner that does not exist yet.
	CLIDemoEnqueue CLIDemoPhase = "enqueue"
	// CLIDemoConverged — the read-backs, valid only once the cluster is up and asserted: logs, the
	// cluster, the signed receipt, drift, cost, add-ons.
	CLIDemoConverged CLIDemoPhase = "converged"
	// CLIDemoTeardown — the demo ends where it started. The spine's own teardown remains as the
	// guaranteed backstop; it is idempotent, so a cluster the CLI already destroyed costs a no-op.
	CLIDemoTeardown CLIDemoPhase = "teardown"
)

// CLIDemoBeat is one step of the demo, performed through the real binary.
type CLIDemoBeat struct {
	// Phase is the window this beat is valid in. Required: a beat with no phase would be silently
	// dropped by every driver call, which is the "defined but never executed" state this whole
	// tier exists to make impossible.
	Phase CLIDemoPhase
	// StepID names the CLIDemoSteps entry this performs. Validated: a beat naming a step that does
	// not exist is a typo that would otherwise make the cross-check pass by accident.
	StepID string
	// Args builds the concrete argv (without the binary). It takes the run so a beat can address
	// what an earlier one minted.
	Args func(r *CLIDemoRun) []string
	// Stdin, when non-empty, is written to the command's stdin. Used by the connector beats, whose
	// credentials must NOT travel in argv — /proc is world-readable and argv reaches the process
	// list, which is the same reason the runner's bootstrap Jobs pass names and never values.
	Stdin func(r *CLIDemoRun) string
	// After runs on success with the command's combined output: it captures ids into the run and
	// asserts what the step must have produced. A beat with no After proves only that the command
	// exited 0, which for a read-only step is the whole claim.
	After func(r *CLIDemoRun, out string) error
	// Why documents anything surprising about the invocation. Optional.
	Why string
}

// cliDemoNotDriven records, per step id, WHY the provisioning run does not perform it. Every entry
// is a sentence a reader can disagree with — "not applicable" would be indistinguishable from an
// oversight, which is the state this file exists to make impossible.
var cliDemoNotDriven = map[string]string{
	"login": "the device flow needs a human at a browser BY DESIGN, and ALETHIA_TOKEN is the " +
		"documented non-interactive substitute (apps/cli/cmd/auth_utils.go ServiceTokenEnv). The run " +
		"authenticates with a service token this job minted, so the step is performed by a different " +
		"mechanism than a prospect would use — recorded rather than counted.",

	// The BYO surfaces. Each needs a customer fixture repo, and each already has a dimension that
	// proves it end to end with those fixtures wired. Re-driving them here would buy the same proof
	// through a different actor while doubling the fixtures this dimension depends on.
	"chart-attach": "a customer Helm chart needs the A0.6 fixture repos, which the `gitops` dimension " +
		"wires and proves (E2E_ARGO_BYO_CHART_*). Driving it here would duplicate that dimension's " +
		"fixture surface without proving anything new about the CLI as the actor.",
	"chart-scan": "same fixture surface as chart-attach — proven by the `gitops` dimension.",
	"iac": "the BYO-IaC custody chain is the `byo-iac` dimension's whole assertion (a customer " +
		"OpenTofu root refused when unsafe, applied through the state proxy, drifted, healed, " +
		"destroyed, state cleared). It needs its own fixture module and its own budget.",
	"iac-attach": "same fixture surface as `iac` — proven by the `byo-iac` dimension.",
	"iac-scan":   "same fixture surface as `iac` — proven by the `byo-iac` dimension.",

	"promotion-approve": "an approval gate needs a promotion graph across two environments and a " +
		"protection rule to approve. That is B6's surface (t2_b6_promotion.go), which seeds it " +
		"directly; wiring it into a single-environment demo run would change what the demo IS.",

	"dns-delegation": "a CloudManual ceiling — delegating a real zone is a registrar action, so no " +
		"binary can perform it on any cloud. It is scored as a FAIL of the bar by maintainer ruling " +
		"and carries its own SatisfiedBy probe; performing it here is not possible by definition.",
}

// CLIDemoBeats is the ordered demo: an empty account to a running, verified, torn-down cluster.
//
// ORDER IS THE ARTIFACT. This is what a prospect watches, so the beats run in the sequence a human
// would type them, and a failure names the beat rather than a step number.
var CLIDemoBeats = []CLIDemoBeat{
	{
		StepID: "whoami",
		Phase:  CLIDemoAuthoring,
		Args:   func(_ *CLIDemoRun) []string { return []string{"whoami"} },
		Why:    "first command on a fresh machine — it proves the service token resolved to an org before anything is created.",
	},
	{
		StepID: "org-switch",
		Phase:  CLIDemoAuthoring,
		Args:   func(_ *CLIDemoRun) []string { return []string{"org", "list"} },
		Why: "`org list` rather than `org switch`: a service token is PINNED to one org by construction " +
			"(lib/cli/service-token.ts service_token_org_id), so switching is not a thing this credential " +
			"can do. Listing exercises the same org surface and does not pretend otherwise.",
	},
	{
		StepID: "connector",
		Phase:  CLIDemoAuthoring,
		Args:   func(r *CLIDemoRun) []string { return []string{"connector", r.Provider} },
		Stdin:  func(r *CLIDemoRun) string { return cliDemoConnectorStdin(r) },
		Why:    "credentials over STDIN, never argv — argv reaches /proc and the process list.",
	},
	{
		StepID: "project-create",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "create", r.Project, "--region", r.Region, "--stage", "development", "--output", "json"}
		},
		After: captureProjectID,
	},
	{
		StepID: "project-env",
		Phase:  CLIDemoAuthoring,
		Args:   func(r *CLIDemoRun) []string { return []string{"project", "env", "list", "--project-id", r.ProjectID} },
	},
	{
		StepID: "component-kinds",
		Phase:  CLIDemoAuthoring,
		Args:   func(_ *CLIDemoRun) []string { return []string{"project", "component", "kinds"} },
	},
	{
		StepID: "component-add",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "component", "add", "cluster", "--project-id", r.ProjectID, "--env", r.EnvName}
		},
	},
	{
		StepID: "staged",
		Phase:  CLIDemoAuthoring,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "get", "--project-id", r.ProjectID, "--output", "json"}
		},
	},
	{
		StepID: "plan",
		Phase:  CLIDemoEnqueue,
		Args: func(r *CLIDemoRun) []string {
			// NO --wait. The runner process starts AFTER this phase, so blocking here would wait
			// on a claimer that does not exist. The spine waits instead, on the DEPLOY job.
			return []string{"project", "plan", "--project-id", r.ProjectID, "--env", r.EnvName, "--runner-id", r.RunnerID}
		},
	},
	{
		StepID: "apply",
		Phase:  CLIDemoEnqueue,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "apply", "--project-id", r.ProjectID, "--env", r.EnvName, "--runner-id", r.RunnerID}
		},
		After: captureApplyJobID,
		Why: "the beat the whole dimension exists for — the DEPLOY job is enqueued BY THE CLI, not by a " +
			"seeded row. --runner-id is REQUIRED: without it the CLI calls selectRunner(), which prompts, " +
			"and a prompt in CI hangs until the context kills it and reports as an unreachable command.",
	},
	{
		StepID: "jobs-logs",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"jobs", "logs", r.ApplyJobID} },
	},
	{
		StepID: "cluster-get",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"clusters", "get", "--project-id", r.ProjectID} },
	},
	{
		StepID: "receipt-verify",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"verify", "--job-id", r.ApplyJobID} },
		Why:    "the signed ed25519 receipt sealed to the plan hash — the claim the demo's close rests on.",
	},
	{
		StepID: "drift",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"drift", "--project-id", r.ProjectID} },
	},
	{
		StepID: "cost",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"cost", "--project-id", r.ProjectID} },
	},
	{
		StepID: "addons",
		Phase:  CLIDemoConverged,
		Args:   func(r *CLIDemoRun) []string { return []string{"addon", "list", "--project-id", r.ProjectID} },
	},
	{
		StepID: "destroy",
		Phase:  CLIDemoTeardown,
		Args: func(r *CLIDemoRun) []string {
			return []string{"project", "destroy", "--project-id", r.ProjectID, "--env", r.EnvName, "--yes", "--wait"}
		},
		Why: "the demo ends where it started — and an un-torn-down demo is a standing bill, which the orphan reaper would otherwise find.",
	},
}

// cliDemoConnectorStdin returns the credential material `connector <cloud>` reads from stdin.
//
// Only hetzner is wired today, and deliberately: it is the one cloud whose connector takes a plain
// token, so it is the one that can be driven non-interactively without a keyless federation dance
// this harness would have to fake. The other clouds return "" and the beat is skipped with a
// recorded reason at run time rather than passing a credential the connector will reject.
func cliDemoConnectorStdin(r *CLIDemoRun) string {
	if r.Provider == "hetzner" {
		return strings.TrimSpace(t2Env("HCLOUD_TOKEN", ""))
	}
	return ""
}

// ValidateCLIDemoBeats holds the two tables to each other. Returns every problem at once, because
// fixing them one CI round-trip at a time is how a table this size stays wrong for a week.
//
// THREE ways it fails, and each is a real mistake rather than a style rule:
//
//	a beat naming no step        — a typo; the beat would run but be credited to nothing
//	a step both driven and not   — two answers to one question; the reader cannot tell which is true
//	a step with neither          — the silent omission this whole file exists to prevent
func ValidateCLIDemoBeats() error {
	steps := map[string]DemoStep{}
	for _, s := range CLIDemoSteps {
		steps[s.ID] = s
	}

	var problems []string
	driven := map[string]int{}
	for _, b := range CLIDemoBeats {
		if _, ok := steps[b.StepID]; !ok {
			problems = append(problems, fmt.Sprintf("beat %q names no step in CLIDemoSteps", b.StepID))
			continue
		}
		if b.Args == nil {
			problems = append(problems, fmt.Sprintf("beat %q has no Args — it would perform nothing", b.StepID))
		}
		// A beat with no phase is silently dropped by every DriveCLIDemoPhase call — defined,
		// counted by the cross-check, and never executed. That is the exact shape this tier exists
		// to make impossible, so it is a hard error rather than a default.
		switch b.Phase {
		case CLIDemoAuthoring, CLIDemoEnqueue, CLIDemoConverged, CLIDemoTeardown:
		default:
			problems = append(problems, fmt.Sprintf(
				"beat %q has phase %q, which no driver call runs — it would be defined and never executed", b.StepID, b.Phase))
		}
		driven[b.StepID]++
	}
	for id, n := range driven {
		if n > 1 {
			problems = append(problems, fmt.Sprintf("step %q has %d beats — the run would perform it twice and the report would name it once", id, n))
		}
	}
	for id := range cliDemoNotDriven {
		if _, ok := steps[id]; !ok {
			problems = append(problems, fmt.Sprintf("cliDemoNotDriven names %q, which is no step in CLIDemoSteps", id))
		}
		if driven[id] > 0 {
			problems = append(problems, fmt.Sprintf("step %q is BOTH driven by a beat and recorded as not-driven — one of the two is a lie", id))
		}
	}
	for _, s := range CLIDemoSteps {
		if s.Reach != CLIDriven {
			// A gap or a ceiling is not something the run could perform even in principle; the
			// reachability half already scores it, and scoring it twice would double-count.
			continue
		}
		if driven[s.ID] == 0 && cliDemoNotDriven[s.ID] == "" {
			problems = append(problems, fmt.Sprintf(
				"step %q is CLIDriven but the provisioning run neither performs it nor says why — "+
					"add a beat, or a sentence to cliDemoNotDriven", s.ID))
		}
	}

	if len(problems) == 0 {
		return nil
	}
	sort.Strings(problems)
	return fmt.Errorf("CLI demo beats do not account for the step table:\n  - %s", strings.Join(problems, "\n  - "))
}
