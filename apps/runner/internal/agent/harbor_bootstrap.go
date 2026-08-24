// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// harbor-bootstrap gives an IN-CLUSTER Harbor registry its pull credentials.
//
// Hetzner has no registry product, so a canvas `registry` node becomes a Harbor release (#2430). The
// chart installs; nothing can pull from it. On every OTHER cloud a project's own registry needs no
// imagePullSecret at all — the nodes authenticate to ECR / Artifact Registry / ACR with their own
// identity (provisioner/manifests_gen.go). An in-cluster Harbor has no node identity, so it needs a
// real credential, and there was no existing shape to copy.
//
// ── Why this runs IN the cluster ──────────────────────────────────────────────────────────────
//
// Harbor's API answers only at registry-<name>.registries.svc.cluster.local. The runner holds a
// kubeconfig but has no route onto the cluster network, so it cannot call Harbor at all. This runs
// as a one-shot Job on the runner's own image instead — which is also the better shape: the robot
// credential is minted and written into a Secret without ever entering the runner process, a log,
// or execution_metadata.
//
// It is applied by the runner with argocd.ApplyManifest, NOT committed to the customer's apps repo.
// That is load-bearing. The apps Application runs `automated: {prune: true, selfHeal: true}` with no
// ignoreDifferences, so a Secret declared in git is healed back to its declared value — a minted
// credential would be reverted by the very sync that minted it, and a hook that re-mints on each
// reconcile would rotate Harbor's robot secret forever while no pod could ever pull. The same
// hazard is already shipped elsewhere and is filed as #2435. See argocd/registry_secrets.go:19-22:
// "deliberately NO ArgoCD tracking metadata: no Application owns it, so nothing syncs it away."
//
// ── Why it verifies before it mints ───────────────────────────────────────────────────────────
//
// Harbor shows a robot secret ONCE, at creation, and does not store it — there is no API to read it
// back. So "mint on every run" is not idempotent, it is a rotation loop that orphans a robot per
// deploy. The algorithm is: probe the credential already in the Secret; if it still authenticates,
// exit 0 and change nothing. Only a missing or rejected credential mints a new robot.
//
// The credential never touches argv: the Secret is written through patchPullSecret, which writes a
// 0600 temp file and passes `kubectl --patch-file` (see registry_token.go).

const (
	// harborBootstrapMaxWait bounds the wait for Harbor's API to answer. Harbor is five volumes plus
	// its own Postgres, Redis and Trivy, and it converges at ArgoCD sync-wave 2 behind everything
	// else, so a cold start on a fresh Hetzner cluster is minutes, not seconds. Generous on purpose:
	// the caller treats a timeout as a failed Job, and a too-short bound turns a slow cluster into a
	// red deploy.
	harborBootstrapMaxWait = 15 * time.Minute
	// harborPollInterval is how often the health endpoint is retried while waiting.
	harborPollInterval = 10 * time.Second
	// harborRobotDurationDays bounds the robot credential's life. Harbor expresses `duration` in
	// DAYS (the console setting is literally "Robot Token Expiration (Days)"), and its documented
	// default is 30. A never-expiring credential is available in the API but is NOT used here: an
	// unbounded secret sitting in a Secret is exactly what a registry compromise wants, and the
	// refresh path below re-mints from a Job that already runs on every deploy.
	harborRobotDurationDays = 90
	// harborHTTPTimeout bounds a single API call.
	harborHTTPTimeout = 30 * time.Second
)

// harborClient is the small slice of Harbor's v2 API this needs. An interface so the bootstrap
// algorithm is unit-testable without a Harbor: the real one needs a running registry, and the parts
// that can be wrong in a way nobody notices are the ORDERING and the verify-first branch, not HTTP.
type harborClient interface {
	// Healthy reports whether Harbor's API is up. GET /api/v2.0/health needs no authentication.
	Healthy(ctx context.Context) bool
	// EnsureProject creates the project, tolerating one that already exists, and applies the two
	// canvas switches Harbor honours natively.
	EnsureProject(ctx context.Context, name string, opts harborProjectOptions) error
	// CredentialWorks probes an existing docker credential against the registry API.
	CredentialWorks(ctx context.Context, username, secret string) bool
	// CreateRobot mints a project-scoped pull robot and returns the name and secret Harbor
	// generated. Both come from the RESPONSE: Harbor prefixes and namespaces the name it issues
	// (robot$<project>+<name> for a project-scoped account, with a configurable prefix), so a
	// name reconstructed from the request is a login that does not exist.
	CreateRobot(ctx context.Context, project, name string) (login string, secret string, err error)
}

// harborProjectOptions are the canvas `registry` switches Harbor honours through its API rather than
// through any tfvar — which is why the offer-parity guard records them as carried_in_cluster.
type harborProjectOptions struct {
	// ImmutableTags locks pushed tags against overwrite, via a project immutable-tag rule.
	ImmutableTags bool
	// VulnerabilityScanning turns on the project's auto-scan-on-push, served by the Trivy the chart
	// already installs.
	VulnerabilityScanning bool
}

// harborSecretWriter writes the finished dockerconfigjson into the pull Secret. Swappable so tests
// never shell out to kubectl.
type harborSecretWriter func(ctx context.Context, namespace, name, dockerConfigJSON string) error

// harborBootstrapOpts is the resolved flag set.
type harborBootstrapOpts struct {
	// APIBase is Harbor's API root, e.g. http://registry-app-images.registries.svc.cluster.local.
	APIBase string
	// RegistryHost is the docker registry host recorded in the dockerconfigjson `auths` key. It MUST
	// equal the host the kubelet pulls from, or the credential is silently ignored and the failure
	// looks exactly like a wrong password.
	RegistryHost string
	// Project is the Harbor project images live in.
	Project string
	// RobotName is the unprefixed robot account name requested.
	RobotName string
	// SecretName / SecretNamespace locate the dockerconfigjson Secret to write.
	SecretName      string
	SecretNamespace string
	// ImmutableTags / VulnerabilityScanning are the canvas switches.
	ImmutableTags         bool
	VulnerabilityScanning bool
	// AdminPasswordFile holds Harbor's admin password, mounted from a Secret. A FILE, never a flag
	// and never an env var: argv is world-readable via /proc and env is visible in `kubectl describe
	// pod`.
	AdminPasswordFile string
}

// RunHarborBootstrap parses the harbor-bootstrap flags and runs the mint.
func RunHarborBootstrap(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("harbor-bootstrap", flag.ContinueOnError)
	var o harborBootstrapOpts
	fs.StringVar(&o.APIBase, "api-base", "", "Harbor API root (http://registry-<name>.<ns>.svc.cluster.local)")
	fs.StringVar(&o.RegistryHost, "registry-host", "", "docker registry host for the dockerconfigjson auths key")
	fs.StringVar(&o.Project, "project", "", "Harbor project to ensure")
	fs.StringVar(&o.RobotName, "robot", "", "robot account name to mint (unprefixed)")
	fs.StringVar(&o.SecretName, "secret-name", "", "dockerconfigjson Secret to write")
	fs.StringVar(&o.SecretNamespace, "secret-namespace", "", "namespace of that Secret")
	fs.BoolVar(&o.ImmutableTags, "immutable-tags", false, "lock pushed tags against overwrite")
	fs.BoolVar(&o.VulnerabilityScanning, "vulnerability-scanning", false, "scan images on push (Trivy)")
	fs.StringVar(&o.AdminPasswordFile, "admin-password-file", "", "file holding Harbor's admin password")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := o.validate(); err != nil {
		return err
	}

	admin, err := readTrimmedFile(o.AdminPasswordFile)
	if err != nil {
		return fmt.Errorf("harbor-bootstrap: read admin password: %w", err)
	}
	if admin == "" {
		// Fail closed rather than fall through to Harbor's chart default. A blank password here means
		// the seeding step did not run, and continuing would mint against `Harbor12345`.
		return errors.New("harbor-bootstrap: the admin password file is empty — refusing to authenticate with a default credential")
	}

	client := &harborAPI{base: strings.TrimRight(o.APIBase, "/"), admin: admin, http: &http.Client{Timeout: harborHTTPTimeout}}
	return harborBootstrap(ctx, o, client, patchPullSecret, readPullSecretAuth)
}

// validate refuses a partially-specified run. Every field is load-bearing and a missing one produces
// a credential that authenticates against nothing.
func (o harborBootstrapOpts) validate() error {
	missing := []string{}
	for name, v := range map[string]string{
		"--api-base": o.APIBase, "--registry-host": o.RegistryHost, "--project": o.Project,
		"--robot": o.RobotName, "--secret-name": o.SecretName,
		"--secret-namespace": o.SecretNamespace, "--admin-password-file": o.AdminPasswordFile,
	} {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("harbor-bootstrap: missing required flag(s): %s", strings.Join(missing, ", "))
	}
	return nil
}

// harborBootstrap is the whole algorithm, with its I/O injected. Kept separate from RunHarborBootstrap
// so the ordering — wait, ensure, VERIFY, only then mint — is testable without a Harbor or a cluster.
func harborBootstrap(
	ctx context.Context,
	o harborBootstrapOpts,
	client harborClient,
	write harborSecretWriter,
	readAuth func(ctx context.Context, namespace, name, host string) (user string, secret string, err error),
) error {
	if err := waitForHarbor(ctx, client); err != nil {
		return err
	}
	if err := client.EnsureProject(ctx, o.Project, harborProjectOptions{
		ImmutableTags:         o.ImmutableTags,
		VulnerabilityScanning: o.VulnerabilityScanning,
	}); err != nil {
		return fmt.Errorf("harbor-bootstrap: ensure project %q: %w", o.Project, err)
	}

	// VERIFY FIRST. Harbor does not store robot secrets, so a re-mint on every deploy would orphan a
	// robot per run and rotate the credential out from under any pod mid-pull. If what is already in
	// the Secret still authenticates, this run must change nothing.
	if user, secret, err := readAuth(ctx, o.SecretNamespace, o.SecretName, o.RegistryHost); err == nil && user != "" && secret != "" {
		if client.CredentialWorks(ctx, user, secret) {
			fmt.Fprintf(os.Stdout, "harbor-bootstrap: existing credential for %s still authenticates; nothing to do\n", o.RegistryHost)
			return nil
		}
		fmt.Fprintln(os.Stdout, "harbor-bootstrap: the stored credential no longer authenticates; minting a replacement")
	}

	// A REPLACEMENT must not reuse the name. Harbor rejects a duplicate, and the previous robot's
	// secret cannot be read back — so re-minting under the same name would fail forever once a
	// credential broke. Uniquifying here rather than in the HTTP client keeps the invariant where it
	// is testable and where it belongs.
	login, secret, err := client.CreateRobot(ctx, o.Project, harborRandomName(o.RobotName))
	if err != nil {
		return fmt.Errorf("harbor-bootstrap: create robot: %w", err)
	}
	if login == "" || secret == "" {
		return errors.New("harbor-bootstrap: Harbor returned an empty robot name or secret")
	}

	if err := write(ctx, o.SecretNamespace, o.SecretName, dockerConfigJSON(o.RegistryHost, login, secret)); err != nil {
		return fmt.Errorf("harbor-bootstrap: write pull secret: %w", err)
	}
	// The LOGIN is safe to log (it is a username); the secret never is.
	fmt.Fprintf(os.Stdout, "harbor-bootstrap: wrote %s/%s for %s as %s\n", o.SecretNamespace, o.SecretName, o.RegistryHost, login)
	return nil
}

// waitForHarbor blocks until Harbor's API answers, or the bound elapses.
func waitForHarbor(ctx context.Context, client harborClient) error {
	deadline := time.Now().Add(harborBootstrapMaxWait)
	for {
		if client.Healthy(ctx) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("harbor-bootstrap: Harbor did not become healthy within %s", harborBootstrapMaxWait)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(harborPollInterval):
		}
	}
}

// readTrimmedFile reads a mounted credential file.
func readTrimmedFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// harborRandomName suffixes a robot name so a replacement never collides with the account whose
// secret was lost. Harbor rejects a duplicate name, and the old robot's secret is unrecoverable, so
// re-minting under the same name would fail forever once the first credential broke.
func harborRandomName(base string) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 6)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			// crypto/rand failing is not survivable, and a predictable fallback would be worse than
			// a failed Job: the caller retries.
			return base
		}
		b[i] = alphabet[n.Int64()]
	}
	return base + "-" + string(b)
}

// ── the real Harbor client ─────────────────────────────────────────────────────────────────────

type harborAPI struct {
	base  string
	admin string
	http  *http.Client
}

// do issues one authenticated request against Harbor's v2 API.
func (h *harborAPI) do(ctx context.Context, method, path string, body any) (int, []byte, error) {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.base+path, rdr)
	if err != nil {
		return 0, nil, err
	}
	req.SetBasicAuth("admin", h.admin)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := h.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	// Bounded read: an error body is for a log line, not a buffer of unknown size.
	out, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res.StatusCode, out, nil
}

// Healthy probes the unauthenticated health endpoint.
func (h *harborAPI) Healthy(ctx context.Context) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+"/api/v2.0/health", nil)
	if err != nil {
		return false
	}
	res, err := h.http.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	return res.StatusCode == http.StatusOK
}

// EnsureProject creates the project, treating "already exists" as success, then applies the switches.
//
// `auto_scan` rides the project METADATA on create, and is re-asserted on an existing project so a
// switch toggled after the first deploy actually takes effect — a create-only setting would leave the
// canvas and the registry permanently disagreeing.
func (h *harborAPI) EnsureProject(ctx context.Context, name string, opts harborProjectOptions) error {
	code, body, err := h.do(ctx, http.MethodPost, "/api/v2.0/projects", map[string]any{
		"project_name": name,
		"public":       false,
		"metadata":     map[string]string{"auto_scan": strconv.FormatBool(opts.VulnerabilityScanning)},
	})
	if err != nil {
		return err
	}
	switch code {
	case http.StatusCreated, http.StatusConflict:
	default:
		return fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}

	// Re-assert on every run: the create above is a no-op once the project exists.
	if code == http.StatusConflict {
		if c, b, mErr := h.do(ctx, http.MethodPut, "/api/v2.0/projects/"+name, map[string]any{
			"metadata": map[string]string{"auto_scan": strconv.FormatBool(opts.VulnerabilityScanning)},
		}); mErr != nil {
			return mErr
		} else if c != http.StatusOK {
			return fmt.Errorf("set auto_scan: unexpected status %d: %s", c, strings.TrimSpace(string(b)))
		}
	}
	return h.ensureImmutableTagRule(ctx, name, opts.ImmutableTags)
}

// ensureImmutableTagRule makes the project's immutable-tag rules match the switch.
//
// Harbor has no "set the rules to exactly this" call, so the desired state is reconciled: read what
// exists, delete Alethia's rule when the switch is off, create it when it is on and absent. Blindly
// POSTing would accumulate a duplicate rule per deploy, and never deleting would make the switch
// one-way — on is easy to test, off is the direction that silently does nothing.
func (h *harborAPI) ensureImmutableTagRule(ctx context.Context, project string, want bool) error {
	code, body, err := h.do(ctx, http.MethodGet, "/api/v2.0/projects/"+project+"/immutabletagrules", nil)
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("list immutable tag rules: unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	var rules []struct {
		ID       int  `json:"id"`
		Disabled bool `json:"disabled"`
	}
	if err := json.Unmarshal(body, &rules); err != nil {
		return fmt.Errorf("decode immutable tag rules: %w", err)
	}
	if !want {
		for _, r := range rules {
			if c, b, dErr := h.do(ctx, http.MethodDelete,
				fmt.Sprintf("/api/v2.0/projects/%s/immutabletagrules/%d", project, r.ID), nil); dErr != nil {
				return dErr
			} else if c != http.StatusOK && c != http.StatusNotFound {
				return fmt.Errorf("delete immutable tag rule %d: unexpected status %d: %s", r.ID, c, strings.TrimSpace(string(b)))
			}
		}
		return nil
	}
	if len(rules) > 0 {
		return nil
	}
	// Every tag of every repository in the project. The switch is "immutable tags", not "immutable
	// some tags" — a narrower default would be a setting nobody asked for.
	c, b, cErr := h.do(ctx, http.MethodPost, "/api/v2.0/projects/"+project+"/immutabletagrules", map[string]any{
		"disabled": false,
		"scope_selectors": map[string]any{"repository": []map[string]string{
			{"kind": "doublestar", "decoration": "repoMatches", "pattern": "**"},
		}},
		"tag_selectors": []map[string]string{
			{"kind": "doublestar", "decoration": "matches", "pattern": "**"},
		},
	})
	if cErr != nil {
		return cErr
	}
	if c != http.StatusCreated && c != http.StatusConflict {
		return fmt.Errorf("create immutable tag rule: unexpected status %d: %s", c, strings.TrimSpace(string(b)))
	}
	return nil
}

// CredentialWorks probes the registry API with a docker credential. A 200 means the login is live;
// 401 means it is not. Anything else is treated as NOT working — a credential we cannot confirm must
// be replaced rather than trusted, because the failure mode of trusting it is a cluster that cannot
// pull and a Job that reports success.
func (h *harborAPI) CredentialWorks(ctx context.Context, username, secret string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.base+"/v2/", nil)
	if err != nil {
		return false
	}
	req.SetBasicAuth(username, secret)
	res, err := h.http.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
	return res.StatusCode == http.StatusOK
}

// CreateRobot mints a project-scoped PULL robot under exactly the name it is given — the caller
// owns uniqueness (see harborBootstrap).
//
// Pull only: this credential exists so the kubelet can pull, and a push right on a credential
// mounted into every app namespace is authority nobody asked for. Pushing to the in-cluster registry
// is a separate path (the image builder mounts no docker config today).
func (h *harborAPI) CreateRobot(ctx context.Context, project, name string) (string, string, error) {
	code, body, err := h.do(ctx, http.MethodPost, "/api/v2.0/robots", map[string]any{
		"name":     name,
		"duration": harborRobotDurationDays,
		"level":    "project",
		"disable":  false,
		"permissions": []map[string]any{{
			"kind":      "project",
			"namespace": project,
			"access": []map[string]string{
				{"resource": "repository", "action": "pull"},
			},
		}},
	})
	if err != nil {
		return "", "", err
	}
	if code != http.StatusCreated {
		return "", "", fmt.Errorf("unexpected status %d: %s", code, strings.TrimSpace(string(body)))
	}
	var created struct {
		Name   string `json:"name"`
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		return "", "", fmt.Errorf("decode robot response: %w", err)
	}
	// Both come from the response. Harbor issues the prefixed, project-namespaced login
	// (robot$<project>+<name>, with a configurable prefix) and shows the secret exactly once.
	return created.Name, created.Secret, nil
}

// readPullSecretAuth reads the credential currently stored in the pull Secret, so the caller can
// probe it before minting a replacement. A missing Secret is not an error — it is the first run.
func readPullSecretAuth(ctx context.Context, namespace, name, host string) (string, string, error) {
	cmd := exec.CommandContext(ctx, "kubectl", "get", "secret", name, "-n", namespace,
		"-o", `jsonpath={.data.\.dockerconfigjson}`)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// A missing Secret is the FIRST RUN, not a failure: there is nothing to verify and the
		// caller falls through to minting. Returning an error here would fail every fresh cluster.
		return "", "", nil
	}
	if strings.TrimSpace(stdout.String()) == "" {
		return "", "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(stdout.String()))
	if err != nil {
		return "", "", err
	}
	var cfg struct {
		Auths map[string]struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Auth     string `json:"auth"`
		} `json:"auths"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", "", err
	}
	entry, ok := cfg.Auths[host]
	if !ok {
		return "", "", nil
	}
	if entry.Username != "" && entry.Password != "" {
		return entry.Username, entry.Password, nil
	}
	if entry.Auth != "" {
		decoded, derr := base64.StdEncoding.DecodeString(entry.Auth)
		if derr != nil {
			return "", "", derr
		}
		user, pass, found := strings.Cut(string(decoded), ":")
		if found {
			return user, pass, nil
		}
	}
	return "", "", nil
}
