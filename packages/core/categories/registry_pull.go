// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package categories

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// registryPullSecretNamespace is the namespace the pull Secret is seeded into. It is the app
// namespace — pinned to "default" by manifests.App.normalize + manifests/keyless.go — the same
// namespace #1007 attaches the secret in (manifests.Options.ImagePullSecrets on each app pod).
const registryPullSecretNamespace = "default"

// RegistryPullSecret is the runner-seeded dockerconfigjson imagePullSecret for the project's
// dominant pluggable registry. The runner applies it post-apply via argocd.EnsureRegistryPullSecret.
type RegistryPullSecret struct {
	Name             string // "<slug>-pull" — kept in lockstep with DominantRegistryPullSecret
	Namespace        string // registryPullSecretNamespace
	DockerConfigJSON string // the ".dockerconfigjson" payload
}

// DominantRegistryPullSecretSpec builds the imagePullSecret the runner seeds post-apply for the
// project's selected pluggable container registry, or nil when the registry is native/none. The
// name matches DominantRegistryPullSecret (which #1007 attaches to app pods + this build prunes on).
// Credentials come from vc.ConnectorCredentialFor — decrypted, attached at claim, never on the
// config snapshot; they are used only to build the Secret payload, never logged.
func DominantRegistryPullSecretSpec(vc *types.ProjectConfig) (*RegistryPullSecret, error) {
	slug, items := dominantProvider(registryItems(vc), io.Discard, "registry")
	if !IsPluggable(slug) {
		return nil, nil
	}
	p, err := Get("registry", slug)
	if err != nil {
		return nil, err
	}
	ctx := ComponentContext{
		Project:     vc,
		Credentials: vc.ConnectorCredentialFor("registry", slug),
		Items:       items,
	}
	if err := p.Validate(ctx); err != nil {
		return nil, fmt.Errorf("registry/%s validation failed: %w", slug, err)
	}
	host, user, pass, ok := p.PullAuth(ctx)
	if !ok {
		return nil, fmt.Errorf("registry provider %q has no pull-auth mapping", slug)
	}
	return &RegistryPullSecret{
		Name:             slug + "-pull",
		Namespace:        registryPullSecretNamespace,
		DockerConfigJSON: buildDockerConfigJSON(host, user, pass),
	}, nil
}

// buildDockerConfigJSON renders the ".dockerconfigjson" payload for a single registry host — the
// same shape the old in-tofu module built (`{auths:{host:{username,password,auth:b64(user:pass)}}}`).
func buildDockerConfigJSON(host, username, password string) string {
	doc := map[string]any{
		"auths": map[string]any{
			host: map[string]any{
				"username": username,
				"password": password,
				"auth":     base64.StdEncoding.EncodeToString([]byte(username + ":" + password)),
			},
		},
	}
	b, _ := json.Marshal(doc) // marshaling a map[string]any of strings cannot fail
	return string(b)
}
