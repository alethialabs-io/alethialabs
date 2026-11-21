// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// The ops family as a customer and an operator meet it: when it is listed, what each verb writes on
// which stream, the shape of its json, the exit code each refusal owns, and the registry's facts.

// opsFamInert are the two verbs that are never listed, whatever the switch says: their executors
// have not shipped, so listing them offers an operator something that cannot work.
var opsFamInert = []string{"alethia ops orphan-clean", "alethia ops state-surgery"}

// ── listing ─────────────────────────────────────────────────────────────────────────────────────

// TestOpsFamily_TheGroupIsListedOnlyWithTheSwitchOn is the unit's acceptance criterion, read off
// the help a person sees: the default root help does not name ops, and with ALETHIA_OPS=1 it does.
func TestOpsFamily_TheGroupIsListedOnlyWithTheSwitchOn(t *testing.T) {
	reapplyMetaAfter(t)

	modeEnv(t, map[string]string{})
	applyCommandMeta()
	if help := helpOf(t, rootCmd); strings.Contains(help, "\n  ops ") || strings.Contains(help, "Break-glass") {
		t.Errorf("the default root help lists ops:\n%s", help)
	}

	modeEnv(t, map[string]string{OpsEnv: "1"})
	applyCommandMeta()
	if help := helpOf(t, rootCmd); !strings.Contains(help, "\n  ops ") {
		t.Errorf("the root help does not list ops with %s=1:\n%s", OpsEnv, help)
	}
}

// TestOpsFamily_TheInertVerbsAreHiddenInBothStates pins the other half of the criterion: the two
// inert verbs are hidden with the switch off AND on, in help and in the machine description, and
// they still run when named.
func TestOpsFamily_TheInertVerbsAreHiddenInBothStates(t *testing.T) {
	reapplyMetaAfter(t)

	for _, on := range []bool{false, true} {
		env := map[string]string{}
		if on {
			env[OpsEnv] = "1"
		}
		modeEnv(t, env)
		applyCommandMeta()

		help := helpOf(t, opsCmd)
		for _, path := range opsFamInert {
			cmd := opsPathsCmdNoReset(t, path)
			if !cmd.Hidden {
				t.Errorf("switch on=%v: %s is listed", on, path)
			}
			if strings.Contains(help, "\n  "+cmd.Name()+" ") {
				t.Errorf("switch on=%v: `alethia ops --help` lists %s:\n%s", on, cmd.Name(), help)
			}
			for _, c := range describeCommands().Commands {
				if c.Path == path {
					t.Errorf("switch on=%v: %s is in the machine description", on, path)
				}
			}
		}
		// The control: a live verb is listed under the group, so the absences above are a choice.
		if !strings.Contains(help, "\n  retry-job ") {
			t.Errorf("switch on=%v: `alethia ops --help` lists no live verb either — the check above is vacuous:\n%s", on, help)
		}
	}
}

// opsPathsCmdNoReset finds a command of the live tree without touching its flags.
func opsPathsCmdNoReset(t *testing.T, path string) *cobra.Command {
	t.Helper()
	cmd, _, err := rootCmd.Find(opsCommandPath(path))
	if err != nil || cmd.CommandPath() != path {
		t.Fatalf("find %s: %v", path, err)
	}
	return cmd
}

// ── the registry ────────────────────────────────────────────────────────────────────────────────

// TestOpsFamily_EveryCommandHasARunnableExample: every entry has an example, and every example names
// a command of this CLI, passes only flags that command has, says what it does and carries no
// placeholder to fill in.
func TestOpsFamily_EveryCommandHasARunnableExample(t *testing.T) {
	famApplyMeta(t)
	if len(metaOps) == 0 {
		t.Fatal("the family has no entries, so nothing below would be asserted")
	}
	for _, m := range metaOps {
		if len(m.Examples) == 0 {
			t.Errorf("%s has no example", m.Path)
		}
		for _, ex := range m.Examples {
			if strings.ContainsAny(ex.Cmd, "<>$") {
				t.Errorf("%s: example %q carries a placeholder", m.Path, ex.Cmd)
			}
			if ex.Note == "" {
				t.Errorf("%s: example %q does not say what it does", m.Path, ex.Cmd)
			}
			tokens := strings.Fields(ex.Cmd)
			if tokens[0] != "alethia" {
				t.Errorf("%s: example %q does not start with the program name", m.Path, ex.Cmd)
				continue
			}
			var words []string
			for _, tok := range tokens[1:] {
				if strings.HasPrefix(tok, "-") {
					break
				}
				words = append(words, tok)
			}
			found, _, err := rootCmd.Find(words)
			if err != nil || found.CommandPath() != m.Path {
				t.Errorf("%s: example %q resolves to %v (%v)", m.Path, ex.Cmd, found.CommandPath(), err)
				continue
			}
			for _, tok := range tokens[1:] {
				if !strings.HasPrefix(tok, "--") {
					continue
				}
				name, _, _ := strings.Cut(strings.TrimPrefix(tok, "--"), "=")
				if found.Flags().Lookup(name) == nil && found.InheritedFlags().Lookup(name) == nil {
					t.Errorf("%s: example %q passes --%s, which `%s` does not take", m.Path, ex.Cmd, name, found.CommandPath())
				}
			}
		}
	}
}

// TestOpsFamily_TheFactsEveryVerbShares pins the facts read from the command bodies: every verb
// opens an audited session, so every verb mutates and none is idempotent; a destructive verb takes
// --yes; a verb that queues a job is long-running and takes --wait and --timeout; and every verb
// has a Long saying when to use it.
func TestOpsFamily_TheFactsEveryVerbShares(t *testing.T) {
	famApplyMeta(t)
	reg := commandRegistry()
	commands := opsGroupCommands(rootCmd)
	if len(commands) == 0 {
		t.Fatal("no ops verbs were found")
	}
	for _, c := range commands {
		path := c.CommandPath()
		m, ok := reg.Lookup(path)
		if !ok {
			t.Errorf("%s has no registry entry", path)
			continue
		}
		if !m.Mutates || m.Idempotent {
			t.Errorf("%s: mutates=%v idempotent=%v; every verb opens an audited session", path, m.Mutates, m.Idempotent)
		}
		if m.Destructive && c.Flags().Lookup("yes") == nil {
			t.Errorf("%s is destructive and takes no --yes", path)
		}
		if strings.TrimSpace(c.Long) == "" {
			t.Errorf("%s has no Long", path)
		}
		action, dispatched := opsActionFor(path)
		queues := dispatched && action.Queues
		if m.LongRunning != queues {
			t.Errorf("%s: long-running=%v, but queuing a job=%v", path, m.LongRunning, queues)
		}
		hasWait := c.Flags().Lookup("wait") != nil && c.Flags().Lookup("timeout") != nil
		if hasWait != queues {
			t.Errorf("%s: takes --wait/--timeout=%v, queues a job=%v", path, hasWait, queues)
		}
		if dispatched && !action.ReadOnly && action.Kind == "" {
			t.Errorf("%s mutates and names no kind for its result", path)
		}
	}
	for _, path := range opsFamInert {
		if m, _ := reg.Lookup(path); !m.Hidden {
			t.Errorf("%s is not marked hidden in meta_ops.go", path)
		}
	}
}

// ── what each verb prints ───────────────────────────────────────────────────────────────────────

// opsFamCapture runs fn with stdout and stderr each redirected to a pipe and returns what each
// received, drained on goroutines so a large write cannot block.
func opsFamCapture(t *testing.T, fn func() int) (stdout, stderr string, code int) {
	t.Helper()
	drain := func(r *os.File, into chan<- string) {
		b, _ := io.ReadAll(r)
		into <- string(b)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prevOut, prevErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outW, errW
	outC, errC := make(chan string, 1), make(chan string, 1)
	go drain(outR, outC)
	go drain(errR, errC)

	code = fn()
	os.Stdout, os.Stderr = prevOut, prevErr
	_ = outW.Close()
	_ = errW.Close()
	stdout, stderr = <-outC, <-errC
	_ = outR.Close()
	_ = errR.Close()
	return stdout, stderr, code
}

// TestOpsFamily_EveryMutatingVerbPrintsTheResultShape drives every mutating verb, the hidden two
// included, end to end under `-o json`: stdout is one MutationResult naming the resource the
// operator gave, the kind of thing it is, and what happened; the server's answer is its object.
func TestOpsFamily_EveryMutatingVerbPrintsTheResultShape(t *testing.T) {
	for path, tc := range opsConfirmCases {
		t.Run(path, func(t *testing.T) {
			_, _, run := opsFormEnv(t)
			args := append(append([]string{}, tc.args...), "--yes", "--no-input", "-o", "json")
			out, _, code := opsFamCapture(t, func() int { return run(args...) })
			if code != 0 {
				t.Fatalf("exit code = %d, want 0", code)
			}
			var got struct {
				ID     string          `json:"id"`
				Kind   string          `json:"kind"`
				Action string          `json:"action"`
				Job    json.RawMessage `json:"job"`
				DryRun *bool           `json:"dry_run"`
				Object struct {
					OK     bool   `json:"ok"`
					Detail string `json:"detail"`
				} `json:"object"`
			}
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("stdout is not one JSON document: %v\n%s", err, out)
			}
			action := mustOpsAction(path)
			if got.ID != tc.resource || got.Kind != action.Kind || got.Action != string(ResultUpdated) {
				t.Errorf("result = {id %q, kind %q, action %q}, want {%q, %q, updated}", got.ID, got.Kind, got.Action, tc.resource, action.Kind)
			}
			if got.DryRun == nil || *got.DryRun || got.Job == nil {
				t.Errorf("dry_run and job must always be present: %s", out)
			}
			if !got.Object.OK || got.Object.Detail != "done" {
				t.Errorf("the server's answer is not the object: %s", out)
			}
		})
	}
}

// TestOpsFamily_ReadOnlyVerbsPrintTheServersAnswer: a read-only verb changes nothing but the audit,
// so its json is the control plane's answer as it came, not a mutation result.
func TestOpsFamily_ReadOnlyVerbsPrintTheServersAnswer(t *testing.T) {
	for _, args := range [][]string{
		{"ops", "inspect-job", "job-alpha", "--reason", "incident-4711"},
		{"ops", "orphan-detect", "--project", "project-alpha", "--reason", "incident-4711"},
	} {
		t.Run(args[1], func(t *testing.T) {
			_, _, run := opsFormEnv(t)
			out, _, code := opsFamCapture(t, func() int { return run(append(args, "--no-input", "-o", "json")...) })
			if code != 0 {
				t.Fatalf("exit code = %d, want 0", code)
			}
			var got map[string]any
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("stdout is not one JSON document: %v\n%s", err, out)
			}
			if got["ok"] != true || got["detail"] != "done" || got["data"] == nil {
				t.Errorf("document = %v, want the server's ok, detail and data", got)
			}
			if _, has := got["kind"]; has {
				t.Errorf("a read-only verb printed a mutation result: %v", got)
			}
		})
	}
}

// TestOpsFamily_SessionAndApprovalAreCreatedRecords: both create one record, so both print the
// result shape with that record's id as the result's id — `.id` is the value the other operator
// passes as --approval.
func TestOpsFamily_SessionAndApprovalAreCreatedRecords(t *testing.T) {
	for _, tc := range []struct {
		args []string
		kind string
		id   string
	}{
		{[]string{"ops", "session", "--reason", "incident-4711"}, opsKindSession, "sess-1"},
		{[]string{"ops", "approve", "state_surgery", "k1", "--reason", "incident-4711"}, opsKindApproval, "appr-1"},
	} {
		t.Run(tc.args[1], func(t *testing.T) {
			_, _, run := opsFormEnv(t)
			out, _, code := opsFamCapture(t, func() int { return run(append(tc.args, "--no-input", "-o", "json")...) })
			if code != 0 {
				t.Fatalf("exit code = %d, want 0", code)
			}
			var got MutationResult
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("stdout is not one JSON document: %v\n%s", err, out)
			}
			if got.ID != tc.id || got.Kind != tc.kind || got.Action != ResultCreated {
				t.Errorf("result = %+v, want id %q kind %q created", got, tc.id, tc.kind)
			}
		})
	}
}

// TestOpsFamily_TheTableFormIsTheSentenceAndTheCard: for a person the result is the server's
// sentence and the record, and the sentence is not repeated on stderr.
func TestOpsFamily_TheTableFormIsTheSentenceAndTheCard(t *testing.T) {
	_, _, run := opsFormEnv(t)
	out, errOut, code := opsFamCapture(t, func() int {
		return run("ops", "session", "--reason", "incident-4711", "--no-input")
	})
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	if !strings.Contains(out, "Session opened for ops@alethialabs.io") || !strings.Contains(out, "sess-1") {
		t.Errorf("stdout lacks the sentence or the record:\n%s", out)
	}
	if strings.Contains(errOut, "Session opened") {
		t.Errorf("the result was written on stderr too:\n%s", errOut)
	}
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────

// TestOpsFamily_ARefusalIsOnStderrWithItsClass: a value that cannot be asked for is input_required
// (exit 9), a value that is wrong as given is a usage error (exit 8), and in both cases stdout stays
// empty and the json error envelope goes to stderr.
func TestOpsFamily_ARefusalIsOnStderrWithItsClass(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		exit  int
		class clierr.Class
	}{
		{"missing reason", []string{"ops", "drain-runner", "runner-alpha", "--yes"}, clierr.ExitInputRequired, clierr.ClassInputRequired},
		{"missing id", []string{"ops", "retry-job", "--reason", "incident-4711", "--yes"}, clierr.ExitInputRequired, clierr.ClassInputRequired},
		{"missing --yes", []string{"ops", "cancel-job", "job-alpha", "--reason", "incident-4711"}, clierr.ExitInputRequired, clierr.ClassInputRequired},
		{"short reason", []string{"ops", "session", "--reason", "short"}, clierr.ExitUsage, clierr.ClassUsage},
		{"bad status", []string{"ops", "unstick-env", "env-alpha", "--from", "READY", "--to", "FAILED", "--reason", "incident-4711", "--yes"}, clierr.ExitUsage, clierr.ClassUsage},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _, run := opsFormEnv(t)
			out, errOut, code := opsFamCapture(t, func() int { return run(append(tc.args, "--no-input", "-o", "json")...) })
			if code != tc.exit {
				t.Fatalf("exit code = %d, want %d\n%s", code, tc.exit, errOut)
			}
			if out != "" {
				t.Errorf("a refusal wrote on stdout: %q", out)
			}
			var envelope struct {
				Error struct {
					Class clierr.Class `json:"class"`
				} `json:"error"`
			}
			if err := json.Unmarshal([]byte(strings.TrimSpace(errOut)), &envelope); err != nil {
				t.Fatalf("stderr is not the json error envelope: %v\n%s", err, errOut)
			}
			if envelope.Error.Class != tc.class {
				t.Errorf("class = %q, want %q", envelope.Error.Class, tc.class)
			}
			if s.sawAny("/api/breakglass") {
				t.Errorf("the refusal cost a round trip: %v", s.all())
			}
		})
	}
}

// TestOpsFamily_AForbiddenAnswerSaysWhatToDo: the answer an operator meets with a service token or
// without the allowlist exits with the forbidden class and a hint naming the way through, and the
// control plane's own hint wins when it sent one.
func TestOpsFamily_AForbiddenAnswerSaysWhatToDo(t *testing.T) {
	e := clierr.From(opsRemoteError("could not open a break-glass session", &api.APIError{StatusCode: http.StatusForbidden, Message: "not an operator"}))
	if e.Exit != clierr.ExitForbidden || !strings.Contains(e.Hint, "alethia login") {
		t.Errorf("exit %d hint %q, want %d and a hint naming alethia login", e.Exit, e.Hint, clierr.ExitForbidden)
	}
	if !strings.Contains(e.Message, "could not open a break-glass session") || !strings.Contains(e.Message, "not an operator") {
		t.Errorf("message %q lost what was being done or what the server said", e.Message)
	}
	own := clierr.From(opsRemoteError("x", &api.APIError{StatusCode: http.StatusForbidden, Hint: "ask the platform team"}))
	if own.Hint != "ask the platform team" {
		t.Errorf("hint = %q, want the control plane's own", own.Hint)
	}
	other := clierr.From(opsRemoteError("x", &api.APIError{StatusCode: http.StatusConflict}))
	if other.Hint != "" || other.Exit != clierr.ExitConflict {
		t.Errorf("a conflict got hint %q exit %d, want none and %d", other.Hint, other.Exit, clierr.ExitConflict)
	}
}

// ── a verb that queues a job ────────────────────────────────────────────────────────────────────

// opsFamClient is a scripted control plane for executeOpsAction.
type opsFamClient struct {
	data       string
	sessionErr error
	jobs       []*api.ProvisionJob
	polls      int
	executed   []api.BreakglassExecuteParams
}

func (c *opsFamClient) OpenBreakglassSession(string) (*api.BreakglassSession, error) {
	if c.sessionErr != nil {
		return nil, c.sessionErr
	}
	return &api.BreakglassSession{SessionID: "sess-1"}, nil
}

func (c *opsFamClient) ExecuteBreakglass(p api.BreakglassExecuteParams) (*api.BreakglassResult, error) {
	c.executed = append(c.executed, p)
	return &api.BreakglassResult{OK: true, Detail: "re-enqueued", Data: json.RawMessage(c.data)}, nil
}

func (c *opsFamClient) GetJob(string) (*api.ProvisionJob, error) {
	i := min(c.polls, len(c.jobs)-1)
	c.polls++
	return c.jobs[i], nil
}

// opsFamFastPolls shortens the wait loop's interval for one test.
func opsFamFastPolls(t *testing.T) {
	t.Helper()
	prev := jobPollInterval
	jobPollInterval = time.Millisecond
	t.Cleanup(func() { jobPollInterval = prev })
}

// TestOpsFamily_RetryJobQueuesAndWaits: retry-job's result names the job it queued, and --wait
// follows it through awaitJob — exit 0 on success, 13 when it fails, 12 when --timeout passes —
// while without --wait nothing is polled.
func TestOpsFamily_RetryJobQueuesAndWaits(t *testing.T) {
	opsFamFastPolls(t)
	action := mustOpsAction("alethia ops retry-job")
	req := opsRequest{ResourceID: "job-old", Reason: "incident-4711"}
	running := &api.ProvisionJob{ID: "job-new", JobType: "DEPLOY", Status: "PROCESSING"}

	t.Run("no wait", func(t *testing.T) {
		c := &opsFamClient{data: `{"jobId":"job-new"}`}
		p, out, errOut := famPrinter(ui.FormatJSON)
		o, err := executeOpsAction(context.Background(), p, c, req, action, waitFlags{})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if o.Mutation.Action != ResultQueued || o.Mutation.Job == nil || o.Mutation.Job.ID != "job-new" {
			t.Errorf("result = %+v, want the queued job", o.Mutation)
		}
		if c.polls != 0 {
			t.Errorf("polled %d times without --wait", c.polls)
		}
		if out.Len() != 0 || !strings.Contains(errOut.String(), "job-new") {
			t.Errorf("the queued notice belongs on stderr only: out %q err %q", out, errOut)
		}
		if c.executed[0].Confirm != "job-old" {
			t.Errorf("the typed-confirm was %q, want the resource id", c.executed[0].Confirm)
		}
	})

	for status, want := range map[string]int{
		jobStatusSuccess: clierr.ExitOK,
		jobStatusFailed:  clierr.ExitOperationFailed,
	} {
		t.Run("wait "+status, func(t *testing.T) {
			c := &opsFamClient{data: `{"jobId":"job-new"}`, jobs: []*api.ProvisionJob{running, {ID: "job-new", JobType: "DEPLOY", Status: status}}}
			p, _, _ := famPrinter(ui.FormatJSON)
			o, err := executeOpsAction(context.Background(), p, c, req, action, waitFlags{Wait: true})
			if got := famExit(err); got != want {
				t.Fatalf("exit = %d (%v), want %d", got, err, want)
			}
			if want == clierr.ExitOK && (o.JobStatus != status || o.Mutation.Job.Type != "DEPLOY") {
				t.Errorf("outcome = %+v job %+v, want the job's end and its type", o, o.Mutation.Job)
			}
		})
	}

	t.Run("wait times out", func(t *testing.T) {
		c := &opsFamClient{data: `{"jobId":"job-new"}`, jobs: []*api.ProvisionJob{running}}
		p, _, _ := famPrinter(ui.FormatJSON)
		_, err := executeOpsAction(context.Background(), p, c, req, action, waitFlags{Wait: true, Timeout: 5 * time.Millisecond})
		if got := famExit(err); got != clierr.ExitWaitTimeout {
			t.Fatalf("exit = %d (%v), want %d", got, err, clierr.ExitWaitTimeout)
		}
	})

	t.Run("no job named", func(t *testing.T) {
		c := &opsFamClient{data: `{}`}
		p, _, errOut := famPrinter(ui.FormatJSON)
		o, err := executeOpsAction(context.Background(), p, c, req, action, waitFlags{Wait: true})
		if err != nil || o.Mutation.Job != nil || o.Mutation.Action != ResultUpdated {
			t.Fatalf("outcome %+v err %v, want an update with no job", o.Mutation, err)
		}
		if !strings.Contains(errOut.String(), "nothing was waited on") {
			t.Errorf("a --wait with nothing to wait on said nothing: %q", errOut)
		}
	})
}

// TestOpsFamily_ARefusedSessionStopsBeforeTheAction: nothing is executed after the session is
// refused, and the session's class is the command's.
func TestOpsFamily_ARefusedSessionStopsBeforeTheAction(t *testing.T) {
	c := &opsFamClient{sessionErr: &api.APIError{StatusCode: http.StatusNotFound}}
	p, out, _ := famPrinter(ui.FormatJSON)
	_, err := executeOpsAction(context.Background(), p, c, opsRequest{ResourceID: "j1", Reason: "incident-4711"},
		mustOpsAction("alethia ops inspect-job"), waitFlags{})
	e := clierr.From(err)
	if e.Exit != clierr.ExitNotFound || e.Hint == "" {
		t.Errorf("exit %d hint %q, want %d with a hint", e.Exit, e.Hint, clierr.ExitNotFound)
	}
	if len(c.executed) != 0 || out.Len() != 0 {
		t.Errorf("an action ran (%d) or a result was printed (%q) after a refused session", len(c.executed), out)
	}
	if !errors.As(err, new(*api.APIError)) {
		t.Error("the control plane's error is no longer reachable through the chain")
	}
}

// TestOpsFamily_AReadOnlyResultHasACSVForm: the read-only result's csv is the card's rows.
func TestOpsFamily_AReadOnlyResultHasACSVForm(t *testing.T) {
	p, out, _ := famPrinter(ui.FormatCSV)
	if err := printOpsReport(p, &api.BreakglassResult{OK: true, Detail: "d", Data: json.RawMessage(`{"status":"FAILED"}`)}); err != nil {
		t.Fatalf("err = %v", err)
	}
	if got := out.String(); got != "Field,Value\nstatus,FAILED\n" {
		t.Errorf("csv = %q", got)
	}
}

// TestOpsFamily_DescribeCarriesTheFacts pins that the machine description of a listed verb carries
// the corrected facts, so an agent reads the same thing this file asserts.
func TestOpsFamily_DescribeCarriesTheFacts(t *testing.T) {
	reapplyMetaAfter(t)
	modeEnv(t, map[string]string{OpsEnv: "1"})
	for _, c := range describeCommands().Commands {
		if c.Path != "alethia ops inspect-job" {
			continue
		}
		if !c.Mutates || c.Idempotent || c.DryRun != cmdmeta.DryRunNone {
			t.Errorf("inspect-job described as mutates=%v idempotent=%v dry-run=%q", c.Mutates, c.Idempotent, c.DryRun)
		}
		return
	}
	t.Error("inspect-job is not described with the switch on")
}
