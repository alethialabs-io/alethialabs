// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tofu

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/terraform-exec/tfexec"
	tfjson "github.com/hashicorp/terraform-json"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

var (
	lookPath = exec.LookPath
	httpGet  = defaultHTTPGet
)

// DefaultIaCVersion is the OpenTofu version the runner provisions with when a project
// snapshot doesn't pin one. OpenTofu (MPL-2.0) replaces Terraform (BUSL); it is
// state- and CLI-compatible with the Terraform 1.6 line, so terraform-exec drives
// it unchanged.
const DefaultIaCVersion = "1.9.0"

// IaCVersionEnv overrides DefaultIaCVersion for the runner-lifecycle provisioning path — deploy /
// destroy of the runner infra ITSELF, which carries no project snapshot to pin a version. Project
// deploys pin the version via ProjectConfig.IacVersion; this env is the single knob for the
// runner-own path, so deploy and destroy always resolve the SAME version (a divergence writes state
// with one OpenTofu and tears it down with another).
const IaCVersionEnv = "ALETHIA_IAC_VERSION"

// ResolvedIaCVersion returns the OpenTofu version to provision the runner's own infra with:
// ALETHIA_IAC_VERSION when set, else DefaultIaCVersion. Never returns a hardcoded per-call literal.
func ResolvedIaCVersion() string {
	if v := strings.TrimSpace(os.Getenv(IaCVersionEnv)); v != "" {
		return v
	}
	return DefaultIaCVersion
}

// DefaultCancelGracePeriod is the grace window between the graceful SIGINT and the
// hard SIGKILL when a running tofu command's context is cancelled (a mid-flight job
// cancel). terraform-exec sends SIGINT to the `tofu` child the instant ctx is done
// (its cmd.Cancel = Signal(os.Interrupt)); WaitDelay bounds how long the stdlib then
// waits before force-killing the child. tofu traps the FIRST SIGINT and finishes the
// in-flight resource, writes state, and releases the lock — a clean stop — so this
// window must be long enough to let a single resource's cloud API call complete
// (killing mid-resource is what orphans infra + strands the state lock). Tunable via
// ALETHIA_CANCEL_GRACE_SECONDS. Default is deliberately generous: 0 (WaitDelay unset)
// would wait forever, a too-short window truncates the graceful stop into an orphan.
const DefaultCancelGracePeriod = 120 * time.Second

// cancelGracePeriod resolves the SIGINT→SIGKILL grace window from
// ALETHIA_CANCEL_GRACE_SECONDS, falling back to DefaultCancelGracePeriod. A value of 0
// is honored (immediate SIGKILL after SIGINT — pre-apply stages only, never a real apply).
func cancelGracePeriod() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CANCEL_GRACE_SECONDS")); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return DefaultCancelGracePeriod
}

type TofuCLI struct {
	tf      *tfexec.Terraform
	version string
	// stdout is the configured lifecycle log writer (plan/apply/destroy stream here).
	// Output() temporarily redirects the tofu process off this writer to io.Discard so
	// un-redacted `output -json` values (kubeconfig, talosconfig, DB passwords, tokens)
	// never reach the job log, then restores it. See Output() for the leak details.
	stdout io.Writer
}

func NewTofuCLI(ctx context.Context, tfVersion, workDir string, stdout, stderr io.Writer) (*TofuCLI, error) {
	if tfVersion == "" {
		tfVersion = DefaultIaCVersion
	}
	execPath, err := ensureBinary(ctx, tfVersion)
	if err != nil {
		return nil, fmt.Errorf("failed to ensure OpenTofu binary: %w", err)
	}

	ensurePluginCache()

	tf, err := tfexec.NewTerraform(workDir, execPath)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize OpenTofu: %w", err)
	}

	resolvedStdout := stdout
	if resolvedStdout == nil {
		resolvedStdout = os.Stdout
	}
	tf.SetStdout(resolvedStdout)
	if stderr != nil {
		tf.SetStderr(stderr)
	} else {
		tf.SetStderr(os.Stderr)
	}

	// Stage-aware graceful cancellation. terraform-exec always SIGINTs the `tofu`
	// child when ctx is cancelled; setting WaitDelay makes the stdlib escalate to
	// SIGKILL only after the grace window, so a mid-apply cancel lets tofu finish the
	// in-flight resource, persist state, and release the state lock before dying.
	// (SetWaitDelay only errors on Windows, where graceful cancel is unsupported — the
	// runner is Linux/macOS, so the error is intentionally ignored.)
	_ = tf.SetWaitDelay(cancelGracePeriod())

	return &TofuCLI{tf: tf, version: tfVersion, stdout: resolvedStdout}, nil
}

func (t *TofuCLI) Init(ctx context.Context, backendConfig map[string]string, upgrade bool) error {
	fmt.Println("Initializing OpenTofu...")
	opts := []tfexec.InitOption{tfexec.Reconfigure(true)}
	for k, v := range backendConfig {
		opts = append(opts, tfexec.BackendConfig(k+"="+v))
	}
	if upgrade {
		opts = append(opts, tfexec.Upgrade(true))
	}
	return t.tf.Init(ctx, opts...)
}

// InitNoBackend runs `tofu init -backend=false`: it installs the module's required
// providers and any LOCAL child modules WITHOUT configuring or authenticating to a state
// backend. Used by the bring-your-own-IaC scan so `tofu validate` can resolve provider
// schemas without touching remote state. It still fetches provider plugins, so it needs
// network egress (unlike a purely local render).
func (t *TofuCLI) InitNoBackend(ctx context.Context) error {
	fmt.Println("Initializing OpenTofu (no backend)...")
	return t.tf.Init(ctx, tfexec.Reconfigure(true), tfexec.Backend(false))
}

// Validate runs `tofu validate` over the initialized module and returns the structured
// result (Valid + Diagnostics). It checks configuration consistency (types, references,
// provider schema) and mutates nothing.
func (t *TofuCLI) Validate(ctx context.Context) (*tfjson.ValidateOutput, error) {
	fmt.Println("Validating OpenTofu configuration...")
	return t.tf.Validate(ctx)
}

// InitWithBackendFile runs tofu init using a backend config file (e.g. backend.hcl).
func (t *TofuCLI) InitWithBackendFile(ctx context.Context, backendFile string, upgrade bool) error {
	fmt.Println("Initializing OpenTofu...")
	opts := []tfexec.InitOption{
		tfexec.Reconfigure(true),
		tfexec.BackendConfig(backendFile),
	}
	if upgrade {
		opts = append(opts, tfexec.Upgrade(true))
	}
	return t.tf.Init(ctx, opts...)
}

func (t *TofuCLI) Plan(ctx context.Context, varFile, planOutFile string) (bool, error) {
	fmt.Println("Running OpenTofu plan...")
	opts := []tfexec.PlanOption{
		tfexec.Out(planOutFile),
	}
	if varFile != "" {
		opts = append(opts, tfexec.VarFile(varFile))
	}
	return t.tf.Plan(ctx, opts...)
}

// PlanRefreshOnly runs `tofu plan -refresh-only` — it reconciles state with the
// live cloud and reports drift WITHOUT proposing config changes, isolating true
// drift from pending changes. Used by DETECT_DRIFT jobs to compute drift posture.
func (t *TofuCLI) PlanRefreshOnly(ctx context.Context, varFile, planOutFile string) (bool, error) {
	fmt.Println("Running OpenTofu plan (refresh-only)...")
	opts := []tfexec.PlanOption{
		tfexec.Out(planOutFile),
		tfexec.RefreshOnly(true),
	}
	if varFile != "" {
		opts = append(opts, tfexec.VarFile(varFile))
	}
	return t.tf.Plan(ctx, opts...)
}

func (t *TofuCLI) Apply(ctx context.Context, planFile string) error {
	fmt.Println("Applying OpenTofu plan...")
	return t.tf.Apply(ctx, tfexec.DirOrPlan(planFile))
}

func (t *TofuCLI) Destroy(ctx context.Context, varFile string) error {
	fmt.Println("Running OpenTofu destroy...")
	var opts []tfexec.DestroyOption
	if varFile != "" {
		opts = append(opts, tfexec.VarFile(varFile))
	}
	return t.tf.Destroy(ctx, opts...)
}

// Output runs `tofu output -json` and returns the parsed output map.
//
// SECURITY (follow-up to B2.2 #457): `tofu output -json` emits every output value —
// including SENSITIVE ones (kubeconfig, talosconfig, RDS/DB passwords, cloud tokens) —
// UN-redacted. terraform-exec's runTerraformCmdJSON tees the child process's stdout into
// BOTH an internal parse buffer AND the configured cmd.Stdout (mergeWriters), so whatever
// lifecycle writer this CLI was built with (in deploy/drift that is the job-log stream)
// would receive the raw secrets. Redirect ONLY this subcommand to io.Discard and restore
// the lifecycle writer afterwards: the values still reach the caller via the returned map
// (decoded from the internal buffer), but they NEVER hit the log / execution_metadata.
// A single TofuCLI is used serially within one job, so swapping the writer here is safe.
func (t *TofuCLI) Output(ctx context.Context) (map[string]interface{}, error) {
	fmt.Println("Getting OpenTofu outputs...")
	t.tf.SetStdout(io.Discard)
	defer t.tf.SetStdout(t.stdout)

	outputMap, err := t.tf.Output(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get OpenTofu output: %w", err)
	}

	outputs := make(map[string]interface{})
	for k, v := range outputMap {
		var val interface{}
		if err := json.Unmarshal(v.Value, &val); err != nil {
			outputs[k] = string(v.Value)
		} else {
			outputs[k] = val
		}
	}
	return outputs, nil
}

func (t *TofuCLI) ShowPlanJSON(ctx context.Context, planFile string) (*tfjson.Plan, error) {
	fmt.Println("Generating plan JSON...")
	return t.tf.ShowPlanFile(ctx, planFile)
}

func OverrideTfvarsFromMap(dir string, tfvars map[string]interface{}) (string, error) {
	tfvarsPath := filepath.Join(dir, "tofu.tfvars.json")

	tfvarsData, err := json.MarshalIndent(tfvars, "", "  ")
	if err != nil {
		return "", fmt.Errorf("failed to encode tfvars: %w", err)
	}

	// tfvars can carry decrypted connector secrets + the runner token (categories.Compose merges
	// them in) — write owner-only so a co-located uid on a shared runner host can't read them.
	if err := utils.WriteSecretFile(tfvarsPath, append(tfvarsData, '\n')); err != nil {
		return "", fmt.Errorf("failed to write tfvars file: %w", err)
	}

	return tfvarsPath, nil
}

// ensurePluginCache makes OpenTofu reuse a shared provider-plugin cache instead of
// re-downloading providers on every `init` (the dominant job-start cost). It honors an
// existing TF_PLUGIN_CACHE_DIR — e.g. the cache pre-populated into the runner image —
// and otherwise defaults to ~/.alethia/plugin-cache so self-host/local runs warm on the
// first job. The directory must exist or OpenTofu silently skips the cache, so we
// MkdirAll it. It is published via the process environment (NOT tfexec.SetEnv): the child
// `tofu` inherits os.Environ() at exec time, and deploy.go suspends/restores AWS creds in
// os.Environ around init — pinning the env via SetEnv would break that.
func ensurePluginCache() {
	dir := os.Getenv("TF_PLUGIN_CACHE_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return // best-effort: no cache; init still works, just slower
		}
		dir = filepath.Join(home, ".alethia", "plugin-cache")
		_ = os.Setenv("TF_PLUGIN_CACHE_DIR", dir)
	}
	_ = os.MkdirAll(dir, 0o755)
}

// ensureBinary returns a path to a `tofu` binary at the requested version,
// preferring one already on PATH (e.g. baked into the runner image), then a
// cached download, then fetching + SHA256-verifying the release from the OpenTofu
// GitHub releases.
func ensureBinary(ctx context.Context, tfVersion string) (string, error) {
	if path, err := lookPath("tofu"); err == nil {
		return path, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}

	installDir := filepath.Join(home, ".alethia", "bin")
	cachedPath := filepath.Join(installDir, fmt.Sprintf("tofu_%s", tfVersion))
	if _, err := os.Stat(cachedPath); err == nil {
		return cachedPath, nil
	}

	if err := os.MkdirAll(installDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create install directory: %w", err)
	}

	fmt.Printf("Downloading OpenTofu v%s...\n", tfVersion)
	if err := downloadTofu(ctx, tfVersion, cachedPath); err != nil {
		return "", err
	}
	fmt.Println("OpenTofu downloaded successfully.")
	return cachedPath, nil
}

// downloadTofu fetches the OpenTofu release zip for the current OS/arch, verifies
// its SHA256 against the release SHA256SUMS, extracts the `tofu` binary, and
// writes it to dst (0755). (Cosign verification of the SUMS is a future hardening;
// the SUMS are fetched over HTTPS from the OpenTofu releases.)
func downloadTofu(ctx context.Context, ver, dst string) error {
	asset := fmt.Sprintf("tofu_%s_%s_%s.zip", ver, runtime.GOOS, runtime.GOARCH)
	base := fmt.Sprintf("https://github.com/opentofu/opentofu/releases/download/v%s", ver)

	zipBytes, err := httpGet(ctx, base+"/"+asset)
	if err != nil {
		return fmt.Errorf("failed to download %s: %w", asset, err)
	}

	sums, err := httpGet(ctx, fmt.Sprintf("%s/tofu_%s_SHA256SUMS", base, ver))
	if err != nil {
		return fmt.Errorf("failed to download SHA256SUMS: %w", err)
	}
	want, err := sha256For(string(sums), asset)
	if err != nil {
		return err
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(zipBytes)); got != want {
		return fmt.Errorf("checksum mismatch for %s: got %s, want %s", asset, got, want)
	}

	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return fmt.Errorf("failed to open release zip: %w", err)
	}
	for _, f := range zr.File {
		if filepath.Base(f.Name) != "tofu" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, rc)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		return os.Chmod(dst, 0o755)
	}
	return fmt.Errorf("`tofu` binary not found in %s", asset)
}

func defaultHTTPGet(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s: status %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// sha256For returns the checksum for asset from a SHA256SUMS body (lines of
// "<hex>  <filename>").
func sha256For(sums, asset string) (string, error) {
	for _, line := range strings.Split(sums, "\n") {
		if fields := strings.Fields(line); len(fields) == 2 && fields[1] == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("no checksum for %s in SHA256SUMS", asset)
}

// ── Orphan reconciliation primitives (issue #526) ────────────────────────────────────────────
//
// A FAILED apply can leave a real cloud resource OUTSIDE tofu state: the cloud accepts the create,
// then fails it asynchronously (capacity/quota/policy), so tofu's create errors and never records
// it. The environment is then PERMANENTLY WEDGED — every later apply dies with
//
//	a resource with the ID "…" already exists - to be managed via Terraform this resource needs to
//	be imported into the State
//
// The provider names the remedy itself: IMPORT. Import is also the only remedy that is SAFE on a
// live environment — a delete/force-destroy could take out a resource a customer depends on, and
// the existing break-glass `orphan_clean` action (a cross-cloud force-destroy, shipped inert) is
// the wrong shape for this entirely: it targets leftovers of an env that is already GONE.
//
// These are the primitives the STATE_SURGERY repair needs; the wrapper had neither.

// Import brings an existing cloud resource under tofu management: `tofu import <address> <id>`.
//
// Both halves of the pair come straight out of the failed apply — provisioner.ClassifyApplyError
// parses the address and the cloud ID from the provider's own error. After a successful import the
// environment is UNWEDGED: the next plan/apply sees the resource in state and can update, replace
// or destroy it normally.
//
// Callers must hold the tofu state lock (STATE_SURGERY jobs flow through claim_next_job → the
// state lock/backend, so fencing is intact).
func (t *TofuCLI) Import(ctx context.Context, address, id string) error {
	if strings.TrimSpace(address) == "" || strings.TrimSpace(id) == "" {
		return fmt.Errorf("import requires both a resource address and a cloud id (got address=%q id=%q)", address, id)
	}
	fmt.Printf("Importing %s (cloud id %s) into tofu state...\n", address, id)
	return t.tf.Import(ctx, address, id)
}

// StateResources returns every resource ADDRESS currently tracked in tofu state.
//
// This is the "what do we manage?" half of an orphan diff: anything the cloud reports under the
// run's sweep handle (alethia:project-id / alethia_project-id, stamped on every resource by
// classification_tags) that does NOT appear here is unmanaged — i.e. an orphan. It is also how a
// STATE_SURGERY import is verified: the imported address must appear afterwards.
//
// packages/core/drift cannot answer this question — a refresh-only plan is blind to resources that
// are not in state (Unmanaged=0, UnmanagedKnown=false), which is precisely why the wedge went
// undetected.
func (t *TofuCLI) StateResources(ctx context.Context) ([]string, error) {
	state, err := t.tf.Show(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading tofu state: %w", err)
	}
	if state == nil || state.Values == nil || state.Values.RootModule == nil {
		return nil, nil // no state yet — nothing is managed.
	}

	var addrs []string
	var walk func(m *tfjson.StateModule)
	walk = func(m *tfjson.StateModule) {
		if m == nil {
			return
		}
		for _, r := range m.Resources {
			addrs = append(addrs, r.Address)
		}
		for _, child := range m.ChildModules {
			walk(child)
		}
	}
	walk(state.Values.RootModule)
	return addrs, nil
}
