// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// A dedicated hetzner cluster's admin kubeconfig is a client certificate whose lifetime is the
// cluster's `.cluster.adminKubeconfig.certLifetime` (the template's admin_kubeconfig_cert_lifetime).
// The `kubeconfig` tofu output holds ONE such certificate, minted by talos_cluster_kubeconfig during
// the apply that last touched it, so anything reading it later than that lifetime gets a 401 (#5330):
// the deploy's own post-apply stages, PROBE_CLUSTER, drift's cluster inspection and the destroy's
// load-balancer release.
//
// The same state also holds the `talosconfig` output, the Talos client credential that can mint a
// new kubeconfig on demand (`talosctl kubeconfig`). Every one of those paths now mints from it at
// the point of use, through a runner-injected TalosconfigMinter (MintTalosKubeconfig, with its SSRF
// guard), and never reads the stored certificate.

// TalosconfigMinter mints a fresh Kubernetes admin kubeconfig from a Talos client configuration (the
// `talosconfig` YAML a hetzner state carries). It is the dedicated-cluster sibling of
// TalosKubeconfigMinter: a placement has no state of its own and mints from the Fabric's PERSISTED
// talosconfig, while a dedicated job reads the talosconfig from its own state outputs and hands it
// here. The runner injects it (it holds the Talos gRPC client and the SSRF guard), so packages/core
// takes on no Talos dependency. Returns a non-nil error (never a partial kubeconfig) on failure.
type TalosconfigMinter func(ctx context.Context, talosconfig string) (kubeconfig string, err error)

// talosconfigOutputKey is the hetzner template's output carrying the Talos client configuration.
const talosconfigOutputKey = "talosconfig"

// errNoTalosMinter reports a hetzner state that carries a talosconfig with no minter wired to use it.
// In the runner that is a wiring bug; the destroy path tells it apart from a failed mint because an
// in-process caller with no runner (the e2e harness's teardown) legitimately has no minter.
var errNoTalosMinter = errors.New("this hetzner state carries a talosconfig but no Talos kubeconfig minter was wired to use it (a runner wiring bug)")

// talosAdminOutputs returns outputs with `kubeconfig` replaced by an admin kubeconfig minted NOW from
// the state's `talosconfig` output. outputs itself is never modified, so a minted credential cannot
// leak into a caller's persisted result.
//
// minted is false, with outputs returned as they are, when there is nothing to mint from: a provider
// other than hetzner (its ConfigureKubeconfig already fetches a credential per use), or a hetzner
// state with no talosconfig output — a module that is not the managed Talos template, such as the e2e
// harness's kind module, whose `kubeconfig` output is the only credential it has.
//
// A talosconfig with no minter, a failed mint or an empty kubeconfig is an error. Callers must not
// fall back to the stored kubeconfig on an error: that certificate is the one this exists to stop
// using, and a fallback would turn "the mint failed" into a quiet 401 an hour later.
func talosAdminOutputs(ctx context.Context, providerSlug string, mint TalosconfigMinter, outputs map[string]interface{}) (map[string]interface{}, bool, error) {
	if providerSlug != "hetzner" {
		return outputs, false, nil
	}
	talosconfig := argocd.ExtractOutput(outputs, talosconfigOutputKey)
	if strings.TrimSpace(talosconfig) == "" {
		return outputs, false, nil
	}
	if mint == nil {
		return nil, false, errNoTalosMinter
	}
	kubeconfig, err := mint(ctx, talosconfig)
	if err != nil {
		return nil, false, fmt.Errorf("mint a kubeconfig from the state's talosconfig: %w", err)
	}
	if strings.TrimSpace(kubeconfig) == "" {
		return nil, false, errors.New("mint a kubeconfig from the state's talosconfig: the minter returned an empty kubeconfig")
	}
	fresh := make(map[string]interface{}, len(outputs))
	for k, v := range outputs {
		fresh[k] = v
	}
	fresh["kubeconfig"] = kubeconfig
	return fresh, true, nil
}

// configureFreshKubeconfig points KUBECONFIG at the cluster for one use: on a hetzner state with a
// talosconfig it mints a new admin kubeconfig first (talosAdminOutputs), on every other state it is
// the provider's ConfigureKubeconfig exactly as before. Errors from the mint are returned as they are,
// never papered over with the stored kubeconfig.
func configureFreshKubeconfig(ctx context.Context, provider cloud.CloudProvider, vc *types.ProjectConfig, providerSlug string, mint TalosconfigMinter, outputs map[string]interface{}, stdout io.Writer) error {
	use, minted, err := talosAdminOutputs(ctx, providerSlug, mint, outputs)
	if err != nil {
		return err
	}
	if minted {
		fmt.Fprintln(stdout, "Minted a fresh Talos admin kubeconfig from the state's talosconfig.")
	}
	return provider.ConfigureKubeconfig(ctx, vc, use, stdout)
}

// deployKubeRefresher re-mints the dedicated deploy's kubeconfig before each post-apply step.
//
// WHY BEFORE EACH STEP, AND NOT ON A 401. The post-apply work reaches the cluster through dozens of
// `kubectl` subprocesses and client-go clients across the k8s and argocd packages, each reading
// KUBECONFIG itself. Re-minting on a 401 would mean wrapping every one of those transports, and a
// `kubectl apply` that dies on a 401 halfway through a manifest is not safely retryable from the
// outside anyway. Re-minting at the step boundaries instead needs one call per step, and it is sound
// under one condition the call sites keep: no single step outlasts the certificate. The longest are
// bounded by their own timeouts — WaitClusterReady and WaitPodToAPIServer 15m each, the ArgoCD install
// 20m, the add-on converge 10m — so each one starts with a whole certificate lifetime (1h on the
// managed template) ahead of it.
//
// Unconditional rather than "only when near expiry": a mint is one Talos RPC, the deploy calls this a
// handful of times, and an unconditional re-mint keeps the argument above true without reading the
// certificate's expiry back out of a kubeconfig.
//
// On every other state (no talosconfig, or not hetzner) refresh is a no-op after the first configure,
// which keeps the kubeconfig the provider wrote, exactly as before.
type deployKubeRefresher struct {
	provider     cloud.CloudProvider
	vc           *types.ProjectConfig
	providerSlug string
	mint         TalosconfigMinter
	outputs      map[string]interface{}
	stdout       io.Writer
	// sleep waits between mint attempts; a variable so tests do not wait.
	sleep func(time.Duration)
	// remints is true once the first configure minted, i.e. this state is one that must re-mint.
	remints bool
}

// deployMintAttempts is how many times a mid-deploy re-mint is tried before the deploy fails. The
// deploy has by then provisioned a cluster and may be most of an hour in, so one dropped Talos RPC
// should not throw that away; three attempts a few seconds apart cover a blip, not an outage.
const deployMintAttempts = 3

// deployMintRetryDelay is the wait between those attempts.
const deployMintRetryDelay = 5 * time.Second

// newDeployKubeRefresher builds the refresher for one dedicated deploy's post-apply stages.
func newDeployKubeRefresher(provider cloud.CloudProvider, vc *types.ProjectConfig, providerSlug string, mint TalosconfigMinter, outputs map[string]interface{}, stdout io.Writer) *deployKubeRefresher {
	return &deployKubeRefresher{
		provider: provider, vc: vc, providerSlug: providerSlug, mint: mint, outputs: outputs, stdout: stdout,
		sleep: time.Sleep,
	}
}

// configure is the deploy's initial kubeconfig: minted from the talosconfig when the state has one,
// the provider's ConfigureKubeconfig from the outputs otherwise.
func (r *deployKubeRefresher) configure(ctx context.Context) error {
	use, minted, err := r.mintWithRetry(ctx)
	if err != nil {
		return err
	}
	r.remints = minted
	if minted {
		fmt.Fprintln(r.stdout, "Minted a fresh Talos admin kubeconfig from the state's talosconfig.")
	}
	return r.provider.ConfigureKubeconfig(ctx, r.vc, use, r.stdout)
}

// refresh re-mints before the named step when this deploy's kubeconfig is a minted Talos certificate,
// and does nothing otherwise. A failure is returned: a step that would start with a credential about to
// expire is a step that fails later and less legibly.
func (r *deployKubeRefresher) refresh(ctx context.Context, step string) error {
	if !r.remints {
		return nil
	}
	use, _, err := r.mintWithRetry(ctx)
	if err != nil {
		return fmt.Errorf("re-mint the cluster's admin kubeconfig before %s: %w", step, err)
	}
	fmt.Fprintf(r.stdout, "Re-minted the Talos admin kubeconfig before %s.\n", step)
	return r.provider.ConfigureKubeconfig(ctx, r.vc, use, r.stdout)
}

// mintWithRetry is talosAdminOutputs, tried up to deployMintAttempts times. A missing minter is not
// retried: it is a wiring fact, not a blip.
func (r *deployKubeRefresher) mintWithRetry(ctx context.Context) (map[string]interface{}, bool, error) {
	var lastErr error
	for attempt := 1; attempt <= deployMintAttempts; attempt++ {
		use, minted, err := talosAdminOutputs(ctx, r.providerSlug, r.mint, r.outputs)
		if err == nil {
			return use, minted, nil
		}
		lastErr = err
		if errors.Is(err, errNoTalosMinter) || ctx.Err() != nil || attempt == deployMintAttempts {
			break
		}
		r.sleep(deployMintRetryDelay)
	}
	return nil, false, lastErr
}
