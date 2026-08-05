// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloudshell

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shellStubDir makes a fresh directory the *entire* PATH and returns it, so a
// tool lookup can only ever find the fakes a test installs — never a real
// gcloud/aws/az/aliyun that happens to be on the developer's machine.
func shellStubDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	return dir
}

// shellStub installs an executable /bin/sh stub named tool inside dir.
func shellStub(t *testing.T, dir, tool, body string) {
	t.Helper()
	path := filepath.Join(dir, tool)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", tool, err)
	}
}

// shellArgsFile points the stubs at a fresh recording file via
// $ALETHIA_STUB_ARGS and returns a reader for whatever they wrote there.
func shellArgsFile(t *testing.T) func() string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "argv")
	t.Setenv("ALETHIA_STUB_ARGS", path)
	return func() string {
		t.Helper()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read recorded argv: %v", err)
		}
		return string(b)
	}
}

// shellMarkerScript wraps body in the installer's START/END CONFIG markers.
func shellMarkerScript(body string) string {
	return "printf '%s' \"$1\" > \"$ALETHIA_STUB_ARGS\"\n" +
		"echo '--- START CONFIG (machine-readable) ---'\n" +
		body + "\n" +
		"echo '--- END CONFIG ---'\n"
}

// TestShell_EnsureCLIsReportMissingTools pins that each Ensure* returns its own
// sentinel when the tool is absent from PATH.
func TestShell_EnsureCLIsReportMissingTools(t *testing.T) {
	shellStubDir(t)

	if err := EnsureAws(); !errors.Is(err, ErrAwsNotFound) {
		t.Errorf("EnsureAws() = %v, want ErrAwsNotFound", err)
	}
	if err := EnsureAz(); !errors.Is(err, ErrAzNotFound) {
		t.Errorf("EnsureAz() = %v, want ErrAzNotFound", err)
	}
	if err := EnsureAliyun(); !errors.Is(err, ErrAliyunNotFound) {
		t.Errorf("EnsureAliyun() = %v, want ErrAliyunNotFound", err)
	}
	if err := EnsureGcloud(); !errors.Is(err, ErrGcloudNotFound) {
		t.Errorf("EnsureGcloud() = %v, want ErrGcloudNotFound", err)
	}
}

// TestShell_EnsureCLIsAcceptInstalledTools pins that Ensure* succeeds once the
// tool resolves on PATH.
func TestShell_EnsureCLIsAcceptInstalledTools(t *testing.T) {
	dir := shellStubDir(t)
	for _, tool := range []string{"aws", "az", "aliyun"} {
		shellStub(t, dir, tool, "exit 0")
	}

	if err := EnsureAws(); err != nil {
		t.Errorf("EnsureAws() = %v, want nil", err)
	}
	if err := EnsureAz(); err != nil {
		t.Errorf("EnsureAz() = %v, want nil", err)
	}
	if err := EnsureAliyun(); err != nil {
		t.Errorf("EnsureAliyun() = %v, want nil", err)
	}
}

// TestShell_EnsureGcloudRejectsWhenAuthListFails pins that a non-zero, silent
// `gcloud auth list` is reported as "not authenticated" — this is also the
// runCapture path where stderr is empty and the raw exec error is returned.
func TestShell_EnsureGcloudRejectsWhenAuthListFails(t *testing.T) {
	dir := shellStubDir(t)
	shellStub(t, dir, "gcloud", "exit 1")

	if err := EnsureGcloud(); !errors.Is(err, ErrGcloudNotAuthed) {
		t.Errorf("EnsureGcloud() = %v, want ErrGcloudNotAuthed", err)
	}
}

// TestShell_EnsureGcloudRejectsWhenNoActiveAccount pins that an empty account
// list is treated as unauthenticated even though the command succeeded.
func TestShell_EnsureGcloudRejectsWhenNoActiveAccount(t *testing.T) {
	dir := shellStubDir(t)
	shellStub(t, dir, "gcloud", "exit 0")

	if err := EnsureGcloud(); !errors.Is(err, ErrGcloudNotAuthed) {
		t.Errorf("EnsureGcloud() = %v, want ErrGcloudNotAuthed", err)
	}
}

// TestShell_EnsureGcloudAcceptsActiveAccount pins the happy path and the exact
// filter/format flags EnsureGcloud queries with.
func TestShell_EnsureGcloudAcceptsActiveAccount(t *testing.T) {
	dir := shellStubDir(t)
	readArgs := shellArgsFile(t)
	shellStub(t, dir, "gcloud", `printf '%s\n' "$@" > "$ALETHIA_STUB_ARGS"
echo "  me@example.com  "`)

	if err := EnsureGcloud(); err != nil {
		t.Fatalf("EnsureGcloud() = %v, want nil", err)
	}
	argv := readArgs()
	for _, want := range []string{"auth", "list", "--filter=status:ACTIVE", "--format=value(account)"} {
		if !strings.Contains(argv, want) {
			t.Errorf("gcloud argv %q missing %q", argv, want)
		}
	}
}

// TestShell_RunGcpSetupInCloudShellReturnsWifConfig pins that the installer is
// shipped base64-encoded, the project id is shell-quoted, and the block between
// the markers comes back as the WIF credential config.
func TestShell_RunGcpSetupInCloudShellReturnsWifConfig(t *testing.T) {
	dir := shellStubDir(t)
	readArgs := shellArgsFile(t)
	shellStub(t, dir, "gcloud", `printf '%s\n' "$@" > "$ALETHIA_STUB_ARGS"
echo 'noise before'
echo '--- START CONFIG (copy everything below) ---'
echo '{"type":"external_account"}'
echo '--- END CONFIG ---'`)

	script := "echo hello-gcp"
	wif, err := RunGcpSetupInCloudShell(script, "my-project")
	if err != nil {
		t.Fatalf("RunGcpSetupInCloudShell() error = %v", err)
	}
	if wif != `{"type":"external_account"}` {
		t.Errorf("wif = %q", wif)
	}

	argv := readArgs()
	for _, want := range []string{
		"cloud-shell", "ssh", "--authorize-session",
		base64.StdEncoding.EncodeToString([]byte(script)),
		"'my-project'",
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("gcloud argv %q missing %q", argv, want)
		}
	}
}

// TestShell_RunGcpSetupInCloudShellFailures pins the two failure modes: the
// remote command exiting non-zero, and output with no CONFIG block.
func TestShell_RunGcpSetupInCloudShellFailures(t *testing.T) {
	tests := []struct {
		name    string
		stub    string
		wantErr string
	}{
		{name: "command fails", stub: `echo 'reauth required' >&2; exit 1`, wantErr: "cloud shell command failed"},
		{name: "no config block", stub: `echo 'all done'`, wantErr: "could not find WIF config"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := shellStubDir(t)
			shellStub(t, dir, "gcloud", tt.stub)

			wif, err := RunGcpSetupInCloudShell("echo hi", "p")
			if err == nil {
				t.Fatalf("RunGcpSetupInCloudShell() = %q, want error", wif)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// TestShell_RunAlibabaSetupReturnsRoleArn pins that the issuer URL reaches the
// installer as $1 and that role_arn is read out of the CONFIG block.
func TestShell_RunAlibabaSetupReturnsRoleArn(t *testing.T) {
	readArgs := shellArgsFile(t)
	script := shellMarkerScript(`echo 'role_arn=acs:ram::123456789:role/alethia'`)

	arn, err := RunAlibabaSetup(script, "https://issuer.example")
	if err != nil {
		t.Fatalf("RunAlibabaSetup() error = %v", err)
	}
	if arn != "acs:ram::123456789:role/alethia" {
		t.Errorf("roleArn = %q", arn)
	}
	if got := readArgs(); got != "https://issuer.example" {
		t.Errorf("installer $1 = %q, want the issuer URL", got)
	}
}

// TestShell_RunAlibabaSetupFailures pins a failing installer, output with no
// CONFIG block, and a CONFIG block that omits role_arn.
func TestShell_RunAlibabaSetupFailures(t *testing.T) {
	tests := []struct {
		name    string
		script  string
		wantErr string
	}{
		{name: "installer fails", script: `echo 'boom' >&2; exit 3`, wantErr: "alibaba setup failed"},
		{name: "no config block", script: `echo 'done'`, wantErr: "could not find config"},
		{name: "no role arn", script: shellMarkerScript(`echo 'account_id=123'`), wantErr: "did not return a role ARN"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			shellArgsFile(t)
			arn, err := RunAlibabaSetup(tt.script, "https://issuer.example")
			if err == nil {
				t.Fatalf("RunAlibabaSetup() = %q, want error", arn)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// TestShell_RunAwsSetupScriptReturnsRoleArn pins the keyless AWS installer path:
// issuer URL in as $1, role_arn out of the CONFIG block.
func TestShell_RunAwsSetupScriptReturnsRoleArn(t *testing.T) {
	readArgs := shellArgsFile(t)
	script := shellMarkerScript(`echo 'role_arn=arn:aws:iam::123456789012:role/alethia'`)

	arn, err := RunAwsSetupScript(script, "https://issuer.example")
	if err != nil {
		t.Fatalf("RunAwsSetupScript() error = %v", err)
	}
	if arn != "arn:aws:iam::123456789012:role/alethia" {
		t.Errorf("roleArn = %q", arn)
	}
	if got := readArgs(); got != "https://issuer.example" {
		t.Errorf("installer $1 = %q, want the issuer URL", got)
	}
}

// TestShell_RunAwsSetupScriptFailures pins the three AWS installer failure modes.
func TestShell_RunAwsSetupScriptFailures(t *testing.T) {
	tests := []struct {
		name    string
		script  string
		wantErr string
	}{
		{name: "installer fails", script: `echo 'denied' >&2; exit 2`, wantErr: "aws setup failed"},
		{name: "no config block", script: `echo 'done'`, wantErr: "could not find config"},
		{name: "no role arn", script: shellMarkerScript(`echo 'region=eu-central-1'`), wantErr: "did not return a role ARN"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			shellArgsFile(t)
			arn, err := RunAwsSetupScript(tt.script, "https://issuer.example")
			if err == nil {
				t.Fatalf("RunAwsSetupScript() = %q, want error", arn)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// TestShell_RunAzureSetupReturnsFederatedIDs pins that the subscription id is
// passed to the installer and all three federated identity values are captured.
func TestShell_RunAzureSetupReturnsFederatedIDs(t *testing.T) {
	readArgs := shellArgsFile(t)
	script := shellMarkerScript("echo 'tenant_id=tenant-1'\necho 'client_id=client-2'\necho 'subscription_id=sub-3'")

	ids, err := RunAzureSetup(script, "sub-3")
	if err != nil {
		t.Fatalf("RunAzureSetup() error = %v", err)
	}
	want := AzureIDs{TenantID: "tenant-1", ClientID: "client-2", SubscriptionID: "sub-3"}
	if *ids != want {
		t.Errorf("ids = %+v, want %+v", *ids, want)
	}
	if got := readArgs(); got != "sub-3" {
		t.Errorf("installer $1 = %q, want the subscription id", got)
	}
}

// TestShell_RunAzureSetupFailures pins a failing installer, a missing CONFIG
// block, and a partial CONFIG block that omits client_id/subscription_id.
func TestShell_RunAzureSetupFailures(t *testing.T) {
	tests := []struct {
		name    string
		script  string
		wantErr string
	}{
		{name: "installer fails", script: `echo 'no subscription' >&2; exit 1`, wantErr: "azure setup failed"},
		{name: "no config block", script: `echo 'done'`, wantErr: "could not find config"},
		{name: "partial ids", script: shellMarkerScript(`echo 'tenant_id=tenant-1'`), wantErr: "did not return all required IDs"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			shellArgsFile(t)
			ids, err := RunAzureSetup(tt.script, "sub-3")
			if err == nil {
				t.Fatalf("RunAzureSetup() = %+v, want error", ids)
			}
			if ids != nil {
				t.Errorf("ids = %+v, want nil alongside the error", ids)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// awsBootstrapStub is a fake `aws` that records its argv, accepts the deploy and
// answers describe-stacks with a role ARN.
const awsBootstrapStub = `printf '%s\n' "$@" >> "$ALETHIA_STUB_ARGS"
case "$2" in
deploy) echo 'Successfully created/updated stack' ;;
describe-stacks) echo 'arn:aws:iam::123456789012:role/alethia' ;;
*) echo "unexpected subcommand $2" >&2 ; exit 9 ;;
esac`

// TestShell_RunAwsBootstrapDeploysAndReadsRoleArn pins the CloudFormation path:
// the template is deployed with named-IAM capabilities and the issuer/role-name
// parameter overrides, and --region is only passed when a region was given.
func TestShell_RunAwsBootstrapDeploysAndReadsRoleArn(t *testing.T) {
	tests := []struct {
		name       string
		region     string
		wantRegion bool
	}{
		{name: "with region", region: "eu-central-1", wantRegion: true},
		{name: "without region", region: "", wantRegion: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := shellStubDir(t)
			readArgs := shellArgsFile(t)
			shellStub(t, dir, "aws", awsBootstrapStub)

			arn, err := RunAwsBootstrap("Resources: {}", "https://issuer.example", tt.region, "AlethiaRole", "alethia-stack")
			if err != nil {
				t.Fatalf("RunAwsBootstrap() error = %v", err)
			}
			if arn != "arn:aws:iam::123456789012:role/alethia" {
				t.Errorf("roleArn = %q", arn)
			}

			argv := readArgs()
			for _, want := range []string{
				"cloudformation", "deploy", "describe-stacks",
				"--stack-name", "alethia-stack",
				"CAPABILITY_NAMED_IAM",
				"IssuerUrl=https://issuer.example",
				"RoleName=AlethiaRole",
			} {
				if !strings.Contains(argv, want) {
					t.Errorf("aws argv %q missing %q", argv, want)
				}
			}
			if got := strings.Contains(argv, "--region"); got != tt.wantRegion {
				t.Errorf("argv contains --region = %v, want %v (argv %q)", got, tt.wantRegion, argv)
			}
		})
	}
}

// TestShell_RunAwsBootstrapFailures pins a failing deploy, a describe-stacks
// that errors with a message on stderr, and a stack with no RoleArn output.
func TestShell_RunAwsBootstrapFailures(t *testing.T) {
	tests := []struct {
		name    string
		stub    string
		wantErr string
	}{
		{
			name:    "deploy fails",
			stub:    `echo 'insufficient permissions' >&2; exit 1`,
			wantErr: "cloudformation deploy failed",
		},
		{
			name: "describe stacks fails",
			stub: `case "$2" in
deploy) echo ok ;;
*) echo 'stack does not exist' >&2 ; exit 254 ;;
esac`,
			wantErr: "failed to read stack outputs",
		},
		{
			name: "no role arn output",
			stub: `case "$2" in
deploy) echo ok ;;
*) : ;;
esac`,
			wantErr: "stack did not produce a RoleArn output",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := shellStubDir(t)
			shellStub(t, dir, "aws", tt.stub)

			arn, err := RunAwsBootstrap("Resources: {}", "https://issuer.example", "", "AlethiaRole", "alethia-stack")
			if err == nil {
				t.Fatalf("RunAwsBootstrap() = %q, want error", arn)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// TestShell_RunAwsBootstrapSurfacesStderrFromQuery pins that runCapture reports
// the tool's stderr rather than the bare "exit status N".
func TestShell_RunAwsBootstrapSurfacesStderrFromQuery(t *testing.T) {
	dir := shellStubDir(t)
	shellStub(t, dir, "aws", `case "$2" in
deploy) echo ok ;;
*) echo 'ValidationError: Stack with id alethia-stack does not exist' >&2 ; exit 254 ;;
esac`)

	if _, err := RunAwsBootstrap("Resources: {}", "https://i", "", "R", "alethia-stack"); err == nil {
		t.Fatal("RunAwsBootstrap() = nil error, want one")
	} else if !strings.Contains(err.Error(), "ValidationError") {
		t.Errorf("error = %v, want the CLI's stderr text", err)
	}
}

// TestShell_WriteTempCreatesFileAndCleansUp pins that writeTemp materialises the
// content on disk and that the returned cleanup removes the file.
func TestShell_WriteTempCreatesFileAndCleansUp(t *testing.T) {
	path, cleanup, err := writeTemp("alethia-shell-cov-*.sh", "echo hi\n")
	if err != nil {
		t.Fatalf("writeTemp() error = %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read temp file: %v", err)
	}
	if string(got) != "echo hi\n" {
		t.Errorf("temp file contents = %q", got)
	}

	cleanup()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("after cleanup, stat error = %v, want ErrNotExist", err)
	}
}

// TestShell_SetupsFailWhenTempFileCannotBeCreated pins that every installer
// entry point propagates a temp-file creation failure instead of shelling out.
func TestShell_SetupsFailWhenTempFileCannotBeCreated(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "no-such-dir"))

	if _, _, err := writeTemp("alethia-shell-cov-*.sh", "body"); err == nil {
		t.Error("writeTemp() = nil error, want one")
	}
	if _, err := RunAlibabaSetup("echo hi", "https://i"); err == nil {
		t.Error("RunAlibabaSetup() = nil error, want one")
	}
	if _, err := RunAwsBootstrap("Resources: {}", "https://i", "", "R", "S"); err == nil {
		t.Error("RunAwsBootstrap() = nil error, want one")
	}
	if _, err := RunAwsSetupScript("echo hi", "https://i"); err == nil {
		t.Error("RunAwsSetupScript() = nil error, want one")
	}
	if _, err := RunAzureSetup("echo hi", "sub"); err == nil {
		t.Error("RunAzureSetup() = nil error, want one")
	}
}

// TestShell_RunStreamingEnvAppendsExtraVariables pins that extra KEY=VALUE pairs
// are added on top of the inherited environment and that the child's combined
// output is returned to the caller.
func TestShell_RunStreamingEnvAppendsExtraVariables(t *testing.T) {
	dir := shellStubDir(t)
	shellStub(t, dir, "alethia-envprobe", `echo "value=$ALETHIA_STUB_VALUE"
echo "path-inherited=$ALETHIA_STUB_INHERITED"
echo 'on-stderr' >&2`)
	t.Setenv("ALETHIA_STUB_INHERITED", "yes")

	out, err := runStreamingEnv([]string{"ALETHIA_STUB_VALUE=marker"}, "alethia-envprobe")
	if err != nil {
		t.Fatalf("runStreamingEnv() error = %v", err)
	}
	for _, want := range []string{"value=marker", "path-inherited=yes", "on-stderr"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q missing %q", out, want)
		}
	}
}

// TestShell_RunStreamingReportsChildFailure pins that a non-zero child is
// reported as an error while its output is still returned.
func TestShell_RunStreamingReportsChildFailure(t *testing.T) {
	dir := shellStubDir(t)
	shellStub(t, dir, "alethia-failprobe", `echo 'partial output'; exit 7`)

	out, err := runStreaming("alethia-failprobe")
	if err == nil {
		t.Fatal("runStreaming() = nil error, want one")
	}
	if !strings.Contains(out, "partial output") {
		t.Errorf("output %q lost the child's writes", out)
	}
}
