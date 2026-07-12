// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package sandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Container runs a job's untrusted work in a fresh per-job container by re-exec'ing
// the runner binary (ALETHIA_RUNNER_EXEC_STAGE=1) inside `<runtime> run`. The child
// gets ONLY an allowlisted environment (never the parent's ALETHIA_RUNNER_TOKEN /
// ALETHIA_STORAGE_* / bootstrap / receipt-signing key), a separate PID namespace (so
// it cannot read the parent's /proc), and — on the managed fleet — a default-deny
// egress net (so it cannot reach 169.254.169.254 metadata, which serves the VM's
// cloud-init incl. the storage master key + bootstrap token).
//
// It is fail-closed: it refuses to run untrusted work on an operator=managed runner
// unless egress enforcement is confirmed (ALETHIA_SANDBOX_EGRESS_ENFORCED=1), and the
// pre-exec assertNoSecrets guard aborts if any denylisted secret would reach the child.
type Container struct {
	// Runtime is the container CLI: "docker" (local dev) or "podman" (fleet).
	Runtime string
	// Image is the container image; defaults to this runner's own image ref so the
	// baked tofu/helm/templates/plugin-cache/exec-plugins are present.
	Image string
	// Operator is the runner operator ("managed" | "self").
	Operator string
	// EgressEnforced reports that the runtime constrains egress (default-deny + IMDS
	// block). The managed fail-closed gate requires it; local/self dev does not.
	EgressEnforced bool
	// Network is the --network value (e.g. an egress-filtered net name on the fleet, or
	// "none" for a no-egress stage). Empty uses the runtime default.
	Network   string
	PidsLimit int
	MemLimit  string // e.g. "2g"
}

var _ Sandbox = Container{}

// NewContainerFromEnv builds a Container from ALETHIA_SANDBOX_* env, defaulting the
// image to the runner's own image ref (ALETHIA_SANDBOX_IMAGE, else ALETHIA_RUNNER_IMAGE).
func NewContainerFromEnv(operator string) (Container, error) {
	runtime := strings.TrimSpace(os.Getenv("ALETHIA_SANDBOX_RUNTIME"))
	if runtime == "" {
		runtime = "docker"
	}
	if _, err := exec.LookPath(runtime); err != nil {
		return Container{}, fmt.Errorf("sandbox runtime %q not found on PATH: %w", runtime, err)
	}
	image := strings.TrimSpace(os.Getenv("ALETHIA_SANDBOX_IMAGE"))
	if image == "" {
		image = strings.TrimSpace(os.Getenv("ALETHIA_RUNNER_IMAGE"))
	}
	c := Container{
		Runtime:        runtime,
		Image:          image,
		Operator:       operator,
		EgressEnforced: envTrue("ALETHIA_SANDBOX_EGRESS_ENFORCED"),
		Network:        strings.TrimSpace(os.Getenv("ALETHIA_SANDBOX_NETWORK")),
		PidsLimit:      512,
		MemLimit:       envOr("ALETHIA_SANDBOX_MEMORY", "2g"),
	}
	if c.Image == "" {
		return Container{}, fmt.Errorf("sandbox image is required (set ALETHIA_SANDBOX_IMAGE)")
	}
	return c, nil
}

// Run executes the stage in a fresh container. The closure `job` is NOT called (that
// is the Passthrough path); the container backend reconstructs the identical work from
// spec.Stage in the re-exec'd child. The parent reads result.json from spec.WorkDir.
func (c Container) Run(ctx context.Context, spec Spec, _ Job) error {
	if spec.Stage == nil {
		return fmt.Errorf("container sandbox: spec.Stage is required (refusing to run without a serialized stage)")
	}
	if spec.WorkDir == "" {
		return fmt.Errorf("container sandbox: spec.WorkDir is required")
	}

	// Fail-closed managed egress gate: on a managed runner untrusted code must not run
	// without confirmed egress control — otherwise it curls the metadata service and
	// recovers the fleet's storage key + bootstrap token. A no-egress stage (chart_scan)
	// is exempt because it gets --network none.
	if c.Operator == "managed" && !spec.NoEgress && !c.EgressEnforced {
		return fmt.Errorf(
			"container sandbox: refusing to run %q job %s on a managed runner without egress enforcement "+
				"(set ALETHIA_SANDBOX_EGRESS_ENFORCED=1 once the default-deny egress net is wired)",
			spec.Kind, spec.JobID)
	}

	stageBytes, err := json.Marshal(spec.Stage)
	if err != nil {
		return fmt.Errorf("container sandbox: marshal stage: %w", err)
	}
	if err := os.WriteFile(filepath.Join(spec.WorkDir, "stage.json"), stageBytes, 0o600); err != nil {
		return fmt.Errorf("container sandbox: write stage.json: %w", err)
	}

	childEnv := buildChildEnv(os.Environ(), spec.WorkDir)
	if err := assertNoSecrets(childEnv); err != nil {
		return fmt.Errorf("container sandbox: %w", err)
	}

	args := c.buildArgs(spec, childEnv)

	cmd := exec.CommandContext(ctx, c.Runtime, args...)
	cmd.Stdout = spec.Stdout
	cmd.Stderr = spec.Stderr
	// New process group so a ctx cancel signals the runtime CLI + its container-monitor
	// child as a group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Stage-aware graceful cancellation. On a mid-flight cancel we send SIGINT (not an
	// immediate SIGKILL) to the runtime-CLI process group and escalate to SIGKILL only
	// after a grace window. A foreground `docker|podman run` (with --init → tini as PID 1)
	// FORWARDS SIGINT to the container's main process, which is the re-exec'd runner child;
	// that child traps SIGINT (see RunExecStage) and cancels the ctx it passes to tofu, so
	// tofu finishes the in-flight resource, writes state, and releases the state lock before
	// exiting — a clean stop that avoids orphans + a stranded lock.
	//
	// CAVEAT (docker vs podman): podman runs the container as a direct child of the CLI, so
	// the group signal + forwarding stop it reliably. The docker CLI talks to a daemon, so
	// SIGKILLing the *client* does NOT stop the daemon-side container — only the forwarded
	// SIGINT/SIGTERM (delivered while the client is alive) reaches the workload. We therefore
	// signal INT first (forwarded) and only hard-kill the client after the grace window;
	// managed fleets should prefer podman (ALETHIA_SANDBOX_RUNTIME=podman) so a grace-exceeded
	// SIGKILL actually tears the container down rather than leaking it daemon-side.
	grace := cancelGracePeriod()
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			interruptThenKill(cmd.Process.Pid, grace, syscall.Kill)
		}
		return nil
	}
	// Backstop: if the runtime CLI itself ignores SIGINT/SIGKILL, WaitDelay bounds how long
	// Wait blocks after Cancel before the stdlib force-kills the direct child process.
	cmd.WaitDelay = grace + 5*time.Second

	runErr := cmd.Run()

	// The child writes result.json (with an Error field on stage failure). Surface its
	// error if present; otherwise fall back to the process exit error.
	if res, rerr := readStageError(spec.WorkDir); rerr == nil && res != "" {
		return fmt.Errorf("stage %q failed: %s", spec.Kind, res)
	}
	if runErr != nil {
		return fmt.Errorf("container sandbox: %s run failed: %w", c.Runtime, runErr)
	}
	return nil
}

// DefaultCancelGracePeriod is the SIGINT→SIGKILL grace window for a mid-flight cancel of
// the container-sandbox runtime CLI (mirrors tofu.DefaultCancelGracePeriod so the outer
// group signal and the inner tofu WaitDelay use the same budget). Tunable via
// ALETHIA_CANCEL_GRACE_SECONDS.
const DefaultCancelGracePeriod = 120 * time.Second

// cancelGracePeriod resolves the grace window from ALETHIA_CANCEL_GRACE_SECONDS, defaulting
// to DefaultCancelGracePeriod. A value of 0 means SIGKILL immediately after SIGINT.
func cancelGracePeriod() time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CANCEL_GRACE_SECONDS")); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return DefaultCancelGracePeriod
}

// interruptThenKill sends SIGINT to the process GROUP (negative pid) immediately and
// schedules a SIGKILL of the group after grace, giving a foreground container runtime time
// to forward the interrupt to its workload and shut down cleanly. `kill` is injected so the
// escalation sequence is unit-testable without spawning a real process. A SIGKILL to an
// already-exited group is a harmless ESRCH.
func interruptThenKill(pid int, grace time.Duration, kill func(pid int, sig syscall.Signal) error) {
	_ = kill(-pid, syscall.SIGINT)
	time.AfterFunc(grace, func() {
		_ = kill(-pid, syscall.SIGKILL)
	})
}

// containerName is the deterministic per-job container name (for observability + a
// reaper keyed on the job id).
func containerName(jobID string) string {
	id := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, jobID)
	return "alethia-stage-" + id
}

// buildArgs assembles the `<runtime> run …` argv: hardening flags, the RW workdir
// mount, RO cred-dir mounts (derived from the child env's file-path values, mounted at
// identical absolute paths so embedded paths resolve), one --env per allowlisted key,
// and the image. No positional command: the child detects its mode via the env.
func (c Container) buildArgs(spec Spec, childEnv []string) []string {
	args := []string{
		"run", "--rm", "--init",
		"--name", containerName(spec.JobID),
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
	}
	if c.PidsLimit > 0 {
		args = append(args, "--pids-limit", fmt.Sprintf("%d", c.PidsLimit))
	}
	if c.MemLimit != "" {
		args = append(args, "--memory", c.MemLimit)
	}

	// Network: an explicit no-egress stage gets --network none; otherwise use the
	// configured (egress-filtered) net, or the runtime default.
	switch {
	case spec.NoEgress:
		args = append(args, "--network", "none")
	case c.Network != "":
		args = append(args, "--network", c.Network)
	}

	// RW: the per-job workdir at its identical absolute path (stage.json / result.json /
	// tofu workdir / child HOME all live under it).
	args = append(args, "-v", fmt.Sprintf("%s:%s:rw", spec.WorkDir, spec.WorkDir))

	// RO: the parent-activated cred dirs, at identical absolute paths. Mount DIRECTORIES
	// (not files) so the parent's atomic-rename token refresh is visible in the child.
	for _, dir := range credMountDirs(childEnv, spec.WorkDir) {
		args = append(args, "-v", fmt.Sprintf("%s:%s:ro", dir, dir))
	}

	for _, kv := range childEnv {
		args = append(args, "--env", kv)
	}

	args = append(args, c.Image)
	return args
}

// credAllowKeys is the exact set of NON-ALETHIA env vars allowed into the untrusted
// child: the cloud-auth vars the activators set (file paths + non-secret ids) plus the
// token-cloud provider tokens (secrets, but required by the tofu provider) and a minimal
// toolchain. Everything else is dropped; ALETHIA_* is denied except the explicit stage
// keys injected in buildChildEnv.
var credAllowKeys = map[string]bool{
	// AWS (file-based OIDC profile; NO static AWS_ACCESS_KEY_ID/SECRET)
	"AWS_CONFIG_FILE": true, "AWS_PROFILE": true, "AWS_SDK_LOAD_CONFIG": true, "AWS_REGION": true,
	// GCP
	"GOOGLE_APPLICATION_CREDENTIALS": true, "GOOGLE_PROJECT": true, "GCLOUD_PROJECT": true, "CLOUDSDK_CORE_PROJECT": true,
	// Azure
	"ARM_USE_OIDC": true, "ARM_CLIENT_ID": true, "ARM_TENANT_ID": true, "ARM_SUBSCRIPTION_ID": true, "ARM_OIDC_TOKEN_FILE_PATH": true,
	"AZURE_CLIENT_ID": true, "AZURE_TENANT_ID": true, "AZURE_SUBSCRIPTION_ID": true, "AZURE_FEDERATED_TOKEN_FILE": true,
	// Alibaba
	"ALIBABA_CLOUD_ROLE_ARN": true, "ALIBABA_CLOUD_OIDC_PROVIDER_ARN": true, "ALIBABA_CLOUD_OIDC_TOKEN_FILE": true, "ALIBABA_CLOUD_ROLE_SESSION_NAME": true,
	// token clouds (secrets, but the tofu provider needs them)
	"HCLOUD_TOKEN": true, "DIGITALOCEAN_ACCESS_TOKEN": true, "DIGITALOCEAN_TOKEN": true, "CIVO_TOKEN": true,
	// egress forward-proxy (Step 3b: managed fleet default-deny netns + domain-allowlist
	// squid). The child routes ALL outbound through the proxy; every tool it runs (tofu
	// providers / helm / aws|gcloud|az|kubectl) honors these. NOT secrets. NO_PROXY is kept
	// minimal by the fleet (localhost only — NEVER the 169.254.169.254 metadata IP, which
	// must not bypass the proxy; see hcloud.ts renderCloudInit). Both cases: net/http honors
	// lowercase, tofu/helm honor uppercase.
	"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true,
	"http_proxy": true, "https_proxy": true, "no_proxy": true,
	// toolchain / locale (NOT KUBECONFIG/TF_PLUGIN_CACHE_DIR/HOME — the child sets those
	// to writable per-job paths; TF_HTTP_* is injected explicitly below)
	"PATH": true, "LANG": true, "LC_ALL": true, "TZ": true,
}

// credFilePathKeys are allowlisted env vars whose VALUE is an absolute file path; the
// container RO-mounts each value's parent directory so the file (and its atomic-rename
// refreshes) resolve inside the child.
var credFilePathKeys = []string{
	"AWS_CONFIG_FILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ARM_OIDC_TOKEN_FILE_PATH",
	"AZURE_FEDERATED_TOKEN_FILE",
	"ALIBABA_CLOUD_OIDC_TOKEN_FILE",
}

// buildChildEnv projects the parent env down to the allowlist and injects the explicit
// stage env: the exec-stage trigger, the workdir, a writable HOME under the workdir, and
// the per-job secrets (git/state tokens) as ALETHIA_STAGE_* (the only ALETHIA_ vars that
// may cross). It reads the secret sources from the parent env keys the runner sets.
func buildChildEnv(parentEnv []string, workDir string) []string {
	get := func(key string) (string, bool) {
		p := key + "="
		for _, kv := range parentEnv {
			if strings.HasPrefix(kv, p) {
				return kv[len(p):], true
			}
		}
		return "", false
	}

	var out []string
	for k := range credAllowKeys {
		if v, ok := get(k); ok {
			out = append(out, k+"="+v)
		}
	}
	// State proxy auth (Step 2): scoped per-job, safe to cross.
	if v, ok := get("TF_HTTP_USERNAME"); ok {
		out = append(out, "TF_HTTP_USERNAME="+v)
	}
	if v, ok := get("TF_HTTP_PASSWORD"); ok {
		out = append(out, "TF_HTTP_PASSWORD="+v)
	}

	home := filepath.Join(workDir, "home")
	out = append(out,
		"ALETHIA_RUNNER_EXEC_STAGE=1",
		"ALETHIA_STAGE_WORKDIR="+workDir,
		"HOME="+home,
	)
	// Per-job secrets the runner staged for the child (git token for BYO repo cred; the
	// child sources them from these ALETHIA_STAGE_* keys).
	if v, ok := get("ALETHIA_STAGE_GIT_TOKEN"); ok {
		out = append(out, "ALETHIA_STAGE_GIT_TOKEN="+v)
	}
	sort.Strings(out)
	return out
}

// credMountDirs returns the deduped set of absolute directories to RO-bind-mount: the
// parent of every allowlisted file-path env value that is NOT already under the RW
// workdir mount.
func credMountDirs(childEnv []string, workDir string) []string {
	envMap := map[string]string{}
	for _, kv := range childEnv {
		if i := strings.IndexByte(kv, '='); i > 0 {
			envMap[kv[:i]] = kv[i+1:]
		}
	}
	seen := map[string]bool{}
	var dirs []string
	for _, k := range credFilePathKeys {
		v := envMap[k]
		if v == "" {
			continue
		}
		dir := filepath.Dir(v)
		if dir == "" || dir == "/" || dir == "." {
			continue
		}
		if strings.HasPrefix(dir+string(filepath.Separator), workDir+string(filepath.Separator)) || dir == workDir {
			continue // already covered by the RW workdir mount
		}
		if !seen[dir] {
			seen[dir] = true
			dirs = append(dirs, dir)
		}
	}
	sort.Strings(dirs)
	return dirs
}

// assertNoSecrets is the fail-closed guard: it refuses if any denylisted secret would
// reach the child. It runs on the FINAL child env, so a coding mistake that widens the
// allowlist is caught before the container starts.
func assertNoSecrets(childEnv []string) error {
	for _, kv := range childEnv {
		i := strings.IndexByte(kv, '=')
		if i <= 0 {
			continue
		}
		key := kv[:i]
		if isDeniedEnvKey(key) {
			return fmt.Errorf("denylisted secret %q must not reach the sandbox (fail-closed)", key)
		}
	}
	return nil
}

// isDeniedEnvKey reports whether an env key is a theft-target that must never enter the
// untrusted child. ALETHIA_* is denied wholesale (covers RUNNER_ID/TOKEN, BOOTSTRAP_TOKEN,
// STORAGE_*, RECEIPT_SIGNING_KEY) EXCEPT the two explicit stage keys; static AWS keys are
// denied so only the file-based OIDC profile is used.
func isDeniedEnvKey(key string) bool {
	if key == "ALETHIA_RUNNER_EXEC_STAGE" || strings.HasPrefix(key, "ALETHIA_STAGE_") {
		return false
	}
	if strings.HasPrefix(key, "ALETHIA_") {
		return true
	}
	switch key {
	case "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN":
		return true
	}
	return false
}

// readStageError reads result.json from the workdir and returns its Error field (empty
// if the file is missing/unparsable or the stage succeeded).
func readStageError(workDir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(workDir, "result.json"))
	if err != nil {
		return "", err
	}
	var r struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return "", err
	}
	return r.Error, nil
}

func envTrue(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
