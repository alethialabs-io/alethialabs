// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import "fmt"

// Amazon ECR / ECR Public as OCI Helm registries — DELIBERATELY coming_soon, an EXPLICIT cloud-parity
// exclusion (never a silent gap). ECR authenticates with a 12-hour ephemeral token from
// `ecr get-login-password`, so there is no stable stored password a static ArgoCD repository
// credential could hold — a seeded Secret would silently expire mid-day. The keyless resolution (mint
// + refresh a short-lived token in-cluster from the connected AWS cloud connector, exactly the
// registry_keyless.go / registry-token refresher pattern the cross-account image registries use) is a
// documented follow-up. Until then these register a behavior WITHOUT repoCred so the Get() meta+
// behavior tripwire is satisfied (no "impl missing" panic) while IsHelmRegistry stays false and
// HelmRepoCredSpecs skips them — and the validate returns an explicit, honest error if one is ever
// reached in a snapshot (the console never offers a coming_soon connector as selectable).

func init() {
	comingSoon := func(name string) behavior {
		return behavior{
			validate: func(ComponentContext) error {
				return fmt.Errorf("%s (OCI Helm) is not yet supported — its keyless cloud-backed token refresh is a documented follow-up", name)
			},
			// no repoCred: no stable stored credential; see the package note above.
		}
	}
	register("helm_registry", "oci-ecr", comingSoon("Amazon ECR"))
	register("helm_registry", "oci-public-ecr", comingSoon("Amazon ECR Public"))
}
