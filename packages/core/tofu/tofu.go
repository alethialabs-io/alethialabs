// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
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
	"strings"
	"time"

	"github.com/hashicorp/terraform-exec/tfexec"
	tfjson "github.com/hashicorp/terraform-json"
)

// DefaultIaCVersion is the OpenTofu version the runner provisions with when a Spec
// snapshot doesn't pin one. OpenTofu (MPL-2.0) replaces Terraform (BUSL); it is
// state- and CLI-compatible with the Terraform 1.6 line, so terraform-exec drives
// it unchanged.
const DefaultIaCVersion = "1.9.0"

type TofuCLI struct {
	tf      *tfexec.Terraform
	version string
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

	if stdout != nil {
		tf.SetStdout(stdout)
	} else {
		tf.SetStdout(os.Stdout)
	}
	if stderr != nil {
		tf.SetStderr(stderr)
	} else {
		tf.SetStderr(os.Stderr)
	}

	return &TofuCLI{tf: tf, version: tfVersion}, nil
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

func (t *TofuCLI) Output(ctx context.Context) (map[string]interface{}, error) {
	fmt.Println("Getting OpenTofu outputs...")
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

	if err := os.WriteFile(tfvarsPath, append(tfvarsData, '\n'), 0644); err != nil {
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
	if path, err := exec.LookPath("tofu"); err == nil {
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

func httpGet(ctx context.Context, url string) ([]byte, error) {
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
