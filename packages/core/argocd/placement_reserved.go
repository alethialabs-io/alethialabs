// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"fmt"
	"strings"
)

// The namespaces a NAMESPACE-PLACED environment may never be deployed into (#6551).
//
// A namespace placement shares the cluster of the environment that owns the Fabric (its host). Its
// hardened AppProject pins its destinations to its own namespace, so whatever else already lives in
// that namespace is inside the tenant's reach. The namespace must therefore be one the platform and
// the host do not use.
//
// ONE list, not a third copy. The platform's half is byo_reserved_namespaces.json — every group and
// every prefix a BYO chart is refused, which already carries "default" (the host's application
// namespace, provisioner.appNamespace), the ArgoCD namespace, kube-*, and the BYO database users
// namespace — plus that file's `placementPrefixes`, which a BYO chart is NOT refused (byo- is where a
// BYO chart deploys). The host's half is dynamic: the namespaces the host's own BYO charts chose. The
// console computes it from the host environment's rows and puts it on the snapshot
// (ProjectConfig.PlacementHostNamespaces); the console's attach-time copy of this rule is
// apps/console/lib/validations/placement-namespace.ts, and the parity test on the mirrored JSON keeps
// the two halves of the static list identical.

// PlacementHostNamespaceReason is the reason given for a namespace the host environment's own
// bring-your-own chart installs into.
const PlacementHostNamespaceReason = "a bring-your-own chart of the environment that owns this cluster installs there"

// PlacementNamespaceReason says why ns may not be a namespace placement's destination, or "" when it
// may be. hostNamespaces are the host environment's own namespaces (ProjectConfig.PlacementHostNamespaces).
// The order is the BYO rule's (an exact name before a prefix), then the placement-only prefixes, then
// the host's namespaces.
func PlacementNamespaceReason(ns string, hostNamespaces []string) string {
	if reason := byoReservedNamespaceReason(ns); reason != "" {
		return reason
	}
	if reason := ByoNewlyReservedNamespaceReason(ns); reason != "" {
		return reason
	}
	for _, p := range byoReserved.placementPrefixes {
		if strings.HasPrefix(ns, p.prefix) {
			return p.reason
		}
	}
	for _, h := range hostNamespaces {
		if strings.TrimSpace(h) == ns {
			return PlacementHostNamespaceReason
		}
	}
	return ""
}

// PlacementNamespaceError is the refusal for a reserved placement namespace, or nil. It names the
// namespace and the reason, and says what the operator does about it. ns must already be a valid
// DNS-1123 label (the caller checks shape first), so it is safe to echo.
func PlacementNamespaceError(ns string, hostNamespaces []string) error {
	reason := PlacementNamespaceReason(ns, hostNamespaces)
	if reason == "" {
		return nil
	}
	return fmt.Errorf("namespace %q is reserved on the host cluster: %s. A namespace-placed environment must use a namespace of its own", ns, reason)
}
