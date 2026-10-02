// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	talosclient "github.com/siderolabs/talos/pkg/machinery/client"
	talosconfig "github.com/siderolabs/talos/pkg/machinery/client/config"

	"github.com/alethialabs-io/alethialabs/packages/core/provisioner"
)

// Hetzner-talos placement kube access (#1389). Talos exposes NO cloud API to re-mint kube access (unlike
// EKS/GKE/AKS/ACK), so a namespace/vcluster placement onto an existing Talos Fabric cannot resolve a
// kubeconfig by cluster name. Instead the Fabric's admin talosconfig is persisted (encrypted) at Fabric
// creation and delivered on the placement job's claim; this mints a FRESH kubeconfig from it per placement
// via the Talos machine API (apid, mTLS on :50000) — the equivalent of `talosctl kubeconfig`, entirely
// keyless w.r.t. the cloud.
//
// The minter is injected into DeployParams.TalosKubeconfig (provisioner seam), and packages/core's
// mintClusterOutputs hands the result to hetznerProvider.ConfigureKubeconfig under the `kubeconfig` key —
// so no Talos gRPC dependency leaks into packages/core (parity with how the gcp/azure resolvers keep those
// SDKs runner-side).

// talosMintTimeout bounds the Talos apid dial + Kubeconfig RPC so a wedged/unreachable control plane fails
// the placement honestly rather than hanging the job.
const talosMintTimeout = 45 * time.Second

// MintTalosKubeconfig connects to a Talos control-plane apid over mTLS using the admin talosconfig and
// returns a fresh, ready-to-use Kubernetes kubeconfig (embedded CA + admin client cert/key). It uses the
// endpoints EMBEDDED in the talosconfig (those addresses are in the apid cert SANs, so mTLS verification
// holds); the port :50000 is appended automatically by the client. Each call mints a fresh admin cert
// (rotates on re-fetch); its lifetime is the cluster's `.cluster.adminKubeconfig.certLifetime` (the Talos
// template pins this LOW so placement kubeconfigs are short-lived).
func MintTalosKubeconfig(ctx context.Context, talosconfigYAML string) ([]byte, error) {
	if strings.TrimSpace(talosconfigYAML) == "" {
		return nil, fmt.Errorf("talos kubeconfig mint: empty talosconfig (the Fabric has no persisted admin credential)")
	}
	cfg, err := talosconfig.FromString(talosconfigYAML)
	if err != nil {
		return nil, fmt.Errorf("talos kubeconfig mint: parse talosconfig: %w", err)
	}
	// SSRF guard (runner-parent-ssrf rule): the endpoints come from a persisted talosconfig, which for a
	// BYO-IaC hetzner Fabric could be customer-influenced. Refuse to dial a link-local/loopback address
	// from the (trusted) runner — 169.254.169.254 (cloud metadata) is link-local, so this blocks the
	// metadata-SSRF vector. RFC-1918 is deliberately allowed (a self-hosted runner legitimately reaches a
	// private control-plane on its own network); the boundary that matters here is link-local + loopback.
	if err := assertSafeTalosEndpoints(cfg); err != nil {
		return nil, fmt.Errorf("talos kubeconfig mint: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, talosMintTimeout)
	defer cancel()

	// WithConfig uses the endpoints in the talosconfig's active context (control-plane IPs in the apid
	// cert SANs) — do NOT override with WithEndpoints (an off-SAN address would break mTLS verification).
	c, err := talosclient.New(ctx,
		talosclient.WithConfig(cfg),
		talosclient.WithContextName(cfg.Context),
	)
	if err != nil {
		return nil, fmt.Errorf("talos kubeconfig mint: build client: %w", err)
	}
	defer c.Close() //nolint:errcheck // best-effort close of a short-lived gRPC client

	kubeconfig, err := c.Kubeconfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("talos kubeconfig mint: fetch kubeconfig from apid: %w", err)
	}
	if len(strings.TrimSpace(string(kubeconfig))) == 0 {
		return nil, fmt.Errorf("talos kubeconfig mint: apid returned an empty kubeconfig")
	}
	return kubeconfig, nil
}

// assertSafeTalosEndpoints rejects a talosconfig whose active-context endpoints resolve to a link-local
// (incl. the 169.254.169.254 cloud-metadata address), loopback, or unspecified address — the SSRF vectors
// a customer-influenced (BYO-IaC) talosconfig could point the trusted runner at. It resolves hostnames so
// the check is on the RESOLVED ip (per the runner-parent-ssrf rule). RFC-1918/private is allowed.
func assertSafeTalosEndpoints(cfg *talosconfig.Config) error {
	ctxCfg, ok := cfg.Contexts[cfg.Context]
	if !ok || ctxCfg == nil {
		return fmt.Errorf("talosconfig has no active context %q", cfg.Context)
	}
	if len(ctxCfg.Endpoints) == 0 {
		return fmt.Errorf("talosconfig context %q carries no endpoints", cfg.Context)
	}
	for _, ep := range ctxCfg.Endpoints {
		host := ep
		if h, _, splitErr := net.SplitHostPort(ep); splitErr == nil {
			host = h
		}
		var ips []net.IP
		if ip := net.ParseIP(host); ip != nil {
			ips = []net.IP{ip}
		} else {
			resolved, err := net.LookupIP(host)
			if err != nil {
				return fmt.Errorf("talos endpoint %q does not resolve: %w", ep, err)
			}
			ips = resolved
		}
		for _, ip := range ips {
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
				return fmt.Errorf("talos endpoint %q resolves to disallowed address %s (link-local/loopback) — refusing to dial from the runner (SSRF guard)", ep, ip)
			}
		}
	}
	return nil
}

// newTalosKubeconfigMinter returns the provisioner.TalosKubeconfigMinter for a hetzner placement job,
// closing over the Fabric's admin talosconfig (decrypted by the console, fetched over the job channel). The
// config/clusterName the seam passes are unused — the talosconfig alone identifies + reaches the cluster —
// but kept in the signature so the seam is uniform across clouds. Returns nil when the job carries no
// talosconfig. executeDeploy refuses a hetzner placement with no talosconfig before the stage runs
// (fetchPlacementTalosconfig), so a nil minter reaching mintClusterOutputs really is a wiring bug.
func newTalosKubeconfigMinter(talosconfigYAML string) provisioner.TalosKubeconfigMinter {
	if strings.TrimSpace(talosconfigYAML) == "" {
		return nil
	}
	return func(ctx context.Context, _ *types.ProjectConfig, _ string) (string, error) {
		kubeconfig, err := MintTalosKubeconfig(ctx, talosconfigYAML)
		if err != nil {
			return "", err
		}
		return string(kubeconfig), nil
	}
}

// mintFromTalosconfig is the provisioner.TalosconfigMinter for a DEDICATED hetzner job (#5330): the
// deploy, PROBE_CLUSTER, drift's cluster inspection and the destroy's load-balancer release. Unlike a
// placement, which mints from the Fabric's persisted talosconfig, a dedicated job reads the talosconfig
// from its own state outputs and hands it here, so the job never uses the `kubeconfig` output's stored
// certificate, which expires after the cluster's admin_kubeconfig_cert_lifetime. It is
// MintTalosKubeconfig, so the same SSRF guard and timeout apply; the kubeconfig stays in this process.
func mintFromTalosconfig(ctx context.Context, talosconfigYAML string) (string, error) {
	kubeconfig, err := MintTalosKubeconfig(ctx, talosconfigYAML)
	if err != nil {
		return "", err
	}
	return string(kubeconfig), nil
}

// maxTalosconfigStdinBytes bounds what the `talos-kubeconfig` subcommand reads. It mirrors the
// console's MAX_TALOSCONFIG_BYTES (apps/console/app/api/jobs/[id]/talosconfig/route.ts), the largest
// talosconfig the platform accepts anywhere, so the subcommand takes nothing the runner would refuse.
const maxTalosconfigStdinBytes = 128 * 1024

// RunTalosKubeconfig is the `talos-kubeconfig` subcommand: it reads a Talos client configuration on
// stdin and writes a freshly minted admin kubeconfig to stdout. It is MintTalosKubeconfig, unchanged,
// behind a process boundary: the same SSRF guard, the same 45s timeout, the same refusals.
//
// It exists for the T2 e2e harness (#5339), which runs outside the runner and cannot import this
// package (it is `internal`, and the harness module carries no Talos dependency). The harness execs
// the runner binary it already builds, so its re-mints run the runner's code rather than a copy.
//
// It holds no runner credential and adds no capability: whoever can hand it a talosconfig can already
// mint with `talosctl kubeconfig`. The talosconfig is read from stdin and never from argv, so it does
// not appear in a process listing; any argument is refused for that reason.
func RunTalosKubeconfig(ctx context.Context, args []string) error {
	return runTalosKubeconfig(ctx, args, os.Stdin, os.Stdout, MintTalosKubeconfig)
}

// runTalosKubeconfig is RunTalosKubeconfig with its streams and minter injected, so the refusals are
// testable without a Talos control plane.
func runTalosKubeconfig(ctx context.Context, args []string, in io.Reader, out io.Writer, mint func(context.Context, string) ([]byte, error)) error {
	if len(args) != 0 {
		return fmt.Errorf("talos-kubeconfig takes no arguments (got %d): the talosconfig is read from stdin so it never appears in a process listing", len(args))
	}
	raw, err := io.ReadAll(io.LimitReader(in, maxTalosconfigStdinBytes+1))
	if err != nil {
		return fmt.Errorf("talos-kubeconfig: read the talosconfig from stdin: %w", err)
	}
	if len(raw) > maxTalosconfigStdinBytes {
		return fmt.Errorf("talos-kubeconfig: the talosconfig on stdin exceeds %d bytes", maxTalosconfigStdinBytes)
	}
	kubeconfig, err := mint(ctx, string(raw))
	if err != nil {
		return err
	}
	if _, err := out.Write(kubeconfig); err != nil {
		return fmt.Errorf("talos-kubeconfig: write the kubeconfig to stdout: %w", err)
	}
	return nil
}
