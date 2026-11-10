// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package manifests

// W5 Path A Lane 2b — resolve a BYO chart workload's W3 bindings into its Helm values at deploy.
//
// A described chart workload (project_chart_workloads) carries `bindings` (W3 ServiceBinding[]) and
// `value_paths` (logical knob → chart-values dot-path). Lane 2 (console) composed the STATIC overlay
// (replicas/env); the binding half is runtime — it needs the provision's tofu outputs and the Go
// `BindingSecretName` — so it lands here, on the runner, mirroring the first-class-service path
// (resolveBindings + writeBindingExternalSecrets in provisioner/manifests_gen.go).
//
// The contract (identical to a service binding, keyless):
//   - non-secret facet (endpoint/port/database) → a literal value, set at the value-path: from the
//     tofu outputs, or for `database` on a per-binding MySQL user, that user's own database.
//   - credential facet (username/password/connection_string) → an `existingSecret` reference
//     (BindingSecretName) set at the value-path, PLUS an ExternalSecret that materializes that k8s
//     Secret keylessly (ESO ClusterSecretStore → secretKeyRef). A plaintext credential NEVER enters
//     the chart values (the ArgoCD render marshals values verbatim).
//   - a facet whose value-path is missing, or whose keyless Secret can't be materialized (no ESO
//     store for the cloud, no provisioned master-secret output), is reported Unsatisfied — never
//     guessed, never inlined, and (for a credential) never referenced (we must not point the chart
//     at an `existingSecret` that will not exist).
//   - with ChartBindingPolicy.DBUsers set, a DATABASE credential facet reads the binding's OWN user's
//     key in the environment's secret store instead of the administrative one, and is unsatisfied
//     when that user or key does not exist (docs/adr/byo-binding-db-users.md). On MySQL that user
//     works in a database of its own, which the `database` facet names.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"text/template"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// ChartBindingResult is the resolved binding write-back for one chart workload.
type ChartBindingResult struct {
	// Patches maps a chart-values dot-path to the value to set there: an `existingSecret` name for a
	// credential facet, or a literal endpoint/port for a non-secret facet.
	Patches map[string]any
	// ExternalSecrets are the keyless ExternalSecrets to materialize (one per bound target that has
	// at least one satisfiable credential facet), rendered + applied pre-sync by the runner.
	ExternalSecrets []ExternalSecretParams
	// DBUserSecrets are the per-binding-user ExternalSecrets (docs/adr/byo-binding-db-users.md), one per
	// bound database with at least one satisfiable credential facet, when policy.DBUsers is set. A
	// database target lands here or nowhere in that mode — never in ExternalSecrets.
	DBUserSecrets []ByoDBUserSecretParams
	// Unsatisfied lists value_paths knob keys (`bind:{kind}:{name}:{facet}`) that could not be
	// resolved — surfaced honestly rather than dropped or guessed.
	Unsatisfied []string
	// UnsatisfiedReasons names WHY a knob in Unsatisfied was refused, for the refusals a
	// ChartBindingPolicy makes (keyless database, a Secret name another lane owns, no owner). A knob
	// unsatisfied for the ordinary reasons (no value-path, no keyless secret output) has no entry.
	UnsatisfiedReasons map[string]string
}

// ChartBindingPolicy carries the deploy-wide decisions the resolver must honour for credential
// facets. The zero value refuses nothing.
type ChartBindingPolicy struct {
	// KeylessDBAuth is the service lane's keyless-DB flag (manifests.Options.KeylessDBAuth). When it
	// is on, a credential facet on a database KeylessDBTarget reports as keyless is UNSATISFIED: BYO
	// bindings follow the service lane, and a keyless database target gets no password secret.
	KeylessDBAuth bool
	// CredentialRefusal, when non-empty, refuses every credential facet with this reason. The caller
	// sets it when the binding ExternalSecret could not be applied safely at all.
	CredentialRefusal string
	// TakenSecretNames are binding Secret names in this workload's namespace that another lane
	// renders (a first-class service's ExternalSecret). A BYO binding resolving to one is refused, so
	// two writers never share one object.
	TakenSecretNames map[string]bool
	// DBUsers, when non-nil, switches every DATABASE credential facet to the binding's own user
	// (docs/adr/byo-binding-db-users.md): the facet reads that user's key in the environment's secret
	// store, and the administrative output (chartCredentialSecretOutputKey) is not read at all. Nil
	// keeps the administrative path.
	DBUsers *ByoDBUsers
}

// ByoDBUsers is what one deploy knows about the per-binding database users.
type ByoDBUsers struct {
	// Environment is the environment's ID, folded into every per-binding user's identity so two
	// environments never derive the same user, even when they reach one database server. Empty
	// refuses every database credential facet: a user with no environment could not be told apart.
	Environment string
	// SecretNames maps a binding's secret key (ByoBindingDBSecretKey) to that secret's name in the
	// environment's store — the tofu output `custom_secret_names`. A key with no entry has no secret.
	SecretNames map[string]string
	// Provisioned is the set of users (ByoBindingDBUser) the BYO users Job created or confirmed on THIS
	// deploy. A binding whose user is absent is unsatisfied: the chart is never pointed at a user that
	// does not exist.
	Provisioned map[string]bool
}

// Per-binding database user identity (docs/adr/byo-binding-db-users.md §1).
const (
	// ByoDBUserPrefix starts every per-binding database user (and, on Postgres, its schema). It is
	// what keeps those users apart from the platform's own roles.
	ByoDBUserPrefix = "alethia_byo_"
	// ByoDBSecretKeyPrefix starts every per-binding `custom_secrets` key. Dashes only: an Azure Key
	// Vault secret name allows no underscore.
	ByoDBSecretKeyPrefix = "alethia-byo-db-"
	// byoDBHashLen is how many hex characters of the identity hash a name carries: 48 bits, and a user
	// name of 24 characters, inside MySQL's 32-character limit.
	byoDBHashLen = 12
)

// byoDBIdentityHash is the hash both halves of a per-binding user's identity end in. It is keyed on
// the environment and exactly the binding ExternalSecret's identity — its namespace and
// BindingSecretName — so one user exists per binding Secret per environment, and a binding the prune
// treats as the same object gets the same user.
func byoDBIdentityHash(environment, namespace, workload string, t types.ServiceBindingTarget) string {
	if namespace == "" {
		namespace = "default" // the renderer's default, so the identity names the object it creates
	}
	sum := sha256.Sum256([]byte(environment + "\x00" + namespace + "\x00" + BindingSecretName(workload, t)))
	return hex.EncodeToString(sum[:])[:byoDBHashLen]
}

// ByoBindingDBUser is the database user (and, on Postgres, the schema) of one BYO binding in
// environment: workload in namespace, bound to target. Deterministic, so every deploy and every slice
// names the same user.
func ByoBindingDBUser(environment, namespace, workload string, t types.ServiceBindingTarget) string {
	return ByoDBUserPrefix + byoDBIdentityHash(environment, namespace, workload, t)
}

// ByoBindingDBSecretKey is the `custom_secrets` key holding that user's password in the environment's
// secret store. Same hash as ByoBindingDBUser, so the user and its key cannot drift apart.
func ByoBindingDBSecretKey(environment, namespace, workload string, t types.ServiceBindingTarget) string {
	return ByoDBSecretKeyPrefix + byoDBIdentityHash(environment, namespace, workload, t)
}

// Reasons a credential facet is unsatisfied in per-binding mode.
const (
	dbUserNotProvisionedReason = "its own database user was not provisioned on this deploy; a BYO binding is never given the administrative credential"
	dbUserNoSecretReason       = "no secret for its own database user in the environment's secret store; a BYO binding is never given the administrative credential"
	dbUserFacetReason          = "facet is not available for a per-binding database user"
	dbUserNoEnvironmentReason  = "the environment has no ID, so its own database user cannot be named; a BYO binding is never given the administrative credential"
)

// keylessReason is the reported reason for a credential facet on a keyless database target.
const keylessReason = "keyless database: no password secret to bind (BYO bindings follow the service lane)"

// ChartBindingKnob is the value_paths key for one binding facet — mirrors the console's convention
// (apps/console/lib/addons/chart-overlay.ts `bindingKnob`). The two sides MUST agree on this string.
func ChartBindingKnob(kind, name, facet string) string {
	return "bind:" + kind + ":" + name + ":" + facet
}

// chartCredentialSecretOutputKey maps a bound kind to the tofu output holding its provisioned
// master-credentials secret name/ARN (the ExternalSecret's RemoteKey). Mirrors the service path's
// credentialSecretOutputKey; "" → no provisioned credential secret, so the facet is unsatisfiable.
func chartCredentialSecretOutputKey(kind string) string {
	switch kind {
	case "database":
		return "rds_master_credentials_secret_name"
	default:
		return ""
	}
}

// ResolveChartWorkloadBindings resolves a workload's bindings against the runtime tofu `outputs`,
// keyed by the workload's `valuePaths`. It never inlines a credential and never references a Secret
// that can't be materialized. `namespace` is where the ExternalSecret (and the chart) live so the
// secretKeyRef reads the same namespace.
//
// `dbs` is the project's database configs, needed only to resolve a database target's engine family
// so its `port` facet is 3306 for MySQL rather than Postgres's 5432. A BYO chart bound to MySQL would
// otherwise be handed a port it cannot connect on — the same engine-blindness the keyless lane fixed.
func ResolveChartWorkloadBindings(
	workloadName string,
	bindings []types.ServiceBinding,
	valuePaths map[string]string,
	outputs map[string]string,
	provider string,
	namespace string,
	dbs []types.ProjectDatabaseConfig,
	policy ChartBindingPolicy,
) ChartBindingResult {
	res := ChartBindingResult{Patches: map[string]any{}, UnsatisfiedReasons: map[string]string{}}
	refuse := func(knob, reason string) {
		res.Unsatisfied = append(res.Unsatisfied, knob)
		res.UnsatisfiedReasons[knob] = reason
	}

	// Accumulate satisfiable credential facets per target so one ExternalSecret carries all of them.
	type credAcc struct {
		target types.ServiceBindingTarget
		facets []string
	}
	credByTarget := map[string]*credAcc{}
	var credOrder []string
	// The same, per bound database, for the per-binding-user mode.
	type dbUserAcc struct {
		target    types.ServiceBindingTarget
		user      string
		remoteKey string
		facets    []string
	}
	dbUserByTarget := map[string]*dbUserAcc{}
	var dbUserOrder []string

	store := StoreNameFor(provider)

	for _, b := range bindings {
		for _, inj := range b.Inject {
			knob := ChartBindingKnob(string(b.Target.Kind), b.Target.Name, string(inj.From))
			path := valuePaths[knob]
			if path == "" {
				res.Unsatisfied = append(res.Unsatisfied, knob)
				continue
			}
			if IsCredentialFacet(string(inj.From)) {
				// Policy refusals come first: none of them may produce a patch or an ExternalSecret.
				// The keyless check is the service lane's own predicate (writeBindingExternalSecrets:
				// `keylessOn && KeylessDBTarget`), so the two lanes never disagree.
				if policy.KeylessDBAuth && KeylessDBTarget(b.Target, dbs) {
					refuse(knob, keylessReason)
					continue
				}
				if policy.CredentialRefusal != "" {
					refuse(knob, policy.CredentialRefusal)
					continue
				}
				if name := BindingSecretName(workloadName, b.Target); policy.TakenSecretNames[name] {
					refuse(knob, fmt.Sprintf("Secret name %q is already rendered by a first-class service in this namespace", name))
					continue
				}
				if policy.DBUsers != nil && b.Target.Kind == types.ServiceBindingKindDatabase {
					env := policy.DBUsers.Environment
					user := ByoBindingDBUser(env, namespace, workloadName, b.Target)
					remoteKey := policy.DBUsers.SecretNames[ByoBindingDBSecretKey(env, namespace, workloadName, b.Target)]
					switch {
					case env == "":
						refuse(knob, dbUserNoEnvironmentReason)
						continue
					case string(inj.From) != "username" && string(inj.From) != "password":
						refuse(knob, dbUserFacetReason)
						continue
					case !policy.DBUsers.Provisioned[user]:
						refuse(knob, dbUserNotProvisionedReason)
						continue
					case remoteKey == "":
						refuse(knob, dbUserNoSecretReason)
						continue
					case store == "":
						res.Unsatisfied = append(res.Unsatisfied, knob)
						continue
					}
					tkey := b.Target.Name
					acc, ok := dbUserByTarget[tkey]
					if !ok {
						acc = &dbUserAcc{target: b.Target, user: user, remoteKey: remoteKey}
						dbUserByTarget[tkey] = acc
						dbUserOrder = append(dbUserOrder, tkey)
					}
					acc.facets = append(acc.facets, string(inj.From))
					res.Patches[path] = BindingSecretName(workloadName, b.Target)
					continue
				}
				remoteKey := outputs[chartCredentialSecretOutputKey(string(b.Target.Kind))]
				_, hasProperty := facetProperty(provider, string(inj.From))
				// Satisfiable only if the cloud has an ESO store, the resource exported a master
				// secret, and the facet maps to a remote property. Otherwise: no patch (never point
				// the chart at a Secret that won't exist), report unsatisfied.
				if store == "" || remoteKey == "" || !hasProperty {
					res.Unsatisfied = append(res.Unsatisfied, knob)
					continue
				}
				tkey := string(b.Target.Kind) + "|" + b.Target.Name
				acc, ok := credByTarget[tkey]
				if !ok {
					acc = &credAcc{target: b.Target}
					credByTarget[tkey] = acc
					credOrder = append(credOrder, tkey)
				}
				acc.facets = append(acc.facets, string(inj.From))
				// Reference the keyless Secret at the value-path (its name == BindingSecretName).
				res.Patches[path] = BindingSecretName(workloadName, b.Target)
				continue
			}
			// Non-secret facet: a literal from the tofu outputs.
			var value string
			switch string(inj.From) {
			case "endpoint":
				value = outputs[endpointOutputKey(provider, string(b.Target.Kind))]
			case "port":
				value = defaultPort(string(b.Target.Kind), dbEngineForName(dbs, b.Target.Name))
			case "database":
				if b.Target.Kind != types.ServiceBindingKindDatabase {
					break // only a database has a name to give; unsatisfied below
				}
				// A per-binding MySQL user works in a database named after it (MySQL has no schema
				// below a database), so the chart is told that name, once the user exists. Every other
				// case — the administrative path, a keyless target, a per-binding Postgres user (which
				// works in its own schema of the environment's database) — uses the environment's
				// database. The keyless check is the credential branch's, so the two cannot disagree.
				perBindingMySQL := policy.DBUsers != nil && (!policy.KeylessDBAuth || !KeylessDBTarget(b.Target, dbs)) &&
					dbEngineForName(dbs, b.Target.Name) == engineMySQL
				if !perBindingMySQL {
					value = outputs[databaseNameOutputKey(provider)]
					break
				}
				env := policy.DBUsers.Environment
				user := ByoBindingDBUser(env, namespace, workloadName, b.Target)
				switch {
				case env == "":
					refuse(knob, dbUserNoEnvironmentReason)
					continue
				case !policy.DBUsers.Provisioned[user]:
					refuse(knob, dbUserNotProvisionedReason)
					continue
				}
				value = user
			}
			if value == "" {
				res.Unsatisfied = append(res.Unsatisfied, knob)
				continue
			}
			res.Patches[path] = value
		}
	}

	for _, tkey := range credOrder {
		acc := credByTarget[tkey]
		facets := dedupeSorted(acc.facets)
		res.ExternalSecrets = append(res.ExternalSecrets, ExternalSecretParams{
			ServiceName: workloadName,
			Namespace:   namespace,
			Target:      acc.target,
			Provider:    provider,
			RemoteKey:   outputs[chartCredentialSecretOutputKey(string(acc.target.Kind))],
			Facets:      facets,
		})
	}
	for _, tkey := range dbUserOrder {
		acc := dbUserByTarget[tkey]
		res.DBUserSecrets = append(res.DBUserSecrets, ByoDBUserSecretParams{
			ServiceName: workloadName,
			Namespace:   namespace,
			Target:      acc.target,
			Provider:    provider,
			User:        acc.user,
			RemoteKey:   acc.remoteKey,
			Facets:      dedupeSorted(acc.facets),
		})
	}
	sort.Strings(res.Unsatisfied)
	return res
}

// databaseNameOutputKey maps a provider to the tofu output holding the environment's database name —
// the outputs the bootstrap and BYO users Jobs connect with. "" → no such output, so a `database`
// facet on the administrative path is unsatisfied rather than guessed.
func databaseNameOutputKey(provider string) string {
	switch provider {
	case string(types.CloudProviderAws):
		return "rds_database_name"
	case string(types.CloudProviderGcp):
		return "cloud_sql_database"
	case string(types.CloudProviderAzure):
		return "azure_db_name"
	}
	return ""
}

// ByoDBUserSecretParams is the resolved input for one per-binding-user ExternalSecret.
type ByoDBUserSecretParams struct {
	ServiceName string
	Namespace   string
	Target      types.ServiceBindingTarget
	Provider    string
	// User is the binding's own database user (ByoBindingDBUser), written as a literal: it is not secret.
	User string
	// RemoteKey is the name of the user's password secret in the environment's store.
	RemoteKey string
	// Facets are the credential facets the binding asks for: "username" and/or "password".
	Facets []string
	// Labels are extra metadata labels, rendered as quoted strings (see quotedLabels).
	Labels map[string]string
}

// byoDBUserRe is the shape ByoBindingDBUser produces. The renderer refuses anything else, so a user
// name can never be anything but the derived one.
var byoDBUserRe = regexp.MustCompile(`^` + ByoDBUserPrefix + `[0-9a-f]{12}$`)

// byoDBUserESTmpl renders a binding Secret whose password is the binding's own user's, read from its
// own key, and whose username is that user's name. The ESO template (engine v2) writes ONLY the keys
// listed, so a binding that asks for the username alone does not receive the password. Every value
// is a double-quoted scalar (%q), and the ESO placeholder is emitted literally.
var byoDBUserESTmpl = template.Must(template.New("byodbuser").Parse(`apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: {{ .Name }}
  namespace: {{ .Namespace }}
  labels:
    app.kubernetes.io/name: {{ .Name }}
    app.kubernetes.io/managed-by: alethia
{{- range .ExtraLabels }}
    {{ .Key }}: {{ .Value }}
{{- end }}
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: {{ .StoreName }}
    kind: ClusterSecretStore
  target:
    name: {{ .Name }}
    creationPolicy: Owner
    template:
      engineVersion: v2
      data:
{{- if .Username }}
        username: {{ printf "%q" .User }}
{{- end }}
{{- if .Password }}
        password: "{{ "{{ .password }}" }}"
{{- end }}
  data:
    - secretKey: password
      remoteRef:
        key: {{ printf "%q" .RemoteKey }}
`))

// RenderByoDBUserExternalSecret renders the ExternalSecret that materializes a BYO binding's credential
// facets from its OWN database user (docs/adr/byo-binding-db-users.md §4) into the Secret named
// BindingSecretName — the same name the administrative path renders, so a chart's existingSecret
// reference does not change. It fails closed on a provider with no store, a user name that is not a
// derived one, an empty or multi-line remote key, or no username/password facet.
func RenderByoDBUserExternalSecret(p ByoDBUserSecretParams) (string, error) {
	name := BindingSecretName(p.ServiceName, p.Target)
	store := StoreNameFor(p.Provider)
	if store == "" {
		return "", fmt.Errorf("%s: no ClusterSecretStore for provider %q", name, p.Provider)
	}
	if !byoDBUserRe.MatchString(p.User) {
		return "", fmt.Errorf("%s: %q is not a per-binding database user", name, p.User)
	}
	if strings.TrimSpace(p.RemoteKey) == "" || strings.ContainsAny(p.RemoteKey, "\r\n") {
		return "", fmt.Errorf("%s: no usable secret name for user %s", name, p.User)
	}
	var username, password bool
	for _, f := range p.Facets {
		switch f {
		case "username":
			username = true
		case "password":
			password = true
		}
	}
	if !username && !password {
		return "", fmt.Errorf("%s: no username or password facet to materialize", name)
	}
	ns := p.Namespace
	if ns == "" {
		ns = "default"
	}
	var buf bytes.Buffer
	if err := byoDBUserESTmpl.Execute(&buf, struct {
		Name, Namespace, StoreName, User, RemoteKey string
		Username, Password                          bool
		ExtraLabels                                 []esLabel
	}{name, ns, store, p.User, p.RemoteKey, username, password, quotedLabels(p.Labels)}); err != nil {
		return "", fmt.Errorf("render per-binding user ExternalSecret %s: %w", name, err)
	}
	return strings.TrimSpace(buf.String()) + "\n", nil
}

// SetByPath sets `value` at a dot-path (`"a.b.c"`) inside a Helm-values map, creating intermediate
// maps. An existing non-map at an intermediate segment is replaced with a map so the leaf can be
// placed. An empty path is a no-op. Mutates and returns `m`.
func SetByPath(m map[string]any, dotPath string, value any) map[string]any {
	segments := splitPath(dotPath)
	if len(segments) == 0 {
		return m
	}
	cursor := m
	for i := 0; i < len(segments)-1; i++ {
		key := segments[i]
		next, ok := cursor[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			cursor[key] = next
		}
		cursor = next
	}
	cursor[segments[len(segments)-1]] = value
	return m
}

// splitPath splits a dot-path into non-empty segments.
func splitPath(dotPath string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(dotPath); i++ {
		if i == len(dotPath) || dotPath[i] == '.' {
			if i > start {
				out = append(out, dotPath[start:i])
			}
			start = i + 1
		}
	}
	return out
}

// dedupeSorted returns the distinct values of s, sorted, for deterministic rendering.
func dedupeSorted(s []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range s {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
