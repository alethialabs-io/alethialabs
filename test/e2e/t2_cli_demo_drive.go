// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The CALLER the `cli-demo` dimension was missing.
//
// #3303 landed the vehicle — the dimension resolves, exports its knob, takes a budget term, and its
// beat table is cross-checked against CLIDemoSteps. #3334 then made the dimension REFUSE itself,
// because a vehicle with no driver would have provisioned a floor, asserted the floor, and been
// recorded as a CLI-driven proof: an assertion that is TRUE and about the wrong thing.
//
// This is the driver. It executes the beats against the real binary, in the four windows
// CLIDemoPhase names, from the places in the provisioning spine where those windows actually exist.
//
// ── WHY PHASES RATHER THAN ONE LOOP ──
//
// The demo's order and the harness's order are not the same order. A prospect types plan, apply,
// then watches. The spine registers a runner row, enqueues a job, THEN starts the runner process,
// then waits for it. Run the whole table in one pass at the top and `project apply --wait` blocks
// forever on a claimer that has not started; run it at the bottom and there is no cluster to read
// back. Neither failure looks like what it is — both read as "the CLI cannot do this".
//
// So the driver runs one window at a time and the spine calls it four times.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// cliDemoCredsEnv names the file the workflow's seed step writes: the service token and the ORG it
// is pinned to, together.
//
// Together is the point. `claim_next_job`'s self-runner branch scopes to
// `j.org_id = v_runner_org_id` (audit P0, #392), so the runner the harness registers must carry the
// SAME org as the token the CLI authenticates with. If they differ, the job the CLI creates is
// never claimed, sits QUEUED, and the run dies on a deploy timeout — which reads as a provisioning
// defect and is a tenancy mismatch. Reading both from one file is what makes them impossible to
// set independently.
const cliDemoCredsEnv = "ALETHIA_E2E_CLI_DEMO_CREDS"

// cliDemoAPIEnv names the variable the CLI resolves its control plane from.
//
// It is `ALETHIA_WEB_ORIGIN`, and getting this wrong is not a typo — it is a live-fire hazard.
// `types.ResolveWebOrigin()` is env > persisted config > **the hosted default,
// https://alethialabs.io**, and `api.NewClient` appends `/api` to whatever comes back. So a driver
// that exported some other name would not fail: every beat would silently authenticate against
// PRODUCTION with a token minted in a throwaway database, and the run would report the CLI as
// broken while pointing at a console nobody meant to touch.
//
// The runner uses the same variable name for a different endpoint (the shim, cp.URL()). They are
// separate processes with separate environments, and the two must not be conflated: the runner
// talks to the shim, the CLI talks to the console.
const cliDemoAPIEnv = "ALETHIA_WEB_ORIGIN"

// CLIDemoCreds is what the seed step produced.
type CLIDemoCreds struct {
	OrgID   string `json:"orgId"`
	OwnerID string `json:"ownerId"`
	Token   string `json:"token"`
}

// LoadCLIDemoCreds reads the seeded credential, failing closed on every way it can be absent.
//
// Fail-closed and EARLY: this is called before a cluster is bought, because "the token file is
// missing" costs a dispatch and "the token file is missing, discovered after provisioning" costs a
// cluster.
func LoadCLIDemoCreds() (CLIDemoCreds, error) {
	path := strings.TrimSpace(os.Getenv(cliDemoCredsEnv))
	if path == "" {
		return CLIDemoCreds{}, fmt.Errorf("%s is unset — the cli-demo dimension needs the seeded service token; the workflow's seed step writes it", cliDemoCredsEnv)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return CLIDemoCreds{}, fmt.Errorf("reading %s at %s: %w", cliDemoCredsEnv, path, err)
	}
	var c CLIDemoCreds
	if err := json.Unmarshal(raw, &c); err != nil {
		return CLIDemoCreds{}, fmt.Errorf("parsing %s: %w", path, err)
	}
	// Each checked separately: "which half is missing" is the difference between a seed step that
	// did not run and one that ran against the wrong database.
	if c.Token == "" {
		return CLIDemoCreds{}, fmt.Errorf("%s carries no token — the seed step wrote a file but minted nothing", path)
	}
	if c.OrgID == "" {
		return CLIDemoCreds{}, fmt.Errorf("%s carries no orgId — without it the runner cannot be registered in the token's tenancy and the job it creates is never claimed", path)
	}
	return c, nil
}

// ResolveCLIDemoRun returns the run state for the `cli-demo` dimension, or nil when the dimension
// is off. It fails the test — EARLY, before a cluster is bought — on every way the dimension can be
// mis-dispatched.
//
// IT LIVES HERE, NOT IN THE SPINE, and that is deliberate. cli_demo_wiring_pure_test.go asserts a
// SHAPE in t2_provision_test.go: an `if` whose condition asks CLIDemoProvisionEnabled and whose
// body terminates the test is a REFUSAL, and a refusal must not coexist with a driver. Precondition
// checks wear that same shape while meaning the opposite, so leaving them in the spine would make
// the guard unable to tell "this dimension is disabled until someone writes a driver" from "this
// dimension validates its inputs". Keeping the gate here keeps that distinction sharp — and the
// resolution belongs next to the thing that consumes it anyway.
func ResolveCLIDemoRun(t *testing.T) *CLIDemoRun {
	t.Helper()
	if !CLIDemoProvisionEnabled() {
		return nil
	}
	creds, err := LoadCLIDemoCreds()
	if err != nil {
		t.Fatalf("cli-demo: %v", err)
	}
	apiBase := strings.TrimSpace(os.Getenv(cliDemoConsoleURLEnv))
	if apiBase == "" {
		t.Fatalf("cli-demo: %s is unset — the beats must drive the REAL console's user-facing API. "+
			"The runner shim serves no user-facing endpoint, and pointing at it would prove the CLI "+
			"against a mock, which is the one thing this bar must not do.", cliDemoConsoleURLEnv)
	}
	// REFUSE A PRODUCTION ORIGIN, and refuse it here rather than documenting it.
	//
	// `types.ResolveWebOrigin()` is env > persisted config > the HOSTED DEFAULT
	// (https://alethialabs.io), and `api.NewClient` appends `/api`. So a harness that exports the
	// wrong variable name — or none — does not fail: every beat authenticates against PRODUCTION
	// with a token minted in a throwaway database, and the run reports the CLI as broken while
	// pointing at a console nobody meant to touch. Nothing downstream can catch that, because from
	// the CLI's side it is a perfectly ordinary request.
	//
	// This is not specific to the demo bar. It is a hazard for ANY test that drives the CLI, which
	// is why the refusal lives on the resolution path every such test would use.
	if strings.Contains(apiBase, strings.TrimPrefix(types.DefaultWebOrigin, "https://")) {
		t.Fatalf("cli-demo: %s resolves to the HOSTED control plane (%s). The beats would authenticate "+
			"against production with a token minted in this job's throwaway database. Point it at the "+
			"console this job booted.", cliDemoConsoleURLEnv, apiBase)
	}
	run := &CLIDemoRun{Bin: CLIDemoBinary(), Token: creds.Token, OrgID: creds.OrgID, APIBase: apiBase}
	if _, err := os.Stat(run.Bin); err != nil {
		t.Fatalf("cli-demo: the binary under test is not at %q: %v — build it before dispatching this dimension", run.Bin, err)
	}
	return run
}

// cliDemoConsoleURLEnv names the real console the beats drive.
const cliDemoConsoleURLEnv = "ALETHIA_E2E_CONSOLE_URL"

// uuidRe matches the ids the CLI prints. Deliberately anchored on the shape rather than on
// surrounding prose: `ui.JobQueued` renders through lipgloss, so the line carries ANSI styling that
// a literal-prefix match would have to strip and would silently stop matching when the style
// changes.
var uuidRe = regexp.MustCompile(`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`)

// captureProjectID reads the project id out of `project create --output json`.
//
// The JSON `id` field is preferred over "the first uuid in the output" because a rendered card
// carries an org id and a cloud-identity id too, and picking positionally would work today and
// address the wrong project the moment a field is added ahead of it.
func captureProjectID(r *CLIDemoRun, out string) error {
	if id := firstJSONID(out); id != "" {
		r.ProjectID = id
		return nil
	}
	if m := uuidRe.FindString(out); m != "" {
		r.ProjectID = m
		return nil
	}
	return fmt.Errorf("no project id in `project create` output — every later beat addresses the project by id, so this is fatal rather than cosmetic:\n%s", out)
}

// captureApplyJobID reads the DEPLOY job id `project apply` enqueued. It is what the spine waits on
// and what `jobs logs` and `verify` address.
func captureApplyJobID(r *CLIDemoRun, out string) error {
	if m := uuidRe.FindString(out); m != "" {
		r.ApplyJobID = m
		return nil
	}
	return fmt.Errorf("no job id in `project apply` output — the spine has nothing to wait on:\n%s", out)
}

// captureDefaultEnv reads the DEFAULT environment's name out of `project env list --output json`.
//
// It is captured rather than assumed because the CLI creates the environments, not the harness:
// `project create --stage development` makes `development` (default) and `preview`, and the
// harness's own `env` variable names something else entirely. Addressing the wrong one fails with
// `Environment "x" not found` — a 404 that reads as a CLI defect and is a harness assumption.
func captureDefaultEnv(r *CLIDemoRun, out string) error {
	start := strings.Index(out, "[")
	end := strings.LastIndex(out, "]")
	if start == -1 || end <= start {
		return fmt.Errorf("`project env list --output json` produced no JSON array:\n%s", out)
	}
	var envs []struct {
		Name      string `json:"name"`
		IsDefault bool   `json:"is_default"`
	}
	if err := json.Unmarshal([]byte(out[start:end+1]), &envs); err != nil {
		return fmt.Errorf("parsing the environment list: %w\n%s", err, out)
	}
	for _, e := range envs {
		if e.IsDefault && e.Name != "" {
			r.EnvName = e.Name
			return nil
		}
	}
	// Falling back to "the first one" would work today and silently address the wrong environment
	// the day a project is created with two. A project with no default is a product question, not
	// something for this harness to paper over.
	return fmt.Errorf("no DEFAULT environment among %d — every later beat addresses one by name:\n%s", len(envs), out)
}

// firstJSONID pulls a top-level `"id"` out of the first JSON object in the output, if there is one.
// Returns "" rather than erroring: the caller has a fallback, and a card rendered as a table is not
// a failure.
func firstJSONID(out string) string {
	start := strings.Index(out, "{")
	end := strings.LastIndex(out, "}")
	if start == -1 || end <= start {
		return ""
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(out[start:end+1]), &obj); err != nil {
		return ""
	}
	if id, ok := obj["id"].(string); ok {
		return id
	}
	return ""
}

// AssertCLIDemoBeatsAreLeafCommands refuses a beat whose argv names a command GROUP rather than a
// command.
//
// THIS EXISTS BECAUSE IT ALREADY HAPPENED. `drift`, `cost` and `verify` are groups — their leaves
// are `drift show`, `cost show`, `verify receipt`. Invoked without the subcommand, cobra prints the
// group's help and **exits 0**. So three beats would have run, performed nothing, exited clean, and
// the dimension would have reported a CLI-driven proof of a demo it never gave. That is the exact
// vacuity this tier exists to prevent, arriving through the one door nothing was watching: a
// SUCCESSFUL command.
//
// Run once, up front, before a cluster is bought — it costs one `--help` per beat.
func AssertCLIDemoBeatsAreLeafCommands(ctx context.Context, t *testing.T, run *CLIDemoRun) {
	t.Helper()
	for _, b := range CLIDemoBeats {
		// The command PATH is the leading non-flag tokens. Values that follow a flag are skipped
		// with it, so `--project <id>` never contributes `<id>` to the path.
		var path []string
		argv := b.Args(run)
		for i := 0; i < len(argv); i++ {
			if strings.HasPrefix(argv[i], "-") {
				break
			}
			path = append(path, argv[i])
		}
		if len(path) == 0 {
			t.Errorf("beat %q builds an argv that starts with a flag — it names no command", b.StepID)
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		out, _ := exec.CommandContext(cctx, run.Bin, append(append([]string{}, path...), "--help")...).CombinedOutput()
		cancel()
		if strings.Contains(string(out), "Available Commands:") {
			t.Errorf("beat %q invokes `alethia %s`, which is a command GROUP, not a command. "+
				"Cobra prints its help and EXITS 0, so this beat would perform nothing and pass. "+
				"Name the subcommand.", b.StepID, strings.Join(path, " "))
		}
	}
}

// DriveCLIDemoPhase executes every beat in one phase, in table order, against the real binary.
//
// It is FATAL on the first failure rather than collecting: the beats thread ids through one another,
// so a failed `project create` makes every later beat address the empty string and report a second,
// louder, entirely derivative failure. The first one is the true one.
func DriveCLIDemoPhase(ctx context.Context, t *testing.T, run *CLIDemoRun, phase CLIDemoPhase) {
	t.Helper()

	ran := 0
	for _, b := range CLIDemoBeats {
		if b.Phase != phase {
			continue
		}
		argv := b.Args(run)
		bound := cliDemoBeatTimeout
		if b.Timeout > 0 {
			bound = b.Timeout
		}
		cctx, cancel := context.WithTimeout(ctx, bound)
		cmd := exec.CommandContext(cctx, run.Bin, argv...)
		cmd.Env = append(os.Environ(),
			"ALETHIA_TOKEN="+run.Token,
			cliDemoAPIEnv+"="+run.APIBase,
			// A demo runs on a fresh machine; an update check that reaches the network turns a
			// beat's timeout into a story about the CLI being slow.
			"ALETHIA_NO_UPDATE_CHECK=1",
		)
		if b.Stdin != nil {
			if in := b.Stdin(run); in != "" {
				cmd.Stdin = strings.NewReader(in)
			}
		}
		outB, err := cmd.CombinedOutput()
		cancel()
		out := string(outB)
		if err != nil {
			t.Fatalf("cli-demo beat %q FAILED (`alethia %s`): %v\n%s",
				b.StepID, strings.Join(argv, " "), err, out)
		}
		t.Logf("cli-demo [%s] %s: `alethia %s` ok", phase, b.StepID, strings.Join(argv, " "))
		if b.After != nil {
			if e := b.After(run, out); e != nil {
				t.Fatalf("cli-demo beat %q produced no usable output: %v", b.StepID, e)
			}
		}
		ran++
	}

	// A phase that ran nothing is the failure this tier exists to prevent — it is how the dimension
	// would go green having performed no command at all. Every phase in the table has beats; a
	// phase with none means the table was edited and the driver was not.
	if ran == 0 {
		t.Fatalf("cli-demo phase %q executed NO beats — the dimension would prove nothing. "+
			"Either the table lost its %s beats or the driver was called with a phase nothing declares.", phase, phase)
	}
}

// AssertCLIDemoJobClaimed proves the job the CLI created was CLAIMED, separately from whether the
// deploy finished.
//
// WHY IT IS ITS OWN ASSERTION. `claim_next_job`'s self-runner branch scopes to
// `j.org_id = v_runner_org_id` (#392). If the runner is registered in a different org from the one
// the service token is pinned to, the job the CLI created is never claimed — it sits QUEUED, the
// spine's wait runs to its full deadline, and the run is reported as a DEPLOY TIMEOUT. That names
// the wrong layer entirely: the cluster is fine, the runner is fine, and the actual fault is a
// tenancy mismatch that was decidable in seconds.
//
// So this waits a SHORT window for the job to leave QUEUED and, on failure, says the thing that is
// actually wrong. It is the cheap half of the deploy wait, taken first.
func AssertCLIDemoJobClaimed(ctx context.Context, t *testing.T, cp *ControlPlane, run *CLIDemoRun) {
	t.Helper()
	if err := awaitCLIDemoClaim(ctx, run, func(c context.Context) (string, error) {
		status, _, err := cp.JobState(c, run.ApplyJobID)
		return status, err
	}); err != nil {
		t.Fatal(err)
	}
	t.Logf("cli-demo: the CLI's DEPLOY job %s was claimed — runner and token agree on org %s",
		run.ApplyJobID, run.OrgID)
}

// awaitCLIDemoClaim is the decision, separated from the ControlPlane so the FAILURE MESSAGE is
// testable without a cluster.
//
// That separation is the point: the message is the whole value of this assertion. If it does not
// name the tenancy rule, the operator reads a stuck job and starts looking at the cluster — which
// is precisely the wrong-layer reporting this exists to prevent. A message nobody can test is a
// message that rots.
func awaitCLIDemoClaim(ctx context.Context, run *CLIDemoRun, status func(context.Context) (string, error)) error {
	deadline := time.Now().Add(cliDemoClaimWindow)
	last := "(never read)"
	for time.Now().Before(deadline) {
		s, err := status(ctx)
		if err == nil {
			last = s
			if s != "QUEUED" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("cli-demo: cancelled while waiting for the CLI's job to be claimed: %w", ctx.Err())
		case <-time.After(cliDemoClaimPoll):
		}
	}
	return fmt.Errorf("cli-demo: the DEPLOY job %s the CLI created is still %q after %s — it was never CLAIMED.\n"+
		"This is almost certainly a TENANCY mismatch, not a provisioning failure: claim_next_job's "+
		"self-runner branch scopes to `j.org_id = v_runner_org_id` (#392), and the runner is registered "+
		"in org %s. If the service token is pinned to a different org, no runner will ever claim this job, "+
		"and the deploy wait would have run to its full deadline reporting a timeout that names the cluster.",
		run.ApplyJobID, last, cliDemoClaimWindow, run.OrgID)
}

// cliDemoClaimPoll is how often the claim is re-read. A variable so the pure test can drive the
// loop in milliseconds rather than making the suite wait out a real poll interval.
var cliDemoClaimPoll = 5 * time.Second

// cliDemoClaimWindow bounds the claim check. Short on purpose: a claim is a database transaction a
// live runner performs within its poll interval, so a minute and a half that passes without one is
// not slow, it is wrong.
//
// A var, like cliDemoClaimPoll, so the pure test can drive the whole loop in milliseconds instead
// of making every PR wait out a real window to prove one error message.
var cliDemoClaimWindow = 90 * time.Second

// cliDemoBeatTimeout bounds ONE command. Generous, because a first request to a console that has
// just booted pays for a cold Next.js route, and a beat that times out on that would be reported as
// a CLI that cannot reach a command it reaches perfectly well.
const cliDemoBeatTimeout = 4 * time.Minute
