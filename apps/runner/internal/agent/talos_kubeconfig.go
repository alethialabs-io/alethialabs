// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"fmt"
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

// newTalosKubeconfigMinter returns the provisioner.TalosKubeconfigMinter for a hetzner placement job,
// closing over the job's DECRYPTED admin talosconfig (delivered on the claim, decrypted at claim). The
// config/clusterName the seam passes are unused — the talosconfig alone identifies + reaches the cluster —
// but kept in the signature so the seam is uniform across clouds. Returns nil when the job carries no
// talosconfig (a hetzner placement then fails closed in mintClusterOutputs with a wiring-bug error).
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
