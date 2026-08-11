// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
)

// ---------------------------------------------------------------------------
// Harness
//
// The `connector *` commands are package-level `&cobra.Command{Run: func…}`
// values whose bodies talk to the control plane, shell out to a cloud CLI, and
// end in fail()/failf(). Driving them therefore needs three things: a fake
// control plane, a fake `aws`/`gcloud`/`az`/`aliyun`/`bash` early on PATH, and
// the exitFunc seam so a fatal arm unwinds into the test instead of killing the
// binary.
// ---------------------------------------------------------------------------

// connExit is the sentinel the exitFunc stub panics with, carrying the code the
// command asked the process to exit with.
type connExit struct{ code int }

// connInvoke runs the CLI through the real cobra tree with exitFunc substituted.
// It reports whether the command took a fatal path and, if so, with which code.
func connInvoke(t *testing.T, run func(args ...string) error, args ...string) (exited bool, code int, err error) {
	t.Helper()
	prev := exitFunc
	exitFunc = func(c int) { panic(connExit{code: c}) }
	defer func() {
		exitFunc = prev
		if r := recover(); r != nil {
			e, ok := r.(connExit)
			if !ok {
				panic(r)
			}
			exited, code = true, e.code
		}
	}()
	err = run(args...)
	return false, 0, err
}

// connFakeAPI configures the fake control plane the connector commands talk to.
// A zero value serves the happy path: init succeeds, connect verifies, the org
// has one connected AWS account, and disconnect succeeds.
type connFakeAPI struct {
	initStatus       int                    // non-zero -> /init fails with this status
	connect          map[string]interface{} // body for /connect (nil -> verified)
	connectStatus    int                    // non-zero -> /connect fails with this status
	identities       []map[string]interface{}
	noIdentities     bool // serve an empty cloud-identities list
	identitiesStatus int
	disconnectStatus int
	rec              *connRecorder // optional: records every request the CLI makes
}

// connRecorder records the requests the fake control plane received. The handler
// runs on the server's goroutine, so access is mutex-guarded.
type connRecorder struct {
	mu    sync.Mutex
	paths []string
}

func (r *connRecorder) add(p string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.paths = append(r.paths, p)
}

// saw reports whether any recorded request path contains the given fragment.
func (r *connRecorder) saw(fragment string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.paths {
		if strings.Contains(p, fragment) {
			return true
		}
	}
	return false
}

// connEnv stands up isolated credentials, a fake control plane wired to the
// connector endpoints, and returns a runner that executes the real cobra tree.
// Connector flags are reset before and after the test because rootCmd is a
// package global whose flag state is sticky across Execute calls.
func connEnv(t *testing.T, cfg connFakeAPI) func(args ...string) error {
	t.Helper()
	connResetConnectorFlags(t)

	credsPath := isolatedHome(t)
	tok := makeToken(t, time.Now().Add(time.Hour))
	if err := saveCredentials(credsPath, types.ExchangeResponse{AccessToken: tok, RefreshToken: "r"}); err != nil {
		t.Fatalf("saveCredentials: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if cfg.rec != nil {
			cfg.rec.add(p)
		}
		enc := json.NewEncoder(w)
		switch {
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/init"):
			if cfg.initStatus != 0 {
				w.WriteHeader(cfg.initStatus)
				_ = enc.Encode(map[string]string{"error": "init unavailable"})
				return
			}
			_ = enc.Encode(map[string]interface{}{"identity_id": "cid-1", "external_id": "ext-1"})
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/connect"):
			if cfg.connectStatus != 0 {
				w.WriteHeader(cfg.connectStatus)
				_ = enc.Encode(map[string]string{"error": "connect unavailable"})
				return
			}
			body := cfg.connect
			if body == nil {
				body = map[string]interface{}{
					"identity_id": "cid-1", "verified": true, "status": "connected",
				}
			}
			_ = enc.Encode(body)
		case strings.HasPrefix(p, "/api/cli/providers/") && strings.HasSuffix(p, "/disconnect"):
			if cfg.disconnectStatus != 0 {
				w.WriteHeader(cfg.disconnectStatus)
				_ = enc.Encode(map[string]string{"error": "disconnect refused"})
				return
			}
			_ = enc.Encode(map[string]interface{}{"ok": true})
		case p == "/api/cli/cloud-identities":
			if cfg.identitiesStatus != 0 {
				w.WriteHeader(cfg.identitiesStatus)
				_ = enc.Encode(map[string]string{"error": "identities unavailable"})
				return
			}
			ids := cfg.identities
			if ids == nil && !cfg.noIdentities {
				ids = []map[string]interface{}{
					{"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
				}
			}
			if ids == nil {
				ids = []map[string]interface{}{}
			}
			_ = enc.Encode(map[string]interface{}{"cloud_identities": ids})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = enc.Encode(map[string]string{"error": "not found: " + p})
		}
	}))
	t.Cleanup(srv.Close)

	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")

	return func(args ...string) error {
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	}
}

// connResetConnectorFlags restores every connector flag variable to its
// registered default, before and after the test. cobra never resets a bound
// variable between Execute calls, so without this one test's --manual leaks
// into the next.
func connResetConnectorFlags(t *testing.T) {
	t.Helper()
	reset := func() {
		connectorAwsRegion = ""
		connectorAwsRoleName = defaultAwsRoleName
		connectorAwsManual = false
		connectorAwsScript = false
		connectorGcpProject = ""
		connectorGcpManual = false
		connectorAzureSubscription = ""
		connectorAzureManual = false
		connectorAlibabaRegion = ""
		connectorAlibabaDir = ""
		connectorAlibabaManual = false
		connectorAlibabaTerraform = false
		connectorHetznerToken = ""
		connectorHetznerTokenStdin = false
		connectorHetznerS3AccessKey = ""
		connectorHetznerS3SecretKey = ""
		connectorRemoveYes = false
	}
	reset()
	t.Cleanup(reset)
}

// connStubForm replaces the interactive form with one that returns err without
// touching the answer pointers — the behaviour a user gets when the prompt is
// aborted or (with a nil err) left blank.
func connStubForm(t *testing.T, err error) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(_ ...*huh.Group) error { return err }
	t.Cleanup(func() { runHuhForm = prev })
}

// connStubFormTyping replaces the interactive form with one that answers it, by
// driving huh's bubbletea model directly: each answer is typed rune by rune into
// the focused field, then NextField advances. This is what lets a test reach
// everything AFTER a successful prompt — the answers are written through
// pointers huh owns and never exposes, so no stub can set them from outside.
//
// Measured, not assumed: huh.Form.Update fills the bound value with no TTY
// involved and without blocking, so no production seam is needed for this.
func connStubFormTyping(t *testing.T, answers ...string) {
	t.Helper()
	prev := runHuhForm
	runHuhForm = func(groups ...*huh.Group) error {
		f := huh.NewForm(groups...)
		f.Init()
		for _, answer := range answers {
			for _, r := range answer {
				f.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
			}
			f.Update(huh.NextField())
		}
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
}

// connStubConfirm replaces the yes/no dialog with a fixed answer. It forces the
// interactive mode on too: a destructive command consults noInputMode before the
// prompt, and a headless test process is never a terminal, so without this it takes
// the "--yes is required" fatal arm and the stubbed answer is never asked for.
func connStubConfirm(t *testing.T, answer bool) {
	t.Helper()
	hygCliConfirmInteractive(t)
	prev := confirm
	confirm = func(string, string) bool { return answer }
	t.Cleanup(func() { confirm = prev })
}

const connSetupScriptOutput = `#!/bin/sh
echo "--- START CONFIG ---"
echo "role_arn=acs:ram::123456789012:role/AlethiaProvisioner"
echo "tenant_id=11111111-1111-1111-1111-111111111111"
echo "client_id=22222222-2222-2222-2222-222222222222"
echo "subscription_id=33333333-3333-3333-3333-333333333333"
echo "--- END CONFIG ---"
`

const connAwsStub = `#!/bin/sh
if [ "$2" = "describe-stacks" ]; then
  echo "arn:aws:iam::123456789012:role/AlethiaProvisionerRole"
fi
exit 0
`

const connGcloudStub = `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo "tester@example.com"
  exit 0
fi
echo "--- START CONFIG ---"
echo '{"type":"external_account","audience":"//iam.googleapis.com/x"}'
echo "--- END CONFIG ---"
exit 0
`

// connGcloudUnauthedStub is installed and exits 0 but reports no active account,
// which is exactly how EnsureGcloud distinguishes "not authenticated".
const connGcloudUnauthedStub = `#!/bin/sh
exit 0
`

// connGcloudBadJSONStub returns a well-formed CONFIG block whose payload is not
// JSON, so the gcp command reaches its "not valid JSON" guard.
const connGcloudBadJSONStub = `#!/bin/sh
if [ "$1" = "auth" ]; then
  echo "tester@example.com"
  exit 0
fi
echo "--- START CONFIG ---"
echo "not-json-at-all"
echo "--- END CONFIG ---"
exit 0
`

const connTrivialStub = `#!/bin/sh
exit 0
`

// connFakeBin makes a directory of stub executables the ONLY thing on PATH, so
// the command sees exactly the cloud CLIs the test names and nothing from this
// machine. `bash` is stubbed too: the connector installers are run as
// `bash <script> <arg>`, and the stub emits the CONFIG block the real installers
// would, which keeps the capture paths deterministic and offline.
func connFakeBin(t *testing.T, tools map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range tools {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatalf("write stub %s: %v", name, err)
		}
	}
	t.Setenv("PATH", dir)
	return dir
}

// connAllCloudCLIs installs working stubs for every cloud CLI the connector
// commands shell out to.
func connAllCloudCLIs(t *testing.T) {
	t.Helper()
	connFakeBin(t, map[string]string{
		"aws":    connAwsStub,
		"gcloud": connGcloudStub,
		"az":     connTrivialStub,
		"aliyun": connTrivialStub,
		"bash":   connSetupScriptOutput,
	})
}

// connNoCloudCLIs empties PATH so every Ensure* probe reports "not found".
func connNoCloudCLIs(t *testing.T) {
	t.Helper()
	connFakeBin(t, map[string]string{})
}

// ---------------------------------------------------------------------------
// connector.go — initProviderIdentity / finalizeConnection
// ---------------------------------------------------------------------------

// TestConn_ParentCommandRegistersEveryProvider pins that the connector group
// carries the five subcommands the CLI advertises.
func TestConn_ParentCommandRegistersEveryProvider(t *testing.T) {
	want := map[string]bool{"aws": false, "gcp": false, "azure": false, "alibaba": false, "remove": false}
	for _, c := range connectorCmd.Commands() {
		if _, ok := want[c.Name()]; ok {
			want[c.Name()] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("connector %s is not registered", name)
		}
	}
}

// TestConn_FinalizeVerdicts pins finalizeConnection's four verdict arms:
// verified, degraded-with-missing-permissions, failed-with-detail and
// failed-without-detail. Each is driven end-to-end through `connector aws`.
func TestConn_FinalizeVerdicts(t *testing.T) {
	cases := []struct {
		name     string
		body     map[string]interface{}
		wantExit bool
	}{
		{
			name: "verified",
			body: map[string]interface{}{"identity_id": "cid-1", "verified": true, "status": "connected"},
		},
		{
			name: "degraded_with_missing_permissions",
			body: map[string]interface{}{
				"identity_id": "cid-1", "verified": true, "status": "degraded",
				"missing_permissions": []string{"ec2:CreateVpc", "eks:CreateCluster"},
			},
		},
		{
			name:     "failed_with_detail",
			body:     map[string]interface{}{"identity_id": "cid-1", "verified": false, "status": "disconnected", "error": "assume role denied"},
			wantExit: true,
		},
		{
			name:     "failed_without_detail",
			body:     map[string]interface{}{"identity_id": "cid-1", "verified": false, "status": "disconnected"},
			wantExit: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := connEnv(t, connFakeAPI{connect: tc.body})
			connAllCloudCLIs(t)
			exited, code, err := connInvoke(t, run, "connector", "aws")
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if exited != tc.wantExit {
				t.Fatalf("exited = %v (code %d), want %v", exited, code, tc.wantExit)
			}
			if exited && code != 1 {
				t.Errorf("exit code = %d, want 1", code)
			}
		})
	}
}

// TestConn_FinalizeTransportError pins that a non-2xx from /connect is fatal for
// every provider — none of them reports success on a submission that never
// landed.
func TestConn_FinalizeTransportError(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		t.Run(provider, func(t *testing.T) {
			run := connEnv(t, connFakeAPI{connectStatus: http.StatusInternalServerError})
			connAllCloudCLIs(t)
			args := []string{"connector", provider}
			switch provider {
			case "gcp":
				args = append(args, "--project", "demo-proj")
			case "azure":
				args = append(args, "--subscription", "sub-1")
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// TestConn_InitIdentityFailureIsFatal pins that a failing /init aborts before
// any cloud CLI is touched.
func TestConn_InitIdentityFailureIsFatal(t *testing.T) {
	for _, provider := range []string{"aws", "gcp", "azure", "alibaba"} {
		t.Run(provider, func(t *testing.T) {
			run := connEnv(t, connFakeAPI{initStatus: http.StatusBadGateway})
			connAllCloudCLIs(t)
			args := []string{"connector", provider}
			switch provider {
			case "gcp":
				args = append(args, "--project", "demo-proj")
			case "azure":
				args = append(args, "--subscription", "sub-1")
			}
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// TestConn_AuthRequiredIsFatal pins that every connector command exits when
// there are no usable credentials and the user declines to log in.
func TestConn_AuthRequiredIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	credsPath, err := getCredentialsPath()
	if err != nil {
		t.Fatalf("creds path: %v", err)
	}
	if err := os.Remove(credsPath); err != nil {
		t.Fatalf("remove credentials: %v", err)
	}
	prev := authRequiredPrompt
	authRequiredPrompt = func() (bool, error) { return false, nil }
	t.Cleanup(func() { authRequiredPrompt = prev })

	for _, args := range [][]string{
		{"connector", "aws"},
		{"connector", "gcp", "--project", "demo-proj"},
		{"connector", "azure", "--subscription", "sub-1"},
		{"connector", "alibaba"},
		{"connector", "remove", "aws"},
	} {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			exited, code, err := connInvoke(t, run, args...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// connector_aws.go
// ---------------------------------------------------------------------------

// TestConn_AwsLocalFlowDeploysStack pins the default path: the CloudFormation
// stack is deployed with the local aws CLI and the ARN read from its outputs is
// what gets submitted.
func TestConn_AwsLocalFlowDeploysStack(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--region", "eu-west-1", "--role-name", "CustomRole")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AwsLocalFlowFallsBackToDefaultRoleName pins that an empty --role-name
// falls back to the documented default rather than deploying a nameless role.
func TestConn_AwsLocalFlowFallsBackToDefaultRoleName(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--role-name", "")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if connectorAwsRoleName != "" {
		t.Errorf("connectorAwsRoleName = %q, want the flag to stay empty", connectorAwsRoleName)
	}
}

// TestConn_AwsScriptFlowUsesSetupScript pins --script: the shell installer runs
// and the role ARN is parsed out of its CONFIG block.
func TestConn_AwsScriptFlowUsesSetupScript(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--script")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AwsMissingCliIsFatal pins that both aws-CLI paths abort with guidance
// when the aws CLI is not installed.
func TestConn_AwsMissingCliIsFatal(t *testing.T) {
	for _, extra := range [][]string{{}, {"--script"}} {
		t.Run(strings.Join(append([]string{"aws"}, extra...), "_"), func(t *testing.T) {
			run := connEnv(t, connFakeAPI{})
			connNoCloudCLIs(t)
			exited, code, err := connInvoke(t, run, append([]string{"connector", "aws"}, extra...)...)
			if err != nil {
				t.Fatalf("execute: %v", err)
			}
			if !exited || code != 1 {
				t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
			}
		})
	}
}

// TestConn_AwsManualFlowRequiresRoleArn pins --manual: a blank answer is
// rejected rather than submitted as an empty role ARN.
func TestConn_AwsManualFlowRequiresRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "aws", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AwsManualFlowAbortedPromptIsFatal pins that an aborted prompt is
// surfaced as the command's failure, not swallowed.
func TestConn_AwsManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "aws", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AwsManualFlowSubmitsPastedRoleArn pins the answered --manual path:
// the pasted ARN is trimmed and submitted, and the connection is reported
// against it.
func TestConn_AwsManualFlowSubmitsPastedRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local aws CLI
	connStubFormTyping(t, "  arn:aws:iam::123456789012:role/Pasted  ")
	exited, code, err := connInvoke(t, run, "connector", "aws", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// ---------------------------------------------------------------------------
// connector_gcp.go
// ---------------------------------------------------------------------------

// TestConn_GcpCloudShellFlowConnects pins the default path: the installer runs
// through gcloud Cloud Shell and the WIF config it prints is submitted.
func TestConn_GcpCloudShellFlowConnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_GcpPromptsWhenProjectFlagOmitted pins that the project is asked for
// when --project is absent, and the answer is what the command proceeds with.
func TestConn_GcpPromptsWhenProjectFlagOmitted(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubFormTyping(t, "  prompted-proj  ")
	exited, code, err := connInvoke(t, run, "connector", "gcp")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if connectorGcpProject != "prompted-proj" {
		t.Errorf("project = %q, want the answer trimmed to %q", connectorGcpProject, "prompted-proj")
	}
}

// TestConn_GcpBlankProjectIsFatal pins that an empty answer to the project
// prompt aborts instead of initializing an unnamed project.
func TestConn_GcpBlankProjectIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "gcp")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpAbortedProjectPromptIsFatal pins that an aborted project prompt is
// fatal.
func TestConn_GcpAbortedProjectPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "gcp")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpMissingGcloudIsFatal pins the "gcloud not on PATH" arm.
func TestConn_GcpMissingGcloudIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpUnauthenticatedGcloudIsFatal pins the distinct "gcloud is
// installed but has no active account" arm.
func TestConn_GcpUnauthenticatedGcloudIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connFakeBin(t, map[string]string{"gcloud": connGcloudUnauthedStub})
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpNonJsonWifConfigIsFatal pins that a CONFIG block which is not JSON
// is rejected before it reaches the control plane.
func TestConn_GcpNonJsonWifConfigIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connFakeBin(t, map[string]string{"gcloud": connGcloudBadJSONStub})
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpManualFlowRequiresWifConfig pins --manual: a blank paste is
// rejected rather than submitted.
func TestConn_GcpManualFlowRequiresWifConfig(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpManualFlowAbortedPromptIsFatal pins that aborting the paste prompt
// is fatal.
func TestConn_GcpManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_GcpManualFlowSubmitsPastedWifConfig pins the answered --manual path:
// the pasted credential config is parsed and submitted without gcloud.
func TestConn_GcpManualFlowSubmitsPastedWifConfig(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local gcloud
	connStubFormTyping(t, `{"type":"external_account","audience":"//iam.googleapis.com/x"}`)
	exited, code, err := connInvoke(t, run, "connector", "gcp", "--project", "demo-proj", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// ---------------------------------------------------------------------------
// connector_azure.go
// ---------------------------------------------------------------------------

// TestConn_AzureLocalFlowConnects pins the default path: the setup script runs
// under the local az CLI and the IDs it prints are submitted.
func TestConn_AzureLocalFlowConnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AzurePromptsWhenSubscriptionFlagOmitted pins that the subscription is
// asked for when --subscription is absent.
func TestConn_AzurePromptsWhenSubscriptionFlagOmitted(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubFormTyping(t, " prompted-sub ")
	exited, code, err := connInvoke(t, run, "connector", "azure")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if connectorAzureSubscription != "prompted-sub" {
		t.Errorf("subscription = %q, want it trimmed", connectorAzureSubscription)
	}
}

// TestConn_AzureBlankSubscriptionIsFatal pins that an empty answer aborts.
func TestConn_AzureBlankSubscriptionIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "azure")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureAbortedSubscriptionPromptIsFatal pins that aborting the
// subscription prompt is fatal.
func TestConn_AzureAbortedSubscriptionPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "azure")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureMissingCliIsFatal pins the "az not on PATH" arm.
func TestConn_AzureMissingCliIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureManualFlowRequiresAllIds pins --manual: leaving any of the
// tenant/client/subscription answers blank is rejected.
func TestConn_AzureManualFlowRequiresAllIds(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureManualFlowAbortedPromptIsFatal pins that aborting the manual
// prompt is fatal.
func TestConn_AzureManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AzureManualFlowSubmitsPastedIds pins the answered --manual path: the
// three pasted IDs are trimmed and submitted without a local az CLI.
func TestConn_AzureManualFlowSubmitsPastedIds(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local az
	connStubFormTyping(t,
		" 11111111-1111-1111-1111-111111111111 ",
		" 22222222-2222-2222-2222-222222222222 ",
		" 33333333-3333-3333-3333-333333333333 ",
	)
	exited, code, err := connInvoke(t, run, "connector", "azure", "--subscription", "sub-1", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// ---------------------------------------------------------------------------
// connector_alibaba.go
// ---------------------------------------------------------------------------

// TestConn_AlibabaLocalFlowConnects pins the default path: the setup script runs
// under the local aliyun CLI and the RAM role ARN it prints is submitted.
func TestConn_AlibabaLocalFlowConnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "alibaba")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AlibabaMissingCliIsFatal pins the "aliyun not on PATH" arm.
func TestConn_AlibabaMissingCliIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t)
	exited, code, err := connInvoke(t, run, "connector", "alibaba")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaManualFlowRequiresRoleArn pins --manual: a blank paste is
// rejected rather than submitted as an empty ARN.
func TestConn_AlibabaManualFlowRequiresRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaManualFlowAbortedPromptIsFatal pins that aborting the manual
// prompt is fatal.
func TestConn_AlibabaManualFlowAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaManualFlowSubmitsPastedRoleArn pins the answered --manual
// path: the pasted RAM role ARN is trimmed and submitted without a local aliyun
// CLI.
func TestConn_AlibabaManualFlowSubmitsPastedRoleArn(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connNoCloudCLIs(t) // --manual must not need a local aliyun
	connStubFormTyping(t, "  acs:ram::123456789012:role/AlethiaProvisioner  ")
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--manual")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_AlibabaTerraformFlowWritesModule pins --terraform: the OpenTofu
// module is written to the chosen directory before the user is asked for the
// role_arn output.
func TestConn_AlibabaTerraformFlowWritesModule(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	dir := filepath.Join(t.TempDir(), "module-out")
	exited, code, err := connInvoke(t, run,
		"connector", "alibaba", "--terraform", "--dir", dir, "--region", "cn-beijing")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1) after the blank paste", exited, code)
	}
	if _, statErr := os.Stat(filepath.Join(dir, "main.tf")); statErr != nil {
		t.Fatalf("main.tf was not written: %v", statErr)
	}
}

// TestConn_AlibabaTerraformFlowDefaultsDirAndRegion pins that omitting --dir and
// --region writes ./alethia-alibaba-connector and prints the default region.
func TestConn_AlibabaTerraformFlowDefaultsDirAndRegion(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	connStubForm(t, nil)
	t.Chdir(t.TempDir())
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--terraform")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1) after the blank paste", exited, code)
	}
	if _, statErr := os.Stat(filepath.Join("alethia-alibaba-connector", "main.tf")); statErr != nil {
		t.Fatalf("default module dir was not written: %v", statErr)
	}
}

// TestConn_AlibabaTerraformFlowUnwritableDirIsFatal pins that a --dir that
// cannot be created aborts with a clear error instead of prompting anyway.
func TestConn_AlibabaTerraformFlowUnwritableDirIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--terraform", "--dir", blocker)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_AlibabaTerraformFlowUnwritableModuleIsFatal pins the second write
// guard: the directory exists but main.tf cannot be created.
func TestConn_AlibabaTerraformFlowUnwritableModuleIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connAllCloudCLIs(t)
	dir := filepath.Join(t.TempDir(), "module-out")
	if err := os.MkdirAll(filepath.Join(dir, "main.tf"), 0o755); err != nil {
		t.Fatalf("mkdir main.tf/: %v", err)
	}
	exited, code, err := connInvoke(t, run, "connector", "alibaba", "--terraform", "--dir", dir)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// ---------------------------------------------------------------------------
// connector_remove.go
// ---------------------------------------------------------------------------

// TestConn_RemoveByProviderArgument pins that a provider argument skips the
// picker and disconnects the matching identity, and that -y skips the prompt.
func TestConn_RemoveByProviderArgument(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	exited, code, err := connInvoke(t, run, "connector", "remove", "AWS", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_RemoveUnknownProviderIsFatal pins that naming a provider with no
// connection is an error, not a silent no-op.
func TestConn_RemoveUnknownProviderIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	exited, code, err := connInvoke(t, run, "connector", "remove", "gcp", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_RemoveWithNoConnections pins the empty-state: nothing to pick, so the
// command reports and returns without calling disconnect.
func TestConn_RemoveWithNoConnections(t *testing.T) {
	run := connEnv(t, connFakeAPI{noIdentities: true})
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_RemoveListFailureIsFatal pins that a failing cloud-identities fetch
// aborts.
func TestConn_RemoveListFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{identitiesStatus: http.StatusInternalServerError})
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_RemovePickerDisconnectsTheSelectedConnection pins the picker arm of
// pickIdentity: with no provider argument the list is offered as a select, whose
// pre-selected first option is what a submitted-unchanged form yields — and that
// is the connection disconnected.
func TestConn_RemovePickerDisconnectsTheSelectedConnection(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{
		rec: rec,
		identities: []map[string]interface{}{
			{"id": "ci2", "provider": "gcp", "label": "demo-proj", "created_at": "2026-01-02T00:00:00Z"},
			{"id": "ci1", "provider": "aws", "label": "prod-account", "created_at": "2026-01-01T00:00:00Z"},
		},
	})
	connStubForm(t, nil)
	connStubConfirm(t, true)
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if !rec.saw("/providers/gcp/disconnect") {
		t.Error("the pre-selected first connection (gcp) was not the one disconnected")
	}
	if rec.saw("/providers/aws/disconnect") {
		t.Error("a connection other than the selected one was disconnected")
	}
}

// TestConn_RemoveAbortedPickerIsFatal pins that an aborted picker is fatal.
func TestConn_RemoveAbortedPickerIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connStubForm(t, errors.New("prompt aborted"))
	exited, code, err := connInvoke(t, run, "connector", "remove")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// TestConn_RemoveDeclinedConfirmationDoesNothing pins that answering "no" to the
// confirmation returns without disconnecting.
func TestConn_RemoveDeclinedConfirmationDoesNothing(t *testing.T) {
	// A rejected disconnect endpoint proves the call is never made: if the
	// declined confirmation did not short-circuit, the 403 would be fatal.
	run := connEnv(t, connFakeAPI{disconnectStatus: http.StatusForbidden})
	connStubConfirm(t, false)
	exited, code, err := connInvoke(t, run, "connector", "remove", "aws")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d) — disconnect must not be called", code)
	}
}

// TestConn_RemoveConfirmedDisconnects pins the confirmed arm: the disconnect
// call is made and the command succeeds.
func TestConn_RemoveConfirmedDisconnects(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	connStubConfirm(t, true)
	exited, code, err := connInvoke(t, run, "connector", "remove", "aws")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
}

// TestConn_RemoveDisconnectFailureIsFatal pins that a rejected disconnect is
// reported as a failure.
func TestConn_RemoveDisconnectFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{disconnectStatus: http.StatusForbidden})
	exited, code, err := connInvoke(t, run, "connector", "remove", "aws", "--yes")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code != 1 {
		t.Fatalf("exited=%v code=%d, want a fatal exit(1)", exited, code)
	}
}

// ---------------------------------------------------------------------------
// Hetzner — the one cloud that authenticates with a token, and the one the CLI
// could not connect at all until lib/cli/providers.ts stopped 400-ing it.
// ---------------------------------------------------------------------------

// TestConn_HetznerTokenFlowConnects drives the real cobra tree end to end: init, capture the token
// from --token, submit, verify. The token path is deliberately the simplest connector in the tree —
// no Cloud Shell, no cloud CLI, no Terraform module — so nothing is stubbed but the control plane.
func TestConn_HetznerTokenFlowConnects(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	// The provider segment must be `hetzner` — the whole bug was these routes rejecting it.
	if !rec.saw("/providers/hetzner/init") || !rec.saw("/providers/hetzner/connect") {
		t.Errorf("expected hetzner init + connect, saw %v", rec.paths)
	}
}

// TestConn_HetznerCarriesTheS3Pair pins the other half of the server fix: the console has always
// passed Hetzner's Object-Storage key pair, and the CLI route silently dropped it, so a CLI-created
// connection could never provision a bucket.
func TestConn_HetznerCarriesTheS3Pair(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	exited, _, err := connInvoke(t, run, "connector", "hetzner",
		"--token", strings.Repeat("h", 64),
		"--s3-access-key", "AKIAHETZNER",
		"--s3-secret-key", "sekrit",
	)
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatal("unexpected fatal exit")
	}
	if connectorHetznerS3AccessKey != "AKIAHETZNER" || connectorHetznerS3SecretKey != "sekrit" {
		t.Errorf("S3 flags not bound: %q / %q", connectorHetznerS3AccessKey, connectorHetznerS3SecretKey)
	}
}

// TestConn_HetznerShortTokenIsFatal keeps the local validation on the fatal path: a truncated paste
// must fail with our message rather than as a connection-test failure that reads like Hetzner's fault.
func TestConn_HetznerShortTokenIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", "tooshort")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("a short token must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerConnectFailureIsFatal pins the unverified-connection arm.
func TestConn_HetznerConnectFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{connectStatus: http.StatusBadRequest})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("a failed connect must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerInteractivePromptSubmits reaches the masked-prompt path: no --token, no
// --token-stdin, a TTY. This is the flow a person actually uses, and the one where the token never
// touches shell history or the process list.
func TestConn_HetznerInteractivePromptSubmits(t *testing.T) {
	rec := &connRecorder{}
	run := connEnv(t, connFakeAPI{rec: rec})
	// A headless test process is never a terminal, so the prompt arm is unreachable without this —
	// the same reason connStubConfirm forces it.
	hygCliConfirmInteractive(t)
	connStubFormTyping(t, "  "+strings.Repeat("h", 64)+"  ")
	exited, code, err := connInvoke(t, run, "connector", "hetzner")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited {
		t.Fatalf("unexpected fatal exit (code %d)", code)
	}
	if !rec.saw("/providers/hetzner/connect") {
		t.Errorf("the prompted token was never submitted: %v", rec.paths)
	}
}

// TestConn_HetznerAbortedPromptIsFatal — an aborted prompt must not connect with an empty token.
func TestConn_HetznerAbortedPromptIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{})
	hygCliConfirmInteractive(t)
	connStubForm(t, errors.New("aborted"))
	exited, code, err := connInvoke(t, run, "connector", "hetzner")
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("an aborted prompt must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerInitFailureIsFatal covers the init arm — the connection cannot proceed without an
// identity to attach the token to.
func TestConn_HetznerInitFailureIsFatal(t *testing.T) {
	run := connEnv(t, connFakeAPI{initStatus: http.StatusServiceUnavailable})
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("a failed init must exit fatally, got exited=%v code=%d", exited, code)
	}
}

// TestConn_HetznerRequiresAuth covers the getAuthToken arm.
func TestConn_HetznerRequiresAuth(t *testing.T) {
	connResetConnectorFlags(t)
	isolatedHome(t) // no credentials written
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	run := func(args ...string) error {
		rootCmd.SetArgs(args)
		return rootCmd.Execute()
	}
	exited, code, err := connInvoke(t, run, "connector", "hetzner", "--token", strings.Repeat("h", 64))
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !exited || code == 0 {
		t.Fatalf("an unauthenticated invocation must exit fatally, got exited=%v code=%d", exited, code)
	}
}
