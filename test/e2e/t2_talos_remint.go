// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 Talos admin-kubeconfig RE-MINT (#5339) — the PURE half. Deliberately UNTAGGED, so the mint
// order, the refusals and the keep-alive are unit-tested in every `go test ./...` with no cluster
// (t2_talos_remint_pure_test.go). The e2e_t2-tagged t2_provision_test.go wires it.
//
// # The problem
//
// A dedicated hetzner cluster's admin kubeconfig is a Talos client certificate that lasts the
// template's admin_kubeconfig_cert_lifetime — 1h since #5340. The runner re-mints one from the
// state's `talosconfig` output at every point of use. This harness runs OUTSIDE the runner: its
// post-deploy assertions, its day-2 phases, `capture-proof.sh` and its in-process teardown all read
// $HOME/.alethia/kubeconfig, the file the runner wrote last. A heavy nightly runs past the hour on
// that one certificate, and every kubectl after that gets a 401.
//
// # The fix, and what it reuses
//
// The harness mints the same way the runner does, with the runner's own code: it execs the runner
// binary it already builds, as `<runner> talos-kubeconfig` (talosconfig on stdin, kubeconfig on
// stdout). That subcommand is MintTalosKubeconfig unchanged, SSRF guard and timeout included. The
// runner's agent package is `internal` and the Talos machinery module is not a dependency of this
// one, so a process boundary is the way to call it without copying it.
//
// It re-mints at every phase boundary (t2TalosRemint.Before) and, between boundaries, whenever the
// last mint is t2TalosRemintInterval old (t2TalosRemint.Keep). The second half is needed because
// a phase can be longer than the certificate: the fabric demo alone reserves tiers×2×timeout plus
// the whole vcluster budget. The phases read the kubeconfig through a PATH, and kubectl reads that
// file on every call, so rewriting it is enough; nothing has to be threaded into the phases.
//
// The lifetime is NOT raised for e2e. That would hide the production default, and #5334's
// admin-tier expiry assertion would stop being able to see it.
//
// # Teardown
//
// The teardown re-mints before the destroy (so a cluster the destroy leaves standing hands
// `capture-proof.sh` a live credential) and passes the same minter to RunDestroy as TalosMint, so the
// load-balancer release mints its own instead of taking the documented no-minter fallback to the
// stored certificate. A mint that fails there is reported as a named failure; it never stops the
// destroy, and the workflow's scope-locked sweeper runs after it regardless.
//
// # Other clouds
//
// Unchanged, and on purpose: aws, gcp and azure kubeconfigs are exec plugins (`<runner> kube-token`)
// that mint a token on every kubectl call, and alibaba's is the ACK credential the template reads
// from alicloud_cs_cluster_credential, not a Talos certificate. Before and Keep are no-ops there.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// t2TalosKubeconfigSubcommand is the runner subcommand the harness execs to mint. The runner's
// TestHarnessTalosKubeconfigSubcommandIsDispatched reads this constant out of this file, so a rename
// on either side fails offline rather than on a paid run.
const t2TalosKubeconfigSubcommand = "talos-kubeconfig"

// t2TalosRemintProvider is the one provider whose kubeconfig is a Talos certificate.
const t2TalosRemintProvider = "hetzner"

// t2TalosRemintInterval is how old the last mint may get before the keep-alive mints again. A third
// of the template's 1h lifetime: a kubectl call always holds a certificate with at least ~40 minutes
// left, so a call in flight when the keep-alive ticks cannot outlive it either.
const t2TalosRemintInterval = 20 * time.Minute

// t2TalosRemintMaxAge is how old a minted certificate may be while the keep-alive keeps FAILING
// before the file is removed. Below the lifetime by a margin, so the harness never serves a
// certificate in its last minutes — a kubectl call then fails on a missing file, which names the
// cause, rather than on a 401 that does not.
const t2TalosRemintMaxAge = 50 * time.Minute

// t2TalosRemintTick is how often the keep-alive checks the age of the last mint.
const t2TalosRemintTick = time.Minute

// t2TalosMintAttempts and t2TalosMintRetryDelay retry one mint across a dropped Talos RPC — the same
// three tries five seconds apart the runner's deploy refresher uses (deployMintAttempts).
const (
	t2TalosMintAttempts   = 3
	t2TalosMintRetryDelay = 5 * time.Second
)

// errT2NoTalosconfig reports a state with no `talosconfig` output: nothing to mint from. After a
// successful hetzner deploy that is a failure; at a teardown after a deploy that never got that far
// it is the expected absence.
var errT2NoTalosconfig = errors.New("the state carries no talosconfig output")

// t2RunnerBinaryMinter returns a provisioner.TalosconfigMinter that execs the built runner as
// `<runnerBin> talos-kubeconfig`. The talosconfig goes in on stdin, never argv; the kubeconfig comes
// back on stdout and is never logged. The error carries the runner's stderr (bounded), which is the
// runner's own MintTalosKubeconfig error text.
func t2RunnerBinaryMinter(runnerBin string) provisioner.TalosconfigMinter {
	return func(ctx context.Context, talosconfig string) (string, error) {
		cmd := exec.CommandContext(ctx, runnerBin, t2TalosKubeconfigSubcommand)
		cmd.Stdin = strings.NewReader(talosconfig)
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			msg := strings.TrimSpace(stderr.String())
			if len(msg) > 600 {
				msg = msg[:600] + "…"
			}
			return "", fmt.Errorf("%s %s: %w: %s", filepath.Base(runnerBin), t2TalosKubeconfigSubcommand, err, msg)
		}
		kubeconfig := stdout.String()
		if strings.TrimSpace(kubeconfig) == "" {
			return "", fmt.Errorf("%s %s exited 0 with an empty kubeconfig", filepath.Base(runnerBin), t2TalosKubeconfigSubcommand)
		}
		return kubeconfig, nil
	}
}

// t2StateTalosconfig returns the `talosconfig` output of a raw tofu state. errT2NoTalosconfig when the
// state is empty or has no such output; any other error is a state that could not be read.
func t2StateTalosconfig(state []byte) (string, error) {
	if len(bytes.TrimSpace(state)) == 0 {
		return "", errT2NoTalosconfig
	}
	var st struct {
		Outputs map[string]struct {
			Value json.RawMessage `json:"value"`
		} `json:"outputs"`
	}
	if err := json.Unmarshal(state, &st); err != nil {
		return "", fmt.Errorf("parse the state: %w", err)
	}
	out, ok := st.Outputs["talosconfig"]
	if !ok {
		return "", errT2NoTalosconfig
	}
	var talosconfig string
	if err := json.Unmarshal(out.Value, &talosconfig); err != nil {
		return "", fmt.Errorf("the state's talosconfig output is not a string: %w", err)
	}
	if strings.TrimSpace(talosconfig) == "" {
		return "", errT2NoTalosconfig
	}
	return talosconfig, nil
}

// t2TalosRemint keeps the harness's kubeconfig file holding a freshly minted Talos admin certificate
// on a hetzner leg. Every method is a no-op on any other provider, and on a nil receiver.
type t2TalosRemint struct {
	provider string
	// readState returns the deploy's current raw tofu state (ControlPlane.StateSnapshot).
	readState func() []byte
	// mint is t2RunnerBinaryMinter in the harness; a fake in the unit tests.
	mint provisioner.TalosconfigMinter
	// path is the kubeconfig file the phases read (t2RunnerKubeconfigPath).
	path string
	logf func(format string, args ...any)

	// Injected so the tests neither sleep nor wait for the wall clock.
	now      func() time.Time
	sleep    func(time.Duration)
	interval time.Duration
	maxAge   time.Duration
	tick     time.Duration

	mu        sync.Mutex
	lastMint  time.Time // zero until the first successful mint
	keepStop  chan struct{}
	keepDone  chan struct{}
	keepFails bool // the keep-alive's current streak is failing (reported once per streak)
}

// newT2TalosRemint builds the re-minter for one T2 leg.
func newT2TalosRemint(provider string, readState func() []byte, mint provisioner.TalosconfigMinter, path string, logf func(string, ...any)) *t2TalosRemint {
	return &t2TalosRemint{
		provider: provider, readState: readState, mint: mint, path: path, logf: logf,
		now: time.Now, sleep: time.Sleep,
		interval: t2TalosRemintInterval, maxAge: t2TalosRemintMaxAge, tick: t2TalosRemintTick,
	}
}

// active reports whether this leg's kubeconfig is a Talos certificate that has to be re-minted.
func (r *t2TalosRemint) active() bool {
	return r != nil && r.provider == t2TalosRemintProvider
}

// Before mints a fresh admin kubeconfig into the kubeconfig file before the named phase, so the phase
// starts with a whole certificate lifetime ahead of it. On a failure the file is REMOVED and the error
// returned: the certificate in it is the one this exists to stop using, and a phase that went ahead on
// it would fail an hour later as a 401 instead of here, as a named mint failure.
func (r *t2TalosRemint) Before(ctx context.Context, phase string) error {
	if !r.active() {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.mintLocked(ctx); err != nil {
		r.discardLocked()
		return fmt.Errorf("re-mint the Talos admin kubeconfig before %s: %w", phase, err)
	}
	r.logf("talos re-mint: a fresh admin kubeconfig from the state's talosconfig is in %s before %s", r.path, phase)
	return nil
}

// Keep starts the keep-alive: until stop is called, the kubeconfig is re-minted whenever the last mint
// is r.interval old. A failure is handed to onErr once per failing streak (t.Errorf in the harness, so
// the run is red with the cause named), retried on every tick, and once the last good certificate is
// r.maxAge old the file is removed rather than served. stop is idempotent and waits for the loop.
func (r *t2TalosRemint) Keep(ctx context.Context, onErr func(error)) (stop func()) {
	if !r.active() {
		return func() {}
	}
	r.mu.Lock()
	if r.keepStop != nil {
		r.mu.Unlock()
		return r.Stop
	}
	r.keepStop = make(chan struct{})
	r.keepDone = make(chan struct{})
	stopCh, done := r.keepStop, r.keepDone
	r.mu.Unlock()

	go func() {
		defer close(done)
		t := time.NewTicker(r.tick)
		defer t.Stop()
		for {
			select {
			case <-stopCh:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				r.keepOnce(ctx, onErr)
			}
		}
	}()
	return r.Stop
}

// keepOnce is one keep-alive tick.
func (r *t2TalosRemint) keepOnce(ctx context.Context, onErr func(error)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.lastMint.IsZero() && r.now().Sub(r.lastMint) < r.interval {
		return
	}
	err := r.mintLocked(ctx)
	if err == nil {
		if r.keepFails {
			r.logf("talos re-mint (keep-alive): minting works again; %s holds a fresh admin kubeconfig", r.path)
		}
		r.keepFails = false
		return
	}
	if !r.keepFails {
		onErr(fmt.Errorf("talos re-mint (keep-alive): %w", err))
	} else {
		r.logf("talos re-mint (keep-alive): still failing: %v", err)
	}
	r.keepFails = true
	if r.lastMint.IsZero() || r.now().Sub(r.lastMint) >= r.maxAge {
		r.discardLocked()
	}
}

// Stop ends the keep-alive, if one is running, and waits for it to exit.
func (r *t2TalosRemint) Stop() {
	if r == nil {
		return
	}
	r.mu.Lock()
	stopCh, done := r.keepStop, r.keepDone
	r.keepStop = nil
	r.mu.Unlock()
	if stopCh == nil {
		return
	}
	close(stopCh)
	<-done
}

// mintLocked reads the talosconfig from the state, mints (retrying a dropped RPC) and writes the
// kubeconfig file. r.mu is held.
func (r *t2TalosRemint) mintLocked(ctx context.Context) error {
	talosconfig, err := t2StateTalosconfig(r.readState())
	if err != nil {
		return err
	}
	var kubeconfig string
	for attempt := 1; ; attempt++ {
		kubeconfig, err = r.mint(ctx, talosconfig)
		if err == nil && strings.TrimSpace(kubeconfig) == "" {
			err = errors.New("the minter returned an empty kubeconfig")
		}
		if err == nil || attempt == t2TalosMintAttempts || ctx.Err() != nil {
			break
		}
		r.sleep(t2TalosMintRetryDelay)
	}
	if err != nil {
		return err
	}
	if err := t2WriteKubeconfigAtomic(r.path, kubeconfig); err != nil {
		return fmt.Errorf("write the minted kubeconfig: %w", err)
	}
	// The process-wide KUBECONFIG names the same file, for the same reason
	// assertT2KubeconfigNodesReady sets it: RunDestroy, called in this process, reads it.
	_ = os.Setenv("KUBECONFIG", r.path)
	r.lastMint = r.now()
	return nil
}

// discardLocked removes the kubeconfig file so nothing reads a certificate the harness can no longer
// vouch for. r.mu is held.
func (r *t2TalosRemint) discardLocked() {
	if err := os.Remove(r.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		r.logf("talos re-mint: could not remove %s: %v", r.path, err)
		return
	}
	r.logf("talos re-mint: removed %s — no fresh admin kubeconfig could be minted, and the one in it is not served", r.path)
}

// t2WriteKubeconfigAtomic writes the kubeconfig 0600 through a rename, so a kubectl reading the file
// while it is replaced sees the old certificate or the new one, never half of either.
func t2WriteKubeconfigAtomic(path, kubeconfig string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".kubeconfig-remint-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) //nolint:errcheck // a no-op once the rename has happened
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.WriteString(kubeconfig); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// t2TeardownMinter wraps the minter RunDestroy's load-balancer release calls, remembering whether a
// mint FAILED there. The release reports a failed mint only inside its destroy error text, and the
// harness must name it without matching that text.
type t2TeardownMinter struct {
	mint provisioner.TalosconfigMinter
	mu   sync.Mutex
	err  error
}

// Mint is the provisioner.TalosconfigMinter handed to RunDestroy.
func (m *t2TeardownMinter) Mint(ctx context.Context, talosconfig string) (string, error) {
	kubeconfig, err := m.mint(ctx, talosconfig)
	if err == nil && strings.TrimSpace(kubeconfig) == "" {
		err = errors.New("the minter returned an empty kubeconfig")
	}
	if err != nil {
		m.mu.Lock()
		m.err = err
		m.mu.Unlock()
	}
	return kubeconfig, err
}

// Failed returns the last mint error the destroy saw, or nil.
func (m *t2TeardownMinter) Failed() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.err
}

// t2TeardownRemintLine is what the teardown reports for its pre-destroy re-mint. fail is true when the
// line must fail the test: a hetzner state that has a talosconfig and could not be minted from. A
// state with no talosconfig is a deploy that never got that far — nothing was minted, nothing is
// served, and that is not a new failure on top of the one that stopped the deploy.
func t2TeardownRemintLine(provider string, err error) (line string, fail bool) {
	switch {
	case provider != t2TalosRemintProvider:
		return "", false
	case err == nil:
		return "teardown: re-minted the Talos admin kubeconfig before the destroy (and for capture-proof.sh, should the cluster survive it)", false
	case errors.Is(err, errT2NoTalosconfig):
		return "teardown: no Talos admin kubeconfig was minted before the destroy — the state carries no talosconfig, so the deploy never got that far; no stored certificate is served", false
	default:
		return fmt.Sprintf("teardown: TALOS RE-MINT FAILED before the destroy: %v — the stale kubeconfig was removed rather than served; the destroy still runs and mints for its own load-balancer release, and the workflow's scope-locked sweeper runs after it", err), true
	}
}

// t2TeardownMintFailureLine names a mint that failed INSIDE the destroy's load-balancer release, or
// "" when none did. The release could not delete the hcloud CCM load balancers, so they may still
// bill until the workflow's scope-locked sweeper removes them.
func t2TeardownMintFailureLine(provider string, m *t2TeardownMinter) string {
	if provider != t2TalosRemintProvider || m == nil {
		return ""
	}
	if err := m.Failed(); err != nil {
		return fmt.Sprintf("teardown: TALOS MINT FAILED for the destroy's load-balancer release: %v — the CCM load balancers may still bill; the workflow's scope-locked sweeper (scripts/e2e/hcloud-cleanup.sh) runs after this test", err)
	}
	return ""
}
