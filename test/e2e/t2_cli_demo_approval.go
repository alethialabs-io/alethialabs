// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

// The APPROVAL PATH of the `cli-demo` dimension (#7454).
//
// Since AGT-L1 a service token's deploy or destroy follows table 4.2 (apps/console/lib/approvals/
// policy.ts): a deploy runs on its own only to an environment the token lists in
// auto_approve_environment_ids (decision D2), and a destroy always needs a person's approval. The
// demo authenticates with a service token, so two steps that belong to a PERSON now sit inside the
// run, and this file is how the harness takes them without adding a bypass to the product:
//
//   - after the `project-env` beat, the org's owner lists the run's environment on the token, so the
//     `apply` beat's deploy is automatic (the beat's OrgAdmin);
//   - the `destroy` beat runs `project destroy --no-wait --output json`, which requests an approval
//     and exits 9 with its id in `error.operation.id`; the org's owner approves it in a console
//     session; and the same destroy with `--wait` finds the approved approval and queues (the beat's
//     Approval).
//
// Both person-side steps go through apps/console/scripts/cli-demo-approval.mts, which uses the
// product's own code against the job's database. Deliberately untagged, so the pure test exercises
// the decision logic with a fake CLI and a fake approver.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// cliDemoApprovalExit is the CLI's exit code for an approval it requested and did not wait for:
// clierr.ExitInputRequired, the class of `approval_required` (apps/cli/pkg/clierr/registry.go).
const cliDemoApprovalExit = 9

// cliDemoApprovalCode is the error code the CLI's exit-9 envelope carries for a pending approval.
const cliDemoApprovalCode = "approval_required"

// cliDemoApprovalScript is the owner-side script, relative to the repository root.
const cliDemoApprovalScript = "apps/console/scripts/cli-demo-approval.mts"

// cliDemoAdminTimeout bounds one call of the owner-side script: a tsx start-up and two or three
// queries against a local database.
const cliDemoAdminTimeout = 2 * time.Minute

// cliDemoExecFunc runs the binary under test with argv and returns its combined output and exit
// code. err is non-nil only when no exit code was obtained (the binary could not run, or the bound
// passed); a non-zero exit is a code, not an error, because the approval beat EXPECTS one.
type cliDemoExecFunc func(ctx context.Context, run *CLIDemoRun, argv []string, bound time.Duration) (out string, exitCode int, err error)

// runCLIDemoCommand is the real cliDemoExecFunc: the binary, with the same environment every beat
// runs with.
func runCLIDemoCommand(ctx context.Context, run *CLIDemoRun, argv []string, bound time.Duration) (string, int, error) {
	cctx, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	cmd := exec.CommandContext(cctx, run.Bin, argv...)
	cmd.Env = cliDemoEnv(run)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return string(out), 0, nil
	}
	// A killed process also reports an ExitError, so the deadline is asked first (see the same
	// reasoning in AssertCLIDemoBeatFlagsAreRegistered).
	if cerr := cctx.Err(); errors.Is(cerr, context.DeadlineExceeded) {
		return string(out), -1, fmt.Errorf("did not finish within %s: %w", bound, cerr)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return string(out), exitErr.ExitCode(), nil
	}
	return string(out), -1, err
}

// performCLIDemoApprovalBeat runs a beat the control plane holds for a person's approval: the first
// run requests the approval and exits 9, the org's owner approves it, and the rerun queues the job
// with it. It returns the rerun's output.
//
// Every step that can go wrong says which step it was, because they fail for different reasons: a
// first run that exits 0 is the PRODUCT queueing a destroy nobody approved; an envelope without an
// approval id is the CLI; a refused decision is the approval engine; a failed rerun is the queue.
func performCLIDemoApprovalBeat(ctx context.Context, run *CLIDemoRun, b CLIDemoBeat, bound time.Duration, x cliDemoExecFunc) (string, error) {
	if b.Approval == nil || b.Approval.Rerun == nil || b.Approval.ConfirmName == nil {
		return "", fmt.Errorf("beat %q is not an approval beat (no Approval, Rerun or ConfirmName)", b.StepID)
	}
	if run.Admin == nil {
		return "", fmt.Errorf("the run has no CLIDemoAdmin, so nobody can approve the %s; ResolveCLIDemoRun sets it", b.StepID)
	}
	argv := b.Args(run)
	out, code, err := x(ctx, run, argv, bound)
	if err != nil {
		return "", fmt.Errorf("`alethia %s` could not be run: %w\n%s", strings.Join(argv, " "), err, out)
	}
	if code == 0 {
		return "", fmt.Errorf("`alethia %s` exited 0: the %s was queued WITHOUT a person's approval. Table 4.2 "+
			"says a service token's destroy is never automatic (#7454), so either the control plane "+
			"stopped asking or this beat no longer reaches it:\n%s", strings.Join(argv, " "), b.StepID, out)
	}
	id, err := cliDemoApprovalIDFrom(out, code)
	if err != nil {
		return "", fmt.Errorf("`alethia %s`: %w", strings.Join(argv, " "), err)
	}
	run.ApprovalID = id
	if err := run.Admin.Approve(ctx, id, b.Approval.ConfirmName(run)); err != nil {
		return "", fmt.Errorf("the CLI requested approval %s, and the org's owner could not approve it: %w", id, err)
	}
	rerun := b.Approval.Rerun(run)
	out, code, err = x(ctx, run, rerun, bound)
	if err != nil {
		return "", fmt.Errorf("approval %s is approved, and `alethia %s` could not be run: %w\n%s",
			id, strings.Join(rerun, " "), err, out)
	}
	if code != 0 {
		return "", fmt.Errorf("approval %s is approved, and `alethia %s` still exited %d:\n%s",
			id, strings.Join(rerun, " "), code, out)
	}
	// The CLI says which approval it queued with ("Approval <id> of plan <plan> is approved"). A rerun
	// that does not name this one asked for a different approval, and the one approved here was not
	// what released the job.
	if !strings.Contains(out, id) {
		return "", fmt.Errorf("`alethia %s` succeeded but does not name approval %s, so the job was not "+
			"queued with the approval the owner gave:\n%s", strings.Join(rerun, " "), id, out)
	}
	return out, nil
}

// cliDemoApprovalIDFrom reads the approval id out of the CLI's exit-9 error envelope
// (alethia.error/v1, `--output json`): `error.code` must be approval_required and
// `error.operation` must name an APPROVAL by its UUID.
//
// The envelope is one JSON line on stderr; the combined output also carries the human warning that
// names the page and the digest, so the line is found rather than assumed to be the whole output.
// Exit 9 alone is not enough: it is also the CLI's code for a confirmation it could not ask for.
func cliDemoApprovalIDFrom(out string, exitCode int) (string, error) {
	if exitCode != cliDemoApprovalExit {
		return "", fmt.Errorf("exited %d, want %d (%s) — the command did not stop for an approval:\n%s",
			exitCode, cliDemoApprovalExit, cliDemoApprovalCode, out)
	}
	type envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Operation *struct {
				ID   string `json:"id"`
				Type string `json:"type"`
			} `json:"operation"`
		} `json:"error"`
	}
	var found *envelope
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var e envelope
		if json.Unmarshal([]byte(line), &e) == nil && e.Error.Code != "" {
			found = &e
		}
	}
	if found == nil {
		return "", fmt.Errorf("exited %d with no JSON error envelope — the beat must pass `--output json`:\n%s", exitCode, out)
	}
	if found.Error.Code != cliDemoApprovalCode {
		return "", fmt.Errorf("exited %d with error %q (%s), want %q:\n%s",
			exitCode, found.Error.Code, found.Error.Message, cliDemoApprovalCode, out)
	}
	op := found.Error.Operation
	if op == nil || op.Type != "APPROVAL" {
		return "", fmt.Errorf("the %s envelope names no APPROVAL operation, so there is no approval id to decide:\n%s",
			cliDemoApprovalCode, out)
	}
	if !uuidRe.MatchString(op.ID) || len(op.ID) != 36 {
		return "", fmt.Errorf("the %s envelope's operation id %q is not a UUID:\n%s", cliDemoApprovalCode, op.ID, out)
	}
	return op.ID, nil
}

// cliDemoApprovalHint is added to a failed ordinary beat's message when the binary exited 9, the
// code an unanswered approval exits with under --no-wait. On the `apply` beat that means the token
// does not list the run's environment, which is the `project-env` beat's owner step, not the deploy.
func cliDemoApprovalHint(err error) string {
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != cliDemoApprovalExit {
		return ""
	}
	return " — exit 9 is approval_required (or another input the CLI could not ask for). For a deploy, " +
		"the token does not list this environment for automatic deploys: check that the `project-env` " +
		"beat's owner step ran (#7454)"
}

// cliDemoBeatInvocations is every argv a beat runs: its Args, and for an approval beat its Rerun.
// The pre-spend flag check probes all of them, so a rerun that names an unregistered flag is found
// before a cluster is bought rather than after the approval.
func cliDemoBeatInvocations(b CLIDemoBeat, r *CLIDemoRun) [][]string {
	out := [][]string{b.Args(r)}
	if b.Approval != nil && b.Approval.Rerun != nil {
		out = append(out, b.Approval.Rerun(r))
	}
	return out
}

// cliDemoScriptAdmin is the real CLIDemoAdmin: it runs cliDemoApprovalScript through pnpm, from the
// repository root, against the database the job's environment names.
type cliDemoScriptAdmin struct {
	// root is the repository root.
	root string
	// creds is the file the seed step wrote: the token, its org and the owner.
	creds string
	// exec runs the command. A field so the pure test can see the argv without running pnpm.
	exec func(ctx context.Context, dir string, argv []string) ([]byte, error)
}

// AutoApproveEnvironment lists the run's environment on the seeded token (decision D2).
func (a cliDemoScriptAdmin) AutoApproveEnvironment(ctx context.Context, projectID, envName string) error {
	return a.invoke(ctx, cliDemoAdminArgv(a.creds, "auto-approve", "--project", projectID, "--env", envName))
}

// Approve decides the approval as the org's owner, in a console session made for it.
func (a cliDemoScriptAdmin) Approve(ctx context.Context, approvalID, confirmEnvName string) error {
	return a.invoke(ctx, cliDemoAdminArgv(a.creds, "approve", "--approval", approvalID, "--confirm-env", confirmEnvName))
}

// invoke runs one subcommand of the script and returns its output in the error when it fails. The
// script never prints the token, so its output is safe to put in a test log.
func (a cliDemoScriptAdmin) invoke(ctx context.Context, argv []string) error {
	cctx, cancel := context.WithTimeout(ctx, cliDemoAdminTimeout)
	defer cancel()
	out, err := a.exec(cctx, a.root, argv)
	if err != nil {
		return fmt.Errorf("`pnpm %s` failed: %w\n%s", strings.Join(argv, " "), err, out)
	}
	return nil
}

// cliDemoAdminArgv is the pnpm argv for one subcommand of the owner-side script. `-F console exec`
// runs it in apps/console, the way the workflow runs the seed script, so `@/` imports resolve.
func cliDemoAdminArgv(creds, sub string, args ...string) []string {
	argv := []string{"-F", "console", "exec", "tsx", strings.TrimPrefix(cliDemoApprovalScript, "apps/console/"), sub, "--creds", creds}
	return append(argv, args...)
}

// newCLIDemoScriptAdmin builds the real CLIDemoAdmin and refuses, before anything is bought, every
// way it could fail later: no script, no pnpm, no database to run it against.
func newCLIDemoScriptAdmin(credsPath string, getenv func(string) string) (CLIDemoAdmin, error) {
	if credsPath == "" {
		return nil, fmt.Errorf("%s is unset — the owner-side steps read the token from the seed step's file", cliDemoCredsEnv)
	}
	var missing []string
	for _, name := range []string{"ALETHIA_DATABASE_URL", "ALETHIA_APP_DATABASE_URL"} {
		if strings.TrimSpace(getenv(name)) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("%s unset — %s lists the run's environment on the token and approves the "+
			"destroy against the job's database, and without it the apply would be refused 403 approval_required",
			strings.Join(missing, ", "), cliDemoApprovalScript)
	}
	root, err := cliDemoRepoRoot()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(root, cliDemoApprovalScript)); err != nil {
		return nil, fmt.Errorf("the owner-side script %s is missing: %w", cliDemoApprovalScript, err)
	}
	if _, err := exec.LookPath("pnpm"); err != nil {
		return nil, fmt.Errorf("pnpm is not on PATH, so %s cannot run: %w", cliDemoApprovalScript, err)
	}
	return cliDemoScriptAdmin{
		root:  root,
		creds: credsPath,
		exec: func(ctx context.Context, dir string, argv []string) ([]byte, error) {
			cmd := exec.CommandContext(ctx, "pnpm", argv...)
			cmd.Dir = dir
			return cmd.CombinedOutput()
		},
	}, nil
}

// cliDemoRepoRoot is the repository root, two levels above this file (test/e2e/<file>).
func cliDemoRepoRoot() (string, error) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("runtime.Caller failed, so the repository root is unknown")
	}
	return filepath.Abs(filepath.Join(filepath.Dir(thisFile), "..", ".."))
}
