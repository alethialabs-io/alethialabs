// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"math/big"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// remintFixture is a hetzner re-minter over a fake state and a counting minter.
type remintFixture struct {
	r     *t2TalosRemint
	path  string
	mu    sync.Mutex
	calls []string // the talosconfig each mint was handed
	fail  error    // when set, every mint fails with it
	now   time.Time
	logs  []string
}

// newRemintFixture builds a fixture whose state carries talosconfig `tc` and whose kubeconfig file
// already holds `stale` (the runner's last write).
func newRemintFixture(t *testing.T, provider, tc, stale string) *remintFixture {
	t.Helper()
	t.Setenv("KUBECONFIG", "")
	f := &remintFixture{path: filepath.Join(t.TempDir(), ".alethia", "kubeconfig"), now: time.Unix(1_800_000_000, 0)}
	if stale != "" {
		if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.path, []byte(stale), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	state := tfStateWithOutputs(t, map[string]any{"talosconfig": tc, "kubeconfig": stale})
	mint := func(_ context.Context, talosconfig string) (string, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, talosconfig)
		if f.fail != nil {
			return "", f.fail
		}
		return kubeconfigWithCert(t, f.now, f.now.Add(time.Hour)), nil
	}
	f.r = newT2TalosRemint(provider, func() []byte { return state }, mint, f.path, func(format string, args ...any) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.logs = append(f.logs, format)
	})
	f.r.now = func() time.Time { f.mu.Lock(); defer f.mu.Unlock(); return f.now }
	f.r.sleep = func(time.Duration) {}
	return f
}

// mints is how many times the minter was called.
func (f *remintFixture) mints() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// advance moves the fixture clock.
func (f *remintFixture) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.now = f.now.Add(d)
}

// tfStateWithOutputs renders a minimal tofu state carrying the given outputs.
func tfStateWithOutputs(t *testing.T, outputs map[string]any) []byte {
	t.Helper()
	o := map[string]any{}
	for k, v := range outputs {
		o[k] = map[string]any{"value": v, "type": "string", "sensitive": true}
	}
	b, err := json.Marshal(map[string]any{"version": 4, "outputs": o})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// kubeconfigWithCert renders a kubeconfig whose client certificate is a real x509 certificate valid
// over [notBefore, notAfter], so a test can read the expiry of whatever ended up in the file.
func kubeconfigWithCert(t *testing.T, notBefore, notAfter time.Time) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "admin", Organization: []string{"system:masters"}},
		NotBefore: notBefore, NotAfter: notAfter,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certB64 := base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	return "apiVersion: v1\nkind: Config\nusers:\n- name: admin\n  user:\n    client-certificate-data: " + certB64 + "\n"
}

// remintCertNotAfter reads the client certificate's expiry out of a kubeconfig written by kubeconfigWithCert.
func remintCertNotAfter(t *testing.T, kubeconfig string) time.Time {
	t.Helper()
	m := regexp.MustCompile(`client-certificate-data: (\S+)`).FindStringSubmatch(kubeconfig)
	if m == nil {
		t.Fatalf("no client certificate in kubeconfig:\n%s", kubeconfig)
	}
	raw, err := base64.StdEncoding.DecodeString(m[1])
	if err != nil {
		t.Fatal(err)
	}
	blk, _ := pem.Decode(raw)
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return cert.NotAfter
}

// TestRemintReplacesAnExpiredStoredCert pins the core of #5339: the kubeconfig file holds the runner's
// last certificate, which EXPIRED 23h ago; after Before the file holds a freshly minted one, minted from
// the state's talosconfig (not the stored kubeconfig output), and KUBECONFIG names that file.
func TestRemintReplacesAnExpiredStoredCert(t *testing.T) {
	expiredAt := time.Unix(1_800_000_000, 0).Add(-23 * time.Hour)
	stale := kubeconfigWithCert(t, expiredAt.Add(-time.Hour), expiredAt)
	f := newRemintFixture(t, "hetzner", "talosconfig-yaml", stale)

	if err := f.r.Before(context.Background(), "the post-deploy assertions"); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(f.path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) == stale {
		t.Fatal("the expired stored certificate is still in the kubeconfig file")
	}
	if na := remintCertNotAfter(t, string(got)); !na.After(f.now) {
		t.Fatalf("the kubeconfig's certificate expires at %s, not after now (%s)", na, f.now)
	}
	if f.mints() != 1 || f.calls[0] != "talosconfig-yaml" {
		t.Fatalf("want one mint from the state's talosconfig, got %q", f.calls)
	}
	if os.Getenv("KUBECONFIG") != f.path {
		t.Errorf("KUBECONFIG = %q, want %q (RunDestroy in this process reads it)", os.Getenv("KUBECONFIG"), f.path)
	}
	if fi, err := os.Stat(f.path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("the minted kubeconfig must be 0600, got %v (%v)", fi.Mode().Perm(), err)
	}
}

// TestRemintFailureRemovesTheStaleCertAndIsLoud: a mint that fails must not leave the stored
// certificate in place for the phase to use. The file is removed and the error names the phase.
func TestRemintFailureRemovesTheStaleCertAndIsLoud(t *testing.T) {
	f := newRemintFixture(t, "hetzner", "talosconfig-yaml", "stale-kubeconfig")
	f.fail = errors.New("apid unreachable")

	err := f.r.Before(context.Background(), "the soak")
	if err == nil || !strings.Contains(err.Error(), "the soak") || !strings.Contains(err.Error(), "apid unreachable") {
		t.Fatalf("want an error naming the phase and the cause, got %v", err)
	}
	if _, serr := os.Stat(f.path); !errors.Is(serr, os.ErrNotExist) {
		t.Fatalf("the stale kubeconfig is still at %s after a failed mint (%v)", f.path, serr)
	}
	if f.mints() != t2TalosMintAttempts {
		t.Errorf("a failing mint was tried %d time(s), want %d", f.mints(), t2TalosMintAttempts)
	}
}

// TestRemintRefusesAStateWithoutTalosconfig: after a hetzner deploy there is nothing else to mint
// from, and the stored kubeconfig output is not a fallback.
func TestRemintRefusesAStateWithoutTalosconfig(t *testing.T) {
	f := newRemintFixture(t, "hetzner", "", "stale-kubeconfig")
	err := f.r.Before(context.Background(), "the post-deploy assertions")
	if !errors.Is(err, errT2NoTalosconfig) {
		t.Fatalf("want errT2NoTalosconfig, got %v", err)
	}
	if f.mints() != 0 {
		t.Error("nothing should be minted without a talosconfig")
	}
	if _, serr := os.Stat(f.path); !errors.Is(serr, os.ErrNotExist) {
		t.Error("the stored kubeconfig must not be left in place to be read instead")
	}
}

// TestRemintIsANoOpOffHetzner: aws/gcp/azure kubeconfigs are exec plugins minting per call and
// alibaba's is an ACK credential; the re-minter must not touch them.
func TestRemintIsANoOpOffHetzner(t *testing.T) {
	for _, p := range []string{"aws", "gcp", "azure", "alibaba"} {
		f := newRemintFixture(t, p, "talosconfig-yaml", "runner-written")
		if err := f.r.Before(context.Background(), "the soak"); err != nil {
			t.Errorf("%s: %v", p, err)
		}
		stop := f.r.Keep(context.Background(), func(err error) { t.Errorf("%s: %v", p, err) })
		stop()
		got, _ := os.ReadFile(f.path)
		if f.mints() != 0 || string(got) != "runner-written" {
			t.Errorf("%s: minted %d time(s), file now %q", p, f.mints(), got)
		}
	}
	var nilRemint *t2TalosRemint
	if err := nilRemint.Before(context.Background(), "x"); err != nil {
		t.Errorf("a nil re-minter must be a no-op, got %v", err)
	}
	nilRemint.Stop()
}

// TestRemintKeepAliveReMintsWithinAPhase: a phase longer than the certificate (the fabric demo) gets
// a new one whenever the last mint is the interval old — and not before.
func TestRemintKeepAliveReMintsWithinAPhase(t *testing.T) {
	f := newRemintFixture(t, "hetzner", "talosconfig-yaml", "")
	f.r.tick = time.Millisecond
	if err := f.r.Before(context.Background(), "the fabric demo"); err != nil {
		t.Fatal(err)
	}
	stop := f.r.Keep(context.Background(), func(err error) { t.Errorf("unexpected keep-alive failure: %v", err) })
	defer stop()

	time.Sleep(20 * time.Millisecond)
	if n := f.mints(); n != 1 {
		t.Fatalf("the keep-alive minted before the interval elapsed: %d mints", n)
	}
	f.advance(t2TalosRemintInterval)
	waitFor(t, func() bool { return f.mints() == 2 })
	stop()
	n := f.mints()
	f.advance(t2TalosRemintInterval)
	time.Sleep(20 * time.Millisecond)
	if f.mints() != n {
		t.Error("the keep-alive minted after stop")
	}
}

// TestRemintKeepAliveFailureIsLoudOnceAndNeverServesAnOldCert: a failing keep-alive is reported once
// per streak (onErr is t.Errorf in the harness), keeps retrying, and removes the file once the last
// good certificate is maxAge old rather than serving it into its last minutes.
func TestRemintKeepAliveFailureIsLoudOnceAndNeverServesAnOldCert(t *testing.T) {
	f := newRemintFixture(t, "hetzner", "talosconfig-yaml", "")
	f.r.tick = time.Millisecond
	if err := f.r.Before(context.Background(), "the soak"); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.fail = errors.New("apid unreachable")
	f.mu.Unlock()

	var mu sync.Mutex
	var reported []error
	stop := f.r.Keep(context.Background(), func(err error) { mu.Lock(); reported = append(reported, err); mu.Unlock() })
	defer stop()

	f.advance(t2TalosRemintInterval)
	waitFor(t, func() bool { return f.mints() >= 1+3*t2TalosMintAttempts })
	if _, err := os.Stat(f.path); err != nil {
		t.Fatalf("a 20-minute-old certificate is still valid and must not be removed yet: %v", err)
	}
	f.advance(t2TalosRemintMaxAge - t2TalosRemintInterval)
	waitFor(t, func() bool { _, err := os.Stat(f.path); return errors.Is(err, os.ErrNotExist) })
	stop()

	mu.Lock()
	defer mu.Unlock()
	if len(reported) != 1 || !strings.Contains(reported[0].Error(), "keep-alive") || !strings.Contains(reported[0].Error(), "apid unreachable") {
		t.Fatalf("want exactly one named keep-alive failure, got %v", reported)
	}
}

// waitFor polls cond for up to two seconds.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not reached within 2s")
}

// TestTeardownRemintLines: a mint that fails at the teardown is a named FAILURE that tells the reader
// the destroy and the sweeper still run; a state without a talosconfig is not; off hetzner says nothing.
func TestTeardownRemintLines(t *testing.T) {
	line, fail := t2TeardownRemintLine("hetzner", errors.New("apid unreachable"))
	if !fail || !strings.Contains(line, "TALOS RE-MINT FAILED") || !strings.Contains(line, "sweeper") {
		t.Errorf("a failed teardown re-mint must fail the test and name the sweeper: %v %q", fail, line)
	}
	if line, fail = t2TeardownRemintLine("hetzner", errT2NoTalosconfig); fail || line == "" {
		t.Errorf("a state with no talosconfig is reported, not failed: %v %q", fail, line)
	}
	if line, fail = t2TeardownRemintLine("hetzner", nil); fail || line == "" {
		t.Errorf("a successful re-mint is reported: %v %q", fail, line)
	}
	if line, fail = t2TeardownRemintLine("aws", errors.New("x")); fail || line != "" {
		t.Errorf("off hetzner nothing is reported: %v %q", fail, line)
	}

	m := &t2TeardownMinter{mint: func(context.Context, string) (string, error) { return "", errors.New("apid unreachable") }}
	if t2TeardownMintFailureLine("hetzner", m) != "" {
		t.Error("no failure before the destroy called the minter")
	}
	if _, err := m.Mint(context.Background(), "tc"); err == nil {
		t.Fatal("the wrapper must return the mint error to RunDestroy")
	}
	if l := t2TeardownMintFailureLine("hetzner", m); !strings.Contains(l, "TALOS MINT FAILED") || !strings.Contains(l, "hcloud-cleanup.sh") {
		t.Errorf("a mint that failed inside the destroy must be named, with the sweeper: %q", l)
	}
	empty := &t2TeardownMinter{mint: func(context.Context, string) (string, error) { return " ", nil }}
	if _, err := empty.Mint(context.Background(), "tc"); err == nil || t2TeardownMintFailureLine("hetzner", empty) == "" {
		t.Error("an empty kubeconfig is a failed mint")
	}
}

// TestStateTalosconfig reads the output out of a real-shaped state and refuses the shapes that carry none.
func TestStateTalosconfig(t *testing.T) {
	if tc, err := t2StateTalosconfig(tfStateWithOutputs(t, map[string]any{"talosconfig": "yaml"})); err != nil || tc != "yaml" {
		t.Errorf("got %q, %v", tc, err)
	}
	for name, st := range map[string][]byte{
		"empty":           nil,
		"no outputs":      []byte(`{"version":4}`),
		"blank":           tfStateWithOutputs(t, map[string]any{"talosconfig": "  "}),
		"kubeconfig only": tfStateWithOutputs(t, map[string]any{"kubeconfig": "k"}),
	} {
		if _, err := t2StateTalosconfig(st); !errors.Is(err, errT2NoTalosconfig) {
			t.Errorf("%s: want errT2NoTalosconfig, got %v", name, err)
		}
	}
	if _, err := t2StateTalosconfig([]byte("{")); err == nil || errors.Is(err, errT2NoTalosconfig) {
		t.Errorf("an unreadable state is an error, not an absence: %v", err)
	}
}

// TestRemintIntervalFitsTheTemplateLifetime ties the keep-alive's numbers to the hetzner template's
// admin_kubeconfig_cert_lifetime default, read from variables.tf: a kubectl call must always hold a
// certificate with a whole interval left, and a certificate is removed before it expires. Lowering the
// lifetime below what these assume fails here, offline.
func TestRemintIntervalFitsTheTemplateLifetime(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "infra", "templates", "project", "hetzner", "variables.tf"))
	if err != nil {
		t.Fatal(err)
	}
	block := string(src)
	start := strings.Index(block, `variable "admin_kubeconfig_cert_lifetime"`)
	if start < 0 {
		t.Fatal("variables.tf no longer declares admin_kubeconfig_cert_lifetime")
	}
	m := regexp.MustCompile(`(?m)^\s*default\s*=\s*"([^"]+)"`).FindStringSubmatch(block[start:])
	if m == nil {
		t.Fatal("admin_kubeconfig_cert_lifetime has no string default")
	}
	lifetime, err := time.ParseDuration(m[1])
	if err != nil {
		t.Fatal(err)
	}
	if worst := t2TalosRemintInterval + t2TalosRemintTick; 2*worst > lifetime {
		t.Errorf("a re-mint can be %s apart, leaving under %s of a %s certificate", worst, lifetime-worst, lifetime)
	}
	if t2TalosRemintMaxAge+t2TalosRemintTick >= lifetime {
		t.Errorf("maxAge %s (+%s tick) reaches the %s lifetime: an expired certificate could be served", t2TalosRemintMaxAge, t2TalosRemintTick, lifetime)
	}
}

// TestT2ReMintsBeforeEveryKubeconfigPhase reads TestT2RealCloudProvisioning and requires a
// remintBefore between every phase that reads the cluster through `kc` and the phase before it, and a
// re-mint plus the TalosMint hand-off before the teardown's destroy. The phases are DERIVED — every
// call taking `kc` whose callee is a runT2* phase, plus the reachability proof that produces kc — so a
// new phase added without a re-mint fails here.
func TestT2ReMintsBeforeEveryKubeconfigPhase(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "t2_provision_test.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var body *ast.BlockStmt
	for _, d := range file.Decls {
		if fn, ok := d.(*ast.FuncDecl); ok && fn.Name.Name == "TestT2RealCloudProvisioning" {
			body = fn.Body
		}
	}
	if body == nil {
		t.Fatal("TestT2RealCloudProvisioning not found")
	}

	type call struct {
		name string
		pos  token.Pos
	}
	var phases, remints []call
	var teardownRemint, destroy token.Pos
	var destroyPassesMint bool
	ast.Inspect(body, func(n ast.Node) bool {
		ce, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := ""
		switch fn := ce.Fun.(type) {
		case *ast.Ident:
			name = fn.Name
		case *ast.SelectorExpr:
			if x, ok := fn.X.(*ast.Ident); ok {
				name = x.Name + "." + fn.Sel.Name
			}
		}
		takesKC := false
		for _, a := range ce.Args {
			if id, ok := a.(*ast.Ident); ok && id.Name == "kc" {
				takesKC = true
			}
		}
		switch {
		case name == "remintBefore":
			remints = append(remints, call{name, ce.Pos()})
		case name == "assertT2KubeconfigNodesReady", strings.HasPrefix(name, "runT2") && takesKC:
			phases = append(phases, call{name, ce.Pos()})
		case name == "remint.Before" && len(ce.Args) == 2:
			if lit, ok := ce.Args[1].(*ast.BasicLit); ok && strings.Contains(lit.Value, "teardown") {
				teardownRemint = ce.Pos()
			}
		case name == "teardownT2Cluster":
			destroy = ce.Pos()
			for _, a := range ce.Args {
				if se, ok := a.(*ast.SelectorExpr); ok && se.Sel.Name == "Mint" {
					destroyPassesMint = true
				}
			}
		}
		return true
	})
	if len(phases) < 8 {
		t.Fatalf("found only %d kubeconfig phases (%v) — the derivation is not reading the test", len(phases), phases)
	}
	prev := body.Pos()
	for _, p := range phases {
		ok := false
		for _, r := range remints {
			if r.pos > prev && r.pos < p.pos {
				ok = true
			}
		}
		if !ok {
			t.Errorf("%s at %s has no remintBefore since the previous phase — it would start on that phase's certificate",
				p.name, fset.Position(p.pos))
		}
		prev = p.pos
	}
	if destroy == 0 || teardownRemint == 0 || teardownRemint > destroy {
		t.Error("the teardown must re-mint (remint.Before(…, \"the teardown\")) before teardownT2Cluster")
	}
	if !destroyPassesMint {
		t.Error("teardownT2Cluster must be handed the teardown minter, or RunDestroy falls back to the stored certificate")
	}
}

// TestRunnerBinaryMinterExecsTheSubcommand drives t2RunnerBinaryMinter against a stand-in binary: the
// talosconfig reaches it on stdin and NOT on argv, its only argument is the subcommand, its stdout is
// the kubeconfig, and a non-zero exit comes back as an error carrying its stderr.
func TestRunnerBinaryMinterExecsTheSubcommand(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "alethia-runner")
	script := "#!/bin/sh\n" +
		"[ \"$#\" -eq 1 ] && [ \"$1\" = \"" + t2TalosKubeconfigSubcommand + "\" ] || { echo \"bad argv: $*\" >&2; exit 2; }\n" +
		"in=$(cat)\n" +
		"[ \"$in\" = \"good-talosconfig\" ] || { echo \"talos kubeconfig mint: refused\" >&2; exit 1; }\n" +
		"printf 'apiVersion: v1\\nkind: Config\\n'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	mint := t2RunnerBinaryMinter(bin)

	kc, err := mint(context.Background(), "good-talosconfig")
	if err != nil {
		t.Fatal(err)
	}
	if kc != "apiVersion: v1\nkind: Config\n" {
		t.Errorf("kubeconfig = %q, want the binary's stdout", kc)
	}
	_, err = mint(context.Background(), "other")
	if err == nil || !strings.Contains(err.Error(), "talos kubeconfig mint: refused") {
		t.Errorf("a failed mint must carry the runner's stderr, got %v", err)
	}

	empty := filepath.Join(dir, "empty-runner")
	if err := os.WriteFile(empty, []byte("#!/bin/sh\ncat >/dev/null\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := t2RunnerBinaryMinter(empty)(context.Background(), "x"); err == nil {
		t.Error("a runner that exits 0 with no kubeconfig must be an error")
	}
}
