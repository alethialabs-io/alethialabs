// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"fmt"
	"hash/fnv"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
	"github.com/alethialabs-io/alethialabs/packages/core/manifests"
	"github.com/alethialabs-io/alethialabs/packages/core/names"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The store half of docs/adr/byo-binding-db-users.md (§2, slice 2): one generated password per
// declared BYO database binding, created by tofu in the environment's secret store through the same
// `custom_secrets` path every project secret already uses. The runner writes to no cloud API here; it
// only adds entries to the tfvars it already writes.
//
// WHERE THE PASSWORD EXISTS. In the store; in tofu state, because `random_password` keeps its result
// there exactly as it does for every other `custom_secrets` entry, and the runner reads and writes that
// state through the state proxy for the duration of a run; in the binding's k8s Secret, once the BYO
// users Job (provisioner/byo_db_users.go) provisions the user and the binding resolves; and briefly in
// that Job's pod, in a Secret of its own per user. It is never in these tfvars (they carry a length and
// a charset, never a value), a manifest, the snapshot or a log line.
//
// The BYO users Job and the binding lane read these secrets. The entries are emitted only while
// the per-binding flag is on. One thing changes with the flag off, on GCP and Azure only:
// `custom_secret_keepers` is now written by the typed mapping, so it is read from the cluster, DNS and
// network provider_config alone (keepersPassthroughSources says why).

const (
	// byoDBUsersFlag is the per-binding database user flag. provisioner.byoDBUsersEnabled reads the
	// same variable; TestByoDBUserSecrets_FlagNamesMatchProvisioner keeps the two spellings equal.
	byoDBUsersFlag = "ALETHIA_BYO_DB_USERS_ENABLED"
	// keylessDBAuthFlag is the keyless per-cloud database auth flag (#722). A binding to a keyless
	// database gets no password, so it gets no entry — the same rule declaredByoBindings applies.
	keylessDBAuthFlag = "ALETHIA_KEYLESS_DB_AUTH_ENABLED"
	// byoDBUserPasswordLength is the generated password's length. The charset is alphanumeric
	// (special characters off): the BYO users Job's SQL renderer refuses any other character.
	byoDBUserPasswordLength = 32
	// byoDBUserKeeper is the rotation keeper's name. Its value is the user the password belongs to.
	byoDBUserKeeper = "user"
	// environmentIDLabel is the environment's owner label — argocd.ByoBindingOwnerLabel, which cloud
	// cannot import (argocd imports cloud). The binding lane derives the user from this value, so the
	// key here must too. Pinned equal by TestByoDBUserSecrets_OwnerLabelMatchesArgocd.
	environmentIDLabel = "alethia.io/environment-id"
	// byoChartNamespacePrefix and byoLegacyDefaultNamespace mirror argocd.ByoChartNamespace's inputs,
	// for the same import reason. Pinned by TestByoDBUserSecrets_ChartNamespaceMatchesArgocd.
	byoChartNamespacePrefix   = "byo-"
	byoLegacyDefaultNamespace = "default"
)

// ByoDBUserSecret is one declared per-binding database user and the `custom_secrets` key that holds
// its password.
type ByoDBUserSecret struct {
	// Key is manifests.ByoBindingDBSecretKey: the `custom_secrets` entry key, and so the key of the
	// tofu output `custom_secret_names` the binding resolver looks the store's name up by.
	Key string
	// User is manifests.ByoBindingDBUser, the database user the password belongs to.
	User string
}

// byoDBUsersEnabled reports whether the per-binding database user flag is on.
func byoDBUsersEnabled() bool { return os.Getenv(byoDBUsersFlag) == "true" }

// keylessDBAuthEnabled reports whether the keyless per-cloud database auth flag is on.
func keylessDBAuthEnabled() bool { return os.Getenv(keylessDBAuthFlag) == "true" }

// byoChartNamespace is argocd.ByoChartNamespace: the namespace of its own a BYO chart stored with no
// namespace (or the legacy "default") is moved to at deploy time. The move happens in the deploy's
// add-on stage, AFTER tofu, so the key must be derived from the namespace the binding WILL live in.
func byoChartNamespace(chartID string) string {
	full := byoChartNamespacePrefix + chartID
	if len(full) <= names.SlugMaxLength {
		return full
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(chartID)) // a hash.Hash never returns an error from Write
	suffix := fmt.Sprintf("%08x", h.Sum32())
	head := strings.TrimRight(full[:names.SlugMaxLength-len(suffix)-1], "-")
	return head + "-" + suffix
}

// ByoDBUserSecrets is the declared set of per-binding database users, read from the configuration
// alone — no tofu output, render or apply result enters it — so a deploy that fails half way can never
// drop a live binding's secret. Sorted by key, one entry per key.
//
// It is the database-target half of provisioner.declaredByoBindings: every add-on workload's binding
// to a database that asks for a credential facet, a keyless database excluded while the keyless flag
// is on, in the namespace the binding's ExternalSecret will live in (a BYO chart with no namespace of
// its own moves to argocd.ByoChartNamespace, as the add-on stage moves it).
//
// One difference, stated: a REFUSED BYO chart (#6439) is not excluded. Its refusal is decided by
// argocd's namespace validator and the provisioner's collision rule, and both packages import this
// one. Its entry is therefore a password nothing reads: a refused chart gets no binding ExternalSecret
// (applyByoChartBindingsExcept skips it), and the BYO users Job takes its user list from the
// provisioner's refusal-aware set (provisioner.declaredByoDBUsers), so no user is created for it
// either.
// The set errs towards a key existing too often, never towards one missing for a binding the resolver
// resolves.
//
// An environment with no ID gets no entry: its user cannot be named, and the resolver reports its
// database credential facets as unsatisfied.
func ByoDBUserSecrets(config *types.ProjectConfig) []ByoDBUserSecret {
	if config == nil {
		return nil
	}
	env := ClassificationLabels(config)[environmentIDLabel]
	if env == "" {
		return nil
	}
	keylessOn := keylessDBAuthEnabled()
	seen := map[string]bool{}
	var out []ByoDBUserSecret
	for _, a := range config.AddOns {
		ns := a.Namespace
		if a.IsByo() && (ns == "" || ns == byoLegacyDefaultNamespace) {
			ns = byoChartNamespace(a.ID)
		} else if ns == "" {
			ns = "default" // the renderer's default, so the key names the binding it creates
		}
		for _, w := range a.Workloads {
			for _, b := range w.Bindings {
				if b.Target.Kind != types.ServiceBindingKindDatabase || len(manifests.CredentialFacetNames(b)) == 0 {
					continue
				}
				if keylessOn && manifests.KeylessDBTarget(b.Target, config.Databases) {
					continue
				}
				key := manifests.ByoBindingDBSecretKey(env, ns, w.Name, b.Target)
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, ByoDBUserSecret{Key: key, User: manifests.ByoBindingDBUser(env, ns, w.Name, b.Target)})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// nonNativeSecretsProvider is the slug that switches the template's native secret store off, or ""
// when the store is on. It mirrors categories.Compose, which sets the `secrets_provider` tfvar: the
// first pluggable provider among the project's secrets is the dominant one, and it switches the native
// store off unless it is a keyless cross-account store, which is additive. Every cloud template then
// creates `custom_secrets` only when `secrets_provider == "native"`. Pinned against Compose by
// TestByoDBUserSecrets_NativeGateMatchesCompose.
func nonNativeSecretsProvider(config *types.ProjectConfig) string {
	for _, s := range config.Secrets {
		if !categories.IsPluggable(s.Provider) {
			continue
		}
		if categories.IsKeylessSecretStore(s.Provider) {
			return ""
		}
		return s.Provider
	}
	return ""
}

// ByoDBUserSecretsUnavailableReason is why no per-binding password can be stored for config, or ""
// when it can. Today the only reason is the template's native-provider gate: with a credential-based
// secrets provider (Vault, Doppler, …) every cloud template empties `custom_secrets`, so the
// per-binding key never exists and every BYO database credential facet is unsatisfied. That is safe:
// the binding resolver already reports a facet whose key is missing ("no secret for its own database
// user"), and never falls back to the administrative credential.
//
// provisioner.runByoDBUsers reads it: with a reason, the BYO users Job does not run, and the binding
// lane reports every per-binding database credential facet unsatisfied with this reason.
func ByoDBUserSecretsUnavailableReason(config *types.ProjectConfig) string {
	if config == nil {
		return ""
	}
	if slug := nonNativeSecretsProvider(config); slug != "" {
		return fmt.Sprintf("the project's secrets use the %q provider, and the environment's template stores generated passwords only with the native secrets provider, so its own database user has no password; a BYO binding is never given the administrative credential", slug)
	}
	return ""
}

// validateByoDBReservedSecretNames refuses a project secret named with the per-binding prefix, so a
// project secret and a per-binding password can never be one key. Case-insensitive, because Azure Key
// Vault secret names are.
func validateByoDBReservedSecretNames(config *types.ProjectConfig) error {
	for _, s := range config.Secrets {
		if strings.HasPrefix(strings.ToLower(s.Name), manifests.ByoDBSecretKeyPrefix) {
			return fmt.Errorf("secret %q: the name prefix %q is reserved for the per-binding database user passwords the platform generates; choose another name", s.Name, manifests.ByoDBSecretKeyPrefix)
		}
	}
	return nil
}

// byoDBSecretsShape is which `custom_secrets` object shape a template declares.
type byoDBSecretsShape int

const (
	// byoDBSecretsAWS is aws/variables.tf: `secret_name`, `length`, `special`, a per-entry `keepers`.
	byoDBSecretsAWS byoDBSecretsShape = iota
	// byoDBSecretsGCPAzure is gcp/ and azure/variables.tf: `name`, `generate`, `length`,
	// `special_chars`, with keepers in the root `custom_secret_keepers` map keyed by name.
	byoDBSecretsGCPAzure
)

// byoDBUserSecretsOn is the declared set when its passwords are to be stored on this deploy: the flag
// is on and the native store is. Nil otherwise.
func byoDBUserSecretsOn(config *types.ProjectConfig) []ByoDBUserSecret {
	if !byoDBUsersEnabled() || ByoDBUserSecretsUnavailableReason(config) != "" {
		return nil
	}
	return ByoDBUserSecrets(config)
}

// withByoDBUserSecrets returns current (the provider's `custom_secrets` list) with one generated entry
// appended per declared per-binding user, when byoDBUserSecretsOn yields any; otherwise current as it
// was. The entry carries a length and a charset, never a value: tofu generates the password.
//
// A key already in current is left alone: ValidateConfig refuses a project secret with the reserved
// prefix before a deploy, and a path that does not validate (drift, destroy) must not gain a duplicate
// for_each key it never had.
func withByoDBUserSecrets(config *types.ProjectConfig, current interface{}, shape byoDBSecretsShape) interface{} {
	users := byoDBUserSecretsOn(config)
	existing, ok := current.([]map[string]interface{})
	if len(users) == 0 || !ok {
		return current
	}
	nameKey := "secret_name"
	if shape == byoDBSecretsGCPAzure {
		nameKey = "name"
	}
	taken := map[string]bool{}
	for _, e := range existing {
		if n, ok := e[nameKey].(string); ok {
			taken[n] = true
		}
	}
	out := append([]map[string]interface{}{}, existing...)
	for _, u := range users {
		if taken[u.Key] {
			continue
		}
		if shape == byoDBSecretsAWS {
			out = append(out, map[string]interface{}{
				"secret_name": u.Key,
				"length":      byoDBUserPasswordLength,
				"special":     false,
				"keepers":     map[string]string{byoDBUserKeeper: u.User},
			})
			continue
		}
		out = append(out, map[string]interface{}{
			"name":          u.Key,
			"generate":      true,
			"length":        byoDBUserPasswordLength,
			"special_chars": false,
		})
	}
	return out
}

// keepersPassthroughSources are the provider_config maps a user's own `custom_secret_keepers` is read
// from on GCP and Azure, in the order ProviderTfvars used to merge them: the cluster's, the DNS
// zone's, the network's. The typed mapping writes the key on these two clouds now (the per-binding
// keepers), so it is reserved from the generic passthrough and read from here instead — first source
// naming it wins, as mergeProviderConfig's merge-if-absent did.
//
// The per-component carriers (a database, a cache, a NoSQL table, a registry) are not read. A reserved
// key may not be decided by one of them (TestProviderTfvars_ReservedKeysAreClosedToEveryOtherComponent),
// so a keeper map set on, say, a database's provider_config no longer reaches the plan. The cluster's
// provider_config is the passthrough this key is tested through on GCP and Azure
// (TestProviderTfvars_NodeShapeAndSecretKeepersAreReachable), but neither cloud's canvas offers it:
// the generated knob list (apps/cli/cmd/provider_config_keys.json) carries custom_secret_keepers only
// for Alibaba's cluster. On GCP and Azure it is reachable only through a hand-written provider_config.
// TestByoDBUserSecrets_KeepersPassthroughPrecedence pins each source and the order.
func keepersPassthroughSources(config *types.ProjectConfig) []map[string]any {
	return []map[string]any{config.Cluster.ProviderConfig, config.DNS.ProviderConfig, config.Network.ProviderConfig}
}

// customSecretKeepers is the `custom_secret_keepers` value for GCP and Azure: the user's own value
// from the first passthrough source naming it, extended with one keeper per declared per-binding user
// naming that user. A keeper the user set on a per-binding key is kept beside it, so a rotation handle
// the user turned still turns. ok is false when there is nothing to write — no user value and no
// per-binding user — so a project that sets neither emits no key, as before.
//
// A user value this cannot extend (not a map) is returned unchanged for the template to refuse, and
// the per-binding entries then carry no keeper.
func customSecretKeepers(config *types.ProjectConfig, sources []map[string]any) (interface{}, bool) {
	var user interface{}
	found := false
	for _, pc := range sources {
		if v, ok := pc["custom_secret_keepers"]; ok {
			user, found = v, true
			break
		}
	}
	users := byoDBUserSecretsOn(config)
	if len(users) == 0 {
		return user, found
	}
	keepers, ok := mergeableKeepers(user)
	if !ok {
		return user, true
	}
	for _, u := range users {
		k := map[string]interface{}{}
		if prev, ok := keepers[u.Key].(map[string]interface{}); ok {
			for pk, pv := range prev {
				k[pk] = pv
			}
		}
		k[byoDBUserKeeper] = u.User
		keepers[u.Key] = k
	}
	return keepers, true
}

// mergeableKeepers copies a `custom_secret_keepers` value into a map this file can extend: absent is
// an empty map, a passthrough map (JSON-decoded or typed) is copied entry by entry, and anything else
// is reported as not mergeable.
func mergeableKeepers(v interface{}) (map[string]interface{}, bool) {
	out := map[string]interface{}{}
	copyInner := func(inner interface{}) interface{} {
		c := map[string]interface{}{}
		switch im := inner.(type) {
		case map[string]interface{}:
			for ik, iv := range im {
				c[ik] = iv
			}
		case map[string]string:
			for ik, iv := range im {
				c[ik] = iv
			}
		default:
			return inner
		}
		return c
	}
	switch m := v.(type) {
	case nil:
		return out, true
	case map[string]interface{}:
		for k, inner := range m {
			out[k] = copyInner(inner)
		}
		return out, true
	case map[string]map[string]string:
		for k, inner := range m {
			out[k] = copyInner(inner)
		}
		return out, true
	}
	return nil, false
}
