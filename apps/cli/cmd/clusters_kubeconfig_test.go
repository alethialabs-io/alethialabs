// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/kubecache"
	"github.com/alethialabs-io/alethialabs/packages/core/kubeaccess"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"gopkg.in/yaml.v3"
)

// The httptest console for `cluster kubeconfig` and `cluster token`.
//
// It answers the three routes the commands call — the cluster list, the mint request and the mint
// poll — and plays the RUNNER's part too: when a poll is due to be ready, it seals a real credential
// to the client's public key with kubeaccess.Seal, bound to the mint id and cluster id, exactly as
// the runner does. So the CLI's Open, AAD binding, tier/shape check and rendering all run for real.
//
// Every credential it mints carries kcCanary as its token. The canary assertions below look for
// that string in places a credential must never be.

const (
	kcClusterID = "aaaaaaaa-1111-4111-8111-111111111111"
	kcOtherID   = "bbbbbbbb-2222-4222-8222-222222222222"
	kcCanary    = "CANARY-kc-token-5e0d9a"
	kcServer    = "https://203.0.113.10:6443"
)

// kcConsole is the fake control plane and runner. Zero values are the happy path.
type kcConsole struct {
	t  *testing.T
	mu sync.Mutex

	clusters []map[string]any

	postStatus int    // refuse the mint request with this status (0 = accept)
	postMsg    string // the refusal's error message
	retryAfter string // the refusal's Retry-After header
	staticOnly bool   // refuse exec with a 422, as Hetzner and Alibaba do

	polls      []string // the poll statuses in order; the last repeats. Default: pending, ready.
	pollStatus int      // refuse every poll with this status
	reason     string   // a failed poll's reason
	private    *bool    // the ready poll's private_endpoint

	credTier    string        // override the sealed credential's tier
	credShape   string        // override the sealed credential's shape
	credTTL     time.Duration // the credential's lifetime (default 1h)
	plaintext   string        // seal this instead of a credential
	sealToOther bool          // seal to another mint id (a blob for someone else)
	wrongMint   bool          // answer the POST with a mint for another cluster
	readyDelay  time.Duration // sleep before answering a ready poll (concurrency test)

	posts   []types.KubeconfigMintRequest
	orgs    []string
	pollsBy map[string]int
	keys    map[string]types.KubeconfigMintRequest
}

// kcCA is a real self-signed CA, base64 PEM, because the renderer pins and parses it.
var kcCA = func() string {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "kc-test-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}()

// kcDefaultClusters is one provisioned cluster, plus a second environment of the same project.
func kcDefaultClusters() []map[string]any {
	return []map[string]any{
		{"id": kcClusterID, "cluster_name": "web-production", "project_name": "web", "environment": "production", "status": "ACTIVE"},
		{"id": kcOtherID, "cluster_name": "web-staging", "project_name": "web", "environment": "staging", "status": "ACTIVE"},
	}
}

// credential builds the plaintext the runner would seal for req.
func (c *kcConsole) credential(req types.KubeconfigMintRequest) []byte {
	if c.plaintext != "" {
		return []byte(c.plaintext)
	}
	ttl := c.credTTL
	if ttl == 0 {
		ttl = time.Hour
	}
	cred := types.KubeconfigMintCredential{Shape: req.Shape, Tier: req.Tier, ExpiresAt: time.Now().Add(ttl).UTC().Truncate(time.Second)}
	if c.credTier != "" {
		cred.Tier = types.KubeconfigMintTier(c.credTier)
	}
	if c.credShape != "" {
		cred.Shape = types.KubeconfigMintShape(c.credShape)
	}
	if req.Shape == types.KubeconfigMintShapeExec {
		cred.Server, cred.CertificateAuthorityData, cred.Token = kcServer, kcCA, kcCanary
	} else {
		doc, err := kubeaccess.RenderStaticKubeconfig(
			kubeaccess.Target{Project: "runner-named", Env: "whatever", Server: kcServer, CAData: kcCA},
			kubeaccess.StaticCredential{Token: kcCanary})
		if err != nil {
			c.t.Fatalf("render static: %v", err)
		}
		cred.Kubeconfig = string(doc)
	}
	out, _ := json.Marshal(cred)
	return out
}

// writeJSON answers with a status and a JSON body.
func kcWriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// ServeHTTP is the console.
func (c *kcConsole) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	path := r.URL.Path
	parts := strings.Split(strings.TrimPrefix(path, "/api/cli/clusters/"), "/")
	switch {
	case path == "/api/cli/clusters" && r.Method == http.MethodGet:
		kcWriteJSON(w, 200, map[string]any{"clusters": c.clusters})

	case len(parts) == 2 && parts[1] == "kubeconfig" && r.Method == http.MethodPost:
		var req types.KubeconfigMintRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			c.t.Errorf("mint body: %v", err)
		}
		c.posts = append(c.posts, req)
		c.orgs = append(c.orgs, r.Header.Get("X-Alethia-Org"))
		if c.postStatus != 0 {
			if c.retryAfter != "" {
				w.Header().Set("Retry-After", c.retryAfter)
			}
			kcWriteJSON(w, c.postStatus, map[string]string{"error": c.postMsg})
			return
		}
		if c.staticOnly && req.Shape == types.KubeconfigMintShapeExec {
			kcWriteJSON(w, 422, map[string]string{"error": `This cloud issues certificates, so it can only mint a static kubeconfig: use shape "static"`})
			return
		}
		mintID := fmt.Sprintf("cccccccc-0000-4000-8000-%012d", len(c.posts))
		c.keys[mintID] = req
		clusterID := parts[0]
		if c.wrongMint {
			clusterID = kcOtherID
		}
		kcWriteJSON(w, 202, map[string]any{"mint": map[string]any{
			"id": mintID, "cluster_id": clusterID, "job_id": "dddddddd-0000-4000-8000-000000000001",
			"tier": req.Tier, "shape": req.Shape, "ttl_seconds": req.TTLSeconds, "status": "pending",
			"expires_at": time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339),
		}})

	case len(parts) == 3 && parts[1] == "kubeconfig" && r.Method == http.MethodGet:
		if c.pollStatus != 0 {
			kcWriteJSON(w, c.pollStatus, map[string]string{"error": "Kubeconfig mint not found"})
			return
		}
		mintID := parts[2]
		req, ok := c.keys[mintID]
		if !ok {
			kcWriteJSON(w, 404, map[string]string{"error": "Kubeconfig mint not found"})
			return
		}
		seq := c.polls
		if len(seq) == 0 {
			seq = []string{"pending", "ready"}
		}
		i := c.pollsBy[mintID]
		c.pollsBy[mintID]++
		status := seq[min(i, len(seq)-1)]
		switch status {
		case "pending":
			kcWriteJSON(w, 200, map[string]any{"status": "pending", "private_endpoint": nil, "expires_at": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)})
		case "failed":
			kcWriteJSON(w, 200, map[string]any{"status": "failed", "private_endpoint": nil, "reason": c.reason})
		case "expired":
			kcWriteJSON(w, 200, map[string]any{"status": "expired", "private_endpoint": nil})
		case "ready":
			if c.readyDelay > 0 {
				time.Sleep(c.readyDelay)
			}
			sealFor := mintID
			if c.sealToOther {
				sealFor = "eeeeeeee-0000-4000-8000-000000000000"
			}
			sealed, err := kubeaccess.Seal(req.ClientPublicKey, sealFor, parts[0], c.credential(req))
			if err != nil {
				c.t.Fatalf("seal: %v", err)
			}
			priv := false
			if c.private != nil {
				priv = *c.private
			}
			delete(c.keys, mintID) // served once, like the real route
			kcWriteJSON(w, 200, map[string]any{"status": "ready", "private_endpoint": priv, "sealed": sealed})
		}

	default:
		kcWriteJSON(w, 404, map[string]string{"error": "no route " + r.Method + " " + path})
	}
}

// kcPostCount is how many mint requests reached the console.
func (c *kcConsole) kcPostCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.posts)
}

// kcEnv is one isolated invocation environment: credentials, an active org, the console, a
// KUBECONFIG of its own, an instant poll clock, and the captured stderr.
type kcEnv struct {
	t          *testing.T
	console    *kcConsole
	kubeconfig string
	stderr     *bytes.Buffer
	sleeps     []time.Duration
}

// newKCEnv stands the environment up. The console is configured by mutating env.console before
// running a command.
func newKCEnv(t *testing.T) *kcEnv {
	t.Helper()
	resetFlagsAroundTest(t)
	credsPath := isolatedHome(t)
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r",
	}); err != nil {
		t.Fatal(err)
	}
	if err := types.SaveCliConfig(types.CliConfig{ActiveOrgID: "o1", ActiveOrgName: "Acme", ActiveOrgSlug: "acme"}); err != nil {
		t.Fatal(err)
	}
	env := &kcEnv{t: t, stderr: &bytes.Buffer{}}
	env.console = &kcConsole{t: t, clusters: kcDefaultClusters(), pollsBy: map[string]int{}, keys: map[string]types.KubeconfigMintRequest{}}
	srv := httptest.NewServer(env.console)
	t.Cleanup(srv.Close)
	t.Setenv("ALETHIA_WEB_ORIGIN", srv.URL)
	t.Setenv("ALETHIA_NO_UPDATE_CHECK", "1")
	env.kubeconfig = filepath.Join(t.TempDir(), "kube", "config")
	t.Setenv("KUBECONFIG", env.kubeconfig)

	prevSleep, prevOut, prevExit := kubeMintSleep, kubeStatusOut, exitFunc
	kubeMintSleep = func(d time.Duration) { env.sleeps = append(env.sleeps, d) }
	kubeStatusOut = env.stderr
	exitFunc = func(code int) { panic(miscExit{code}) }
	t.Cleanup(func() { kubeMintSleep, kubeStatusOut, exitFunc = prevSleep, prevOut, prevExit })
	return env
}

// run executes the real cobra tree and returns stdout and the error (errMiscExited on a fatal
// path). Flags are reset first, so one run's --admin cannot leak into the next.
func (e *kcEnv) run(args ...string) (stdout string, err error) {
	e.t.Helper()
	resetAllFlags()
	out := stdoutCapture(e.t, func() {
		defer func() {
			if r := recover(); r != nil {
				if _, ok := r.(miscExit); !ok {
					panic(r)
				}
				err = errMiscExited
			}
		}()
		execRootArgs(args)
		err = rootCmd.Execute()
	})
	return string(out), err
}

// cache opens the environment's kubecache.
func (e *kcEnv) cache() *kubecache.Cache {
	e.t.Helper()
	dir, err := kubecache.DefaultDir()
	if err != nil {
		e.t.Fatal(err)
	}
	c, err := kubecache.Open(dir)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// kcDoc is the decoded shape of a kubeconfig, enough to assert on.
type kcDoc struct {
	CurrentContext string `yaml:"current-context"`
	Clusters       []struct {
		Name    string `yaml:"name"`
		Cluster struct {
			Server string `yaml:"server"`
		} `yaml:"cluster"`
	} `yaml:"clusters"`
	Users []struct {
		Name string `yaml:"name"`
		User struct {
			Token string `yaml:"token"`
			Exec  *struct {
				Command string   `yaml:"command"`
				Args    []string `yaml:"args"`
			} `yaml:"exec"`
		} `yaml:"user"`
	} `yaml:"users"`
	Contexts []struct {
		Name    string `yaml:"name"`
		Context struct {
			Cluster string `yaml:"cluster"`
			User    string `yaml:"user"`
		} `yaml:"context"`
	} `yaml:"contexts"`
	Preferences map[string]any `yaml:"preferences"`
}

// readKC reads and decodes a kubeconfig, asserting it is mode 0600.
func readKC(t *testing.T, path string) (kcDoc, string) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("%s mode %#o, want 0600", path, fi.Mode().Perm())
	}
	raw, _ := os.ReadFile(path)
	var d kcDoc
	if err := yaml.Unmarshal(raw, &d); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return d, string(raw)
}

// countNamed counts entries called name in each of the three sections.
func (d kcDoc) countNamed(name string) (clusters, users, contexts int) {
	for _, c := range d.Clusters {
		if c.Name == name {
			clusters++
		}
	}
	for _, u := range d.Users {
		if u.Name == name {
			users++
		}
	}
	for _, c := range d.Contexts {
		if c.Name == name {
			contexts++
		}
	}
	return
}

const kcExisting = `# my own kubeconfig — this comment must survive
apiVersion: v1
kind: Config
clusters:
- name: other
  cluster:
    server: https://other.example:6443
users:
- name: other
  user:
    token: someone-elses-token
contexts:
- name: other
  context:
    cluster: other
    user: other
current-context: other
preferences:
  colors: true
`

const kcContext = "alethia-web-production"

// TestClusterKubeconfig_ExecMergesIntoAnExistingKubeconfig is the default path end to end: an
// exec kubeconfig merged into a file that already has someone else's entries, which all survive.
func TestClusterKubeconfig_ExecMergesIntoAnExistingKubeconfig(t *testing.T) {
	env := newKCEnv(t)
	if err := os.MkdirAll(filepath.Dir(env.kubeconfig), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(env.kubeconfig, []byte(kcExisting), 0o644); err != nil {
		t.Fatal(err)
	}

	stdout, err := env.run("cluster", "kubeconfig", "web-production", "--no-input")
	if err != nil {
		t.Fatalf("run: %v\nstderr: %s", err, env.stderr)
	}
	if stdout != "" {
		t.Errorf("stdout must be empty without --output -, got %q", stdout)
	}

	doc, raw := readKC(t, env.kubeconfig)
	if doc.CurrentContext != kcContext {
		t.Errorf("current-context %q", doc.CurrentContext)
	}
	if cl, us, cx := doc.countNamed("other"); cl != 1 || us != 1 || cx != 1 {
		t.Errorf("the existing entries were not preserved: %d/%d/%d\n%s", cl, us, cx, raw)
	}
	if !strings.Contains(raw, "someone-elses-token") || !strings.Contains(raw, "this comment must survive") || doc.Preferences["colors"] != true {
		t.Errorf("untouched content changed:\n%s", raw)
	}
	if cl, us, cx := doc.countNamed(kcContext); cl != 1 || us != 1 || cx != 1 {
		t.Fatalf("want one of each for %s, got %d/%d/%d", kcContext, cl, us, cx)
	}
	for _, u := range doc.Users {
		if u.Name != kcContext {
			continue
		}
		if u.User.Exec == nil || u.User.Exec.Command != "alethia" || strings.Join(u.User.Exec.Args, " ") != "cluster token "+kcClusterID {
			t.Errorf("exec user %+v", u.User.Exec)
		}
	}
	// The exec shape holds no credential, anywhere a person reads.
	for where, s := range map[string]string{"kubeconfig": raw, "stdout": stdout, "stderr": env.stderr.String()} {
		if strings.Contains(s, kcCanary) {
			t.Errorf("the credential reached %s", where)
		}
	}

	// The request: read-only, exec, 1h, a 32-byte public key.
	if len(env.console.posts) != 1 {
		t.Fatalf("posts: %d", len(env.console.posts))
	}
	req := env.console.posts[0]
	if req.Tier != types.KubeconfigMintTierReadonly || req.Shape != types.KubeconfigMintShapeExec || req.TTLSeconds != 3600 {
		t.Errorf("request %+v", req)
	}
	if _, err := types.DecodeKubeconfigMintPublicKey(req.ClientPublicKey); err != nil {
		t.Errorf("public key: %v", err)
	}

	// The cache is seeded, so the first kubectl call is instant.
	c := env.cache()
	e, err := c.Get(kcClusterID, types.KubeconfigMintTierReadonly)
	if err != nil || e == nil || e.Token != kcCanary {
		t.Fatalf("cache not seeded: %v %v", e, err)
	}
	p, ok, err := c.Profile(kcClusterID)
	if err != nil || !ok || p.Tier != types.KubeconfigMintTierReadonly || p.TTLSeconds != 3600 || p.OrgID != "o1" {
		t.Errorf("profile %+v %v %v", p, ok, err)
	}
	if !strings.Contains(env.stderr.String(), "kubectl --context "+kcContext) {
		t.Errorf("summary: %s", env.stderr)
	}

	// The backoff: the first poll after kubeMintPollFirst, then doubling.
	if len(env.sleeps) != 2 || env.sleeps[0] != kubeMintPollFirst || env.sleeps[1] != 2*kubeMintPollFirst {
		t.Errorf("sleeps %v", env.sleeps)
	}

	// Running it again replaces the entries rather than adding a second set.
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); err != nil {
		t.Fatalf("second run: %v", err)
	}
	doc, _ = readKC(t, env.kubeconfig)
	if cl, us, cx := doc.countNamed(kcContext); cl != 1 || us != 1 || cx != 1 {
		t.Errorf("a re-run duplicated entries: %d/%d/%d", cl, us, cx)
	}
	if _, err := os.Stat(env.kubeconfig + ".lock"); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the kubeconfig lock was left behind: %v", err)
	}
}

// TestClusterKubeconfig_MergeCreatesTheFile: with no kubeconfig yet, the merge writes a complete one.
func TestClusterKubeconfig_MergeCreatesTheFile(t *testing.T) {
	env := newKCEnv(t)
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input", "--merge"); err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	doc, _ := readKC(t, env.kubeconfig)
	if doc.CurrentContext != kcContext || len(doc.Clusters) != 1 || doc.Clusters[0].Cluster.Server != kcServer {
		t.Errorf("doc %+v", doc)
	}
	fi, _ := os.Stat(filepath.Dir(env.kubeconfig))
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("created dir mode %#o", fi.Mode().Perm())
	}
}

// TestClusterKubeconfig_StaticToStdout: `--output -` is the one way the credential is printed, and
// the static file is renamed to the context name whatever the runner called it.
func TestClusterKubeconfig_StaticToStdout(t *testing.T) {
	env := newKCEnv(t)
	stdout, err := env.run("cluster", "kubeconfig", "web-production", "--no-input", "--static", "--output", "-")
	if err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	if !strings.Contains(stdout, kcCanary) {
		t.Errorf("--output - must print the static credential:\n%s", stdout)
	}
	var d kcDoc
	if err := yaml.Unmarshal([]byte(stdout), &d); err != nil {
		t.Fatal(err)
	}
	if d.CurrentContext != kcContext || d.countNamedAll(kcContext) != 3 || d.Contexts[0].Context.Cluster != kcContext || d.Contexts[0].Context.User != kcContext {
		t.Errorf("not renamed: %+v", d)
	}
	if strings.Contains(stdout, "runner-named") {
		t.Errorf("the runner's names survived:\n%s", stdout)
	}
	if strings.Contains(env.stderr.String(), kcCanary) {
		t.Error("the credential reached stderr")
	}
	if _, err := os.Stat(env.kubeconfig); !errors.Is(err, os.ErrNotExist) {
		t.Error("--output - must not touch the kubeconfig")
	}
	// A static mint seeds no exec cache.
	if e, _ := env.cache().Get(kcClusterID, types.KubeconfigMintTierReadonly); e != nil {
		t.Error("a static kubeconfig must not seed the exec cache")
	}
	if !strings.Contains(env.stderr.String(), "until") {
		t.Errorf("a static kubeconfig names its expiry: %s", env.stderr)
	}
}

// countNamedAll is the three counts summed.
func (d kcDoc) countNamedAll(name string) int {
	a, b, c := d.countNamed(name)
	return a + b + c
}

// TestClusterKubeconfig_OutputFile writes a standalone 0600 file and leaves the merge target alone.
func TestClusterKubeconfig_OutputFile(t *testing.T) {
	env := newKCEnv(t)
	out := filepath.Join(t.TempDir(), "sub", "web.kubeconfig")
	stdout, err := env.run("cluster", "kubeconfig", "web-production", "--no-input", "--static", "--output", out)
	if err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	if stdout != "" {
		t.Errorf("stdout %q", stdout)
	}
	doc, raw := readKC(t, out)
	if doc.CurrentContext != kcContext || !strings.Contains(raw, kcCanary) {
		t.Errorf("file:\n%s", raw)
	}
	if _, err := os.Stat(env.kubeconfig); !errors.Is(err, os.ErrNotExist) {
		t.Error("--output FILE must not touch the kubeconfig")
	}
	if !strings.Contains(env.stderr.String(), "mode 0600") {
		t.Errorf("summary: %s", env.stderr)
	}

	// A relative path in the working directory, through a symlink that is followed, not replaced.
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.WriteFile(filepath.Join(dir, "real"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input", "--output", "link"); err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	if fi, _ := os.Lstat(filepath.Join(dir, "link")); fi.Mode()&os.ModeSymlink == 0 {
		t.Error("the symlink was replaced instead of followed")
	}
	if d, _ := readKC(t, filepath.Join(dir, "real")); d.CurrentContext != kcContext {
		t.Error("the symlink target was not written")
	}
}

// TestClusterKubeconfig_AdminAndTTLReachTheRequest: the flags become the request and the profile.
func TestClusterKubeconfig_AdminAndTTLReachTheRequest(t *testing.T) {
	env := newKCEnv(t)
	if _, err := env.run("cluster", "kubeconfig", kcClusterID, "--no-input", "--admin", "--ttl", "4h"); err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	req := env.console.posts[0]
	if req.Tier != types.KubeconfigMintTierAdmin || req.TTLSeconds != 14400 {
		t.Errorf("request %+v", req)
	}
	p, ok, _ := env.cache().Profile(kcClusterID)
	if !ok || p.Tier != types.KubeconfigMintTierAdmin || p.TTLSeconds != 14400 {
		t.Errorf("profile %+v", p)
	}
	if !strings.Contains(env.stderr.String(), "Access: admin") || !strings.Contains(env.stderr.String(), "4h 0m") {
		t.Errorf("summary: %s", env.stderr)
	}
}

// TestClusterKubeconfig_FallsBackToStaticWhenTheCloudIssuesCertificates: Hetzner and Alibaba refuse
// exec with a 422; the command asks again for static and writes that.
func TestClusterKubeconfig_FallsBackToStaticWhenTheCloudIssuesCertificates(t *testing.T) {
	env := newKCEnv(t)
	env.console.staticOnly = true
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	if len(env.console.posts) != 2 || env.console.posts[0].Shape != types.KubeconfigMintShapeExec || env.console.posts[1].Shape != types.KubeconfigMintShapeStatic {
		t.Fatalf("posts %+v", env.console.posts)
	}
	_, raw := readKC(t, env.kubeconfig)
	if !strings.Contains(raw, kcCanary) {
		t.Error("the static credential was not written")
	}
	if e, _ := env.cache().Get(kcClusterID, types.KubeconfigMintTierReadonly); e != nil {
		t.Error("a static fallback must not seed the exec cache")
	}
}

// TestClusterKubeconfig_PrivateEndpointNotice: decision 6 — say plainly that reach is needed.
func TestClusterKubeconfig_PrivateEndpointNotice(t *testing.T) {
	env := newKCEnv(t)
	yes := true
	env.console.private = &yes
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); err != nil {
		t.Fatalf("run: %v", err)
	}
	if !strings.Contains(env.stderr.String(), "endpoint is private") || !strings.Contains(env.stderr.String(), "VPN") {
		t.Errorf("no private-endpoint notice: %s", env.stderr)
	}

	env2 := newKCEnv(t)
	if _, err := env2.run("cluster", "kubeconfig", "web-production", "--no-input"); err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.Contains(env2.stderr.String(), "endpoint is private") {
		t.Error("a public endpoint printed the private notice")
	}
}

// TestClusterKubeconfig_PollOutcomes drives every terminal poll answer.
func TestClusterKubeconfig_PollOutcomes(t *testing.T) {
	cases := []struct {
		name  string
		setup func(c *kcConsole)
		want  string
	}{
		{"failed", func(c *kcConsole) {
			c.polls, c.reason = []string{"pending", "failed"}, "The runner could not reach the cluster's API endpoint."
		}, "the runner could not mint the kubeconfig: The runner could not reach the cluster's API endpoint."},
		{"expired", func(c *kcConsole) { c.polls = []string{"expired"} }, "expired before a runner completed it"},
		{"poll 404", func(c *kcConsole) { c.pollStatus = 404 }, "the kubeconfig request is gone"},
		{"poll 403", func(c *kcConsole) { c.pollStatus = 403 }, "no longer allows collecting"},
		{"poll 500", func(c *kcConsole) { c.pollStatus = 500 }, "polling the kubeconfig request failed"},
		{"sealed to another mint", func(c *kcConsole) { c.sealToOther = true }, "did not open with this request's key"},
		{"not a credential", func(c *kcConsole) { c.plaintext = `{"token":"` + kcCanary + `","surprise":1}` }, "not a credential this CLI understands"},
		{"malformed credential", func(c *kcConsole) {
			c.plaintext = `{"shape":"exec","tier":"readonly","token":"` + kcCanary + `","expires_at":"2030-01-01T00:00:00Z"}`
		}, "malformed"},
		{"upgraded tier", func(c *kcConsole) { c.credTier = "admin" }, "returned a admin exec credential for a readonly exec request"},
		{"already expired", func(c *kcConsole) { c.credTTL = -time.Minute }, "had already expired"},
		{"another cluster's mint", func(c *kcConsole) { c.wrongMint = true }, "queued a different kubeconfig"},
		{"static file with two clusters", func(c *kcConsole) {
			c.staticOnly = true
			c.plaintext = `{"shape":"static","tier":"readonly","kubeconfig":"clusters: [{name: a}, {name: b}]","expires_at":"2030-01-01T00:00:00Z"}`
		}, "does not carry exactly one entry"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newKCEnv(t)
			tc.setup(env.console)
			stdout, err := env.run("cluster", "kubeconfig", "web-production", "--no-input")
			if !errors.Is(err, errMiscExited) {
				t.Fatalf("want a fatal exit, got %v", err)
			}
			if !strings.Contains(env.stderr.String(), tc.want) {
				t.Errorf("stderr %q does not say %q", env.stderr, tc.want)
			}
			if strings.Contains(env.stderr.String(), kcCanary) || strings.Contains(stdout, kcCanary) {
				t.Error("an error carried the credential")
			}
			if _, err := os.Stat(env.kubeconfig); !errors.Is(err, os.ErrNotExist) {
				t.Error("a failed mint wrote a kubeconfig")
			}
		})
	}
}

// TestClusterKubeconfig_PollTimesOut: a mint that stays pending past the local ceiling ends.
func TestClusterKubeconfig_PollTimesOut(t *testing.T) {
	env := newKCEnv(t)
	env.console.polls = []string{"pending"}
	start := time.Now()
	clock := start
	prev := kubeNow
	kubeNow = func() time.Time { return clock }
	t.Cleanup(func() { kubeNow = prev })
	kubeMintSleep = func(d time.Duration) { clock = clock.Add(d); env.sleeps = append(env.sleeps, d) }
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); !errors.Is(err, errMiscExited) {
		t.Fatalf("want a fatal exit, got %v", err)
	}
	if !strings.Contains(env.stderr.String(), "timed out waiting for a runner") {
		t.Errorf("stderr %s", env.stderr)
	}
	for _, d := range env.sleeps {
		if d > kubeMintPollMax {
			t.Errorf("a poll interval exceeded the cap: %v", d)
		}
	}
	if env.sleeps[len(env.sleeps)-1] != kubeMintPollMax {
		t.Errorf("the backoff never reached its cap: %v", env.sleeps)
	}
}

// TestClusterKubeconfig_RefusalsReadAsNextSteps maps every refusal status to its sentence.
func TestClusterKubeconfig_RefusalsReadAsNextSteps(t *testing.T) {
	cases := []struct {
		status     int
		msg, retry string
		args       []string
		want       string
	}{
		{401, "Unauthorized", "", nil, "run `alethia login`"},
		{402, "Job quota reached", "", nil, "plan does not allow another kubeconfig right now: Job quota reached"},
		{403, "Forbidden", "", nil, "owners, admins and operators can"},
		{403, "Forbidden", "", []string{"--admin"}, "drop --admin"},
		{404, "Cluster not found", "", nil, "not found in the active organization"},
		{409, "The cluster has not been provisioned", "", nil, "The cluster has not been provisioned — deploy the environment first"},
		{422, "This cluster's cloud cannot mint a kubeconfig through Alethia", "", []string{"--static"}, "cannot mint a kubeconfig through Alethia"},
		{429, "Too many", "600", nil, "try again in 10m 0s"},
		{429, "Too many", "", nil, "try again in a few minutes"},
		{500, "Internal Server Error", "", nil, "Internal Server Error (status 500)"},
	}
	for _, tc := range cases {
		t.Run(fmt.Sprintf("%d%v", tc.status, tc.args), func(t *testing.T) {
			env := newKCEnv(t)
			env.console.postStatus, env.console.postMsg, env.console.retryAfter = tc.status, tc.msg, tc.retry
			args := append([]string{"cluster", "kubeconfig", "web-production", "--no-input"}, tc.args...)
			if _, err := env.run(args...); !errors.Is(err, errMiscExited) {
				t.Fatalf("want a fatal exit, got %v", err)
			}
			if !strings.Contains(env.stderr.String(), tc.want) {
				t.Errorf("stderr %q does not say %q", env.stderr, tc.want)
			}
		})
	}

	// A 422 on exec AND on the static retry is the cloud refusing both: reported once, as such.
	env := newKCEnv(t)
	env.console.postStatus, env.console.postMsg = 422, "This cluster's cloud cannot mint a kubeconfig through Alethia"
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); !errors.Is(err, errMiscExited) {
		t.Fatalf("want a fatal exit, got %v", err)
	}
	if len(env.console.posts) != 2 {
		t.Errorf("want exec then static, got %d posts", len(env.console.posts))
	}
}

// TestClusterKubeconfig_FlagRefusals: every bad flag is refused before the network.
func TestClusterKubeconfig_FlagRefusals(t *testing.T) {
	cases := map[string][]string{
		"--ttl must be whole seconds from 15m to 8h": {"--ttl", "5m"},
		"--ttl must be whole seconds":                {"--ttl", "1500500ms"},
		"takes a file path here":                     {"--output", "json"},
		"--merge=false needs":                        {"--merge=false"},
	}
	for want, extra := range cases {
		env := newKCEnv(t)
		args := append([]string{"cluster", "kubeconfig", "web-production", "--no-input"}, extra...)
		if _, err := env.run(args...); !errors.Is(err, errMiscExited) {
			t.Fatalf("%v: want a fatal exit, got %v", extra, err)
		}
		if !strings.Contains(env.stderr.String(), want) {
			t.Errorf("%v: stderr %q", extra, env.stderr)
		}
		if len(env.console.posts) != 0 {
			t.Errorf("%v: reached the network", extra)
		}
	}

	env := newKCEnv(t)
	if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input", "--merge", "--output", "f"); err == nil || errors.Is(err, errMiscExited) {
		t.Errorf("--merge with --output must be a cobra flag error, got %v", err)
	}
}

// TestClusterKubeconfig_SelectorAndSession: the selector grammar is cluster get's, and auth and
// listing failures are reported.
func TestClusterKubeconfig_SelectorAndSession(t *testing.T) {
	cases := []struct {
		name  string
		args  []string
		setup func(e *kcEnv)
		want  string
	}{
		{"no match", []string{"nope"}, nil, `no cluster matches "nope"`},
		{"ambiguous under --no-input", []string{"web"}, nil, "matches 2 clusters"},
		{"no selector under --no-input", nil, nil, "prompts are disabled"},
		{"no environment name", []string{"lone"}, func(e *kcEnv) {
			e.console.clusters = []map[string]any{{"id": kcClusterID, "cluster_name": "lone", "project_name": "lone", "environment": ""}}
		}, "a context name needs a project and an env"},
		{"cluster list fails", []string{"web-production"}, func(e *kcEnv) {
			e.console.clusters = nil
			t.Setenv("ALETHIA_WEB_ORIGIN", "http://127.0.0.1:1")
		}, "failed to fetch clusters"},
		{"signed out", []string{"web-production"}, func(e *kcEnv) {
			path, _ := getCredentialsPath()
			_ = os.Remove(path)
		}, "authentication required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newKCEnv(t)
			if tc.setup != nil {
				tc.setup(env)
			}
			args := append(append([]string{"cluster", "kubeconfig"}, tc.args...), "--no-input")
			if _, err := env.run(args...); !errors.Is(err, errMiscExited) {
				t.Fatalf("want a fatal exit, got %v", err)
			}
			if !strings.Contains(env.stderr.String(), tc.want) {
				t.Errorf("stderr %q does not say %q", env.stderr, tc.want)
			}
		})
	}
}

// TestClusterKubeconfig_InteractivePickerAndSpinner: at a terminal with no selector the picker
// opens (cluster get's), and the spinner path runs the work.
func TestClusterKubeconfig_InteractivePickerAndSpinner(t *testing.T) {
	env := newKCEnv(t)
	prevIn, prevOut, prevForm := stdinIsTTY, interactiveOutIsTTY, runHuhForm
	stdinIsTTY = func() bool { return true }
	interactiveOutIsTTY = func() bool { return true }
	var asked bool
	runHuhForm = func(...*huh.Group) error { asked = true; return nil }
	t.Cleanup(func() { stdinIsTTY, interactiveOutIsTTY, runHuhForm = prevIn, prevOut, prevForm })

	if _, err := env.run("cluster", "kubeconfig"); err != nil {
		t.Fatalf("run: %v\n%s", err, env.stderr)
	}
	if !asked {
		t.Error("the picker did not open")
	}
	if doc, _ := readKC(t, env.kubeconfig); doc.CurrentContext != kcContext {
		t.Errorf("the picker's default (the first cluster) was not used: %q", doc.CurrentContext)
	}
}

// TestClusterKubeconfig_MergeFailures: an unusable kubeconfig, a held lock and a cache that cannot
// be written each behave as stated.
func TestClusterKubeconfig_MergeFailures(t *testing.T) {
	t.Run("not a kubeconfig", func(t *testing.T) {
		env := newKCEnv(t)
		_ = os.MkdirAll(filepath.Dir(env.kubeconfig), 0o700)
		_ = os.WriteFile(env.kubeconfig, []byte("- just\n- a list\n"), 0o600)
		if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); !errors.Is(err, errMiscExited) {
			t.Fatalf("got %v", err)
		}
		if !strings.Contains(env.stderr.String(), "is not a kubeconfig") {
			t.Errorf("stderr %s", env.stderr)
		}
	})
	t.Run("locked by another writer", func(t *testing.T) {
		env := newKCEnv(t)
		_ = os.MkdirAll(filepath.Dir(env.kubeconfig), 0o700)
		_ = os.WriteFile(env.kubeconfig+".lock", nil, 0o600)
		if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); !errors.Is(err, errMiscExited) {
			t.Fatalf("got %v", err)
		}
		if !strings.Contains(env.stderr.String(), "is locked by another writer") {
			t.Errorf("stderr %s", env.stderr)
		}
		waits := 0
		for _, d := range env.sleeps {
			if d == kubeconfigLockRetry {
				waits++
			}
		}
		if waits != kubeconfigLockTries-1 {
			t.Errorf("waited %d times for the lock", waits)
		}
	})
	t.Run("cache cannot be written", func(t *testing.T) {
		env := newKCEnv(t)
		dir, _ := kubecache.DefaultDir()
		_ = os.MkdirAll(filepath.Dir(dir), 0o700)
		_ = os.WriteFile(dir, nil, 0o600) // a file where the cache dir should be
		if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); err != nil {
			t.Fatalf("a cache failure must not fail the command: %v", err)
		}
		if !strings.Contains(env.stderr.String(), "could not cache the credential") {
			t.Errorf("stderr %s", env.stderr)
		}
		if strings.Contains(env.stderr.String(), kcCanary) {
			t.Error("the warning carried the credential")
		}
	})
	t.Run("cache directory is read-only", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root writes into a read-only directory")
		}
		env := newKCEnv(t)
		c := env.cache()
		_ = os.Chmod(c.Dir(), 0o500)
		t.Cleanup(func() { _ = os.Chmod(c.Dir(), 0o700) })
		if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); err != nil {
			t.Fatalf("a cache failure must not fail the command: %v", err)
		}
		if !strings.Contains(env.stderr.String(), "could not cache the credential") {
			t.Errorf("stderr %s", env.stderr)
		}
	})
	t.Run("key generation fails", func(t *testing.T) {
		env := newKCEnv(t)
		prev := kubeGenerateKey
		kubeGenerateKey = func() (*kubeaccess.ClientKey, error) { return nil, errors.New("no entropy") }
		t.Cleanup(func() { kubeGenerateKey = prev })
		if _, err := env.run("cluster", "kubeconfig", "web-production", "--no-input"); !errors.Is(err, errMiscExited) {
			t.Fatalf("got %v", err)
		}
		if !strings.Contains(env.stderr.String(), "one-time key") {
			t.Errorf("stderr %s", env.stderr)
		}
	})
}

// TestMergeKubeconfig_Units covers the merge's edges directly: null and missing sections, a
// section of the wrong shape, an empty file, a document without apiVersion/kind, and a bad incoming.
func TestMergeKubeconfig_Units(t *testing.T) {
	incoming, err := kubeaccess.RenderExecKubeconfig(kubeaccess.Target{Project: "web", Env: "production", Server: kcServer, CAData: kcCA}, kcClusterID, "")
	if err != nil {
		t.Fatal(err)
	}

	out, err := mergeKubeconfig([]byte("# only a comment\n"), incoming, kcContext, "f")
	if err != nil || !strings.Contains(string(out), "current-context: "+kcContext) {
		t.Errorf("a comment-only file is an empty kubeconfig: %v\n%s", err, out)
	}

	out, err = mergeKubeconfig([]byte("  \n"), incoming, kcContext, "f")
	if err != nil || !bytes.Equal(out, incoming) {
		t.Errorf("an empty file yields the incoming document: %v", err)
	}

	out, err = mergeKubeconfig([]byte("clusters: null\nusers:\n- name: keep\n  user: {}\n- just-a-scalar\n"), incoming, kcContext, "f")
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	var d kcDoc
	_ = yaml.Unmarshal(out, &d)
	if d.countNamedAll(kcContext) != 3 || d.CurrentContext != kcContext {
		t.Errorf("merged:\n%s", out)
	}
	if !strings.Contains(string(out), "apiVersion: v1") || !strings.Contains(string(out), "kind: Config") || !strings.Contains(string(out), "just-a-scalar") || !strings.Contains(string(out), "name: keep") {
		t.Errorf("merged:\n%s", out)
	}

	if _, err := mergeKubeconfig([]byte("clusters: 5\n"), incoming, kcContext, "f"); err == nil || !strings.Contains(err.Error(), `"clusters" that is not a list`) {
		t.Errorf("a non-list section: %v", err)
	}
	if _, err := mergeKubeconfig([]byte("a: [\n"), incoming, kcContext, "f"); err == nil || !strings.Contains(err.Error(), "not valid YAML") {
		t.Errorf("bad YAML: %v", err)
	}
	if _, err := mergeKubeconfig([]byte("a: 1\n"), []byte("- x\n"), kcContext, "f"); err == nil {
		t.Error("an incoming document that is not a mapping must be refused")
	}
	if _, err := mergeKubeconfig([]byte("a: 1\n"), []byte("clusters: []\n"), kcContext, "f"); err == nil {
		t.Error("an incoming document without one entry per section must be refused")
	}
}

// TestRenameKubeconfig_Refusals: the runner's static file must be single-entry and complete, and a
// YAML error never quotes the document (which holds the credential).
func TestRenameKubeconfig_Refusals(t *testing.T) {
	for name, doc := range map[string]string{
		"two clusters":    "clusters: [{name: a}, {name: b}]\nusers: [{name: u}]\ncontexts: [{name: c, context: {}}]\n",
		"no context body": "clusters: [{name: a}]\nusers: [{name: u}]\ncontexts: [{name: c}]\n",
		"bad yaml":        "users: [{name: u, user: {token: " + kcCanary + "}\n",
	} {
		_, err := renameKubeconfig([]byte(doc), kcContext)
		if err == nil {
			t.Errorf("%s: want a refusal", name)
			continue
		}
		if strings.Contains(err.Error(), kcCanary) {
			t.Errorf("%s: the error quotes the credential: %v", name, err)
		}
	}
}

// TestKubeconfigMergePath reads $KUBECONFIG's first non-empty entry, then ~/.kube/config.
func TestKubeconfigMergePath(t *testing.T) {
	sep := string(os.PathListSeparator)
	t.Setenv("KUBECONFIG", sep+"/a/first"+sep+"/b/second")
	if p, _ := kubeconfigMergePath(); p != "/a/first" {
		t.Errorf("got %s", p)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("KUBECONFIG", "")
	if p, _ := kubeconfigMergePath(); p != filepath.Join(home, ".kube", "config") {
		t.Errorf("got %s", p)
	}
	t.Setenv("HOME", "")
	if _, err := kubeconfigMergePath(); err == nil {
		t.Error("no home and no KUBECONFIG must be an error")
	}
}

// TestKubeconfigWriteHelpers_Failures covers the filesystem refusals of the writers.
func TestKubeconfigWriteHelpers_Failures(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file")
	_ = os.WriteFile(file, nil, 0o600)

	if err := writeKubeconfigFile(filepath.Join(file, "sub", "kc"), []byte("x")); err == nil {
		t.Error("a directory under a file cannot be created")
	}
	if err := mergeIntoKubeconfig(filepath.Join(file, "sub", "kc"), []byte("x"), "n"); err == nil {
		t.Error("a merge target under a file cannot be created")
	}
	loop := filepath.Join(root, "loop")
	_ = os.Symlink(loop, loop)
	if _, err := resolveWriteTarget(loop); err == nil {
		t.Error("a symlink loop must not resolve")
	}
	if err := writeKubeconfigFile(loop, []byte("x")); err == nil {
		t.Error("writing through a symlink loop must fail")
	}
	if err := mergeIntoKubeconfig(loop, []byte("x"), "n"); err == nil {
		t.Error("merging through a symlink loop must fail")
	}
	// A kubeconfig path that is a directory cannot be read.
	dir := filepath.Join(root, "isdir")
	_ = os.Mkdir(dir, 0o700)
	if err := mergeIntoKubeconfig(dir, []byte("x"), "n"); err == nil || !strings.Contains(err.Error(), "read") {
		t.Errorf("a directory is not a kubeconfig: %v", err)
	}
	// A lock that cannot be created (the directory is read-only).
	if os.Geteuid() != 0 {
		ro := filepath.Join(root, "ro")
		_ = os.Mkdir(ro, 0o500)
		if _, err := lockKubeconfig(filepath.Join(ro, "config")); err == nil || errors.Is(err, os.ErrExist) {
			t.Errorf("an uncreatable lock: %v", err)
		}
	}
	// Writing to stdout is reported, and the stdout arm writes the document.
	if where, err := writeMintedKubeconfig("-", []byte(""), "n"); where != "" || err != nil {
		t.Errorf("stdout arm: %q %v", where, err)
	}
	t.Setenv("KUBECONFIG", "")
	t.Setenv("HOME", "")
	if _, err := writeMintedKubeconfig("", []byte("x"), "n"); err == nil {
		t.Error("no merge path must be an error")
	}
}

// TestClusterKubeconfig_NoInputDrawsNoSpinner: under --no-input nothing is drawn, even when stderr
// is a terminal — a script's log must not fill with spinner frames.
func TestClusterKubeconfig_NoInputDrawsNoSpinner(t *testing.T) {
	env := newKCEnv(t)
	prevOut := interactiveOutIsTTY
	interactiveOutIsTTY = func() bool { return true }
	t.Cleanup(func() { interactiveOutIsTTY = prevOut })
	_, restore := captureStderr(t)
	_, err := env.run("cluster", "kubeconfig", "web-production", "--no-input")
	drawn := restore()
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if strings.Contains(drawn, "Minting") || strings.Contains(drawn, "Fetching") {
		t.Errorf("a spinner was drawn under --no-input: %q", drawn)
	}
}
