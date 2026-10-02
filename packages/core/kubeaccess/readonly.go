// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The read-only tier (#5250 decision 7): ONE Kubernetes-native mechanism on all five clouds. The
// runner, holding the cluster's cloud-native admin credential, ensures a ServiceAccount bound to a
// ClusterRole that can read and cannot write or read Secrets, then mints a token for it through the
// TokenRequest API with expirationSeconds = the requested TTL. Revocation is deleting the
// ServiceAccount (every token it ever issued stops validating) or its binding (they stop granting).
//
// The five endpoints this file touches, and nothing else:
//
//	PATCH  /api/v1/namespaces/{ns}                                          (server-side apply)
//	PATCH  /api/v1/namespaces/{ns}/serviceaccounts/{sa}                     (server-side apply)
//	PATCH  /apis/rbac.authorization.k8s.io/v1/clusterroles/{name}           (server-side apply)
//	PATCH  /apis/rbac.authorization.k8s.io/v1/clusterrolebindings/{name}    (server-side apply)
//	POST   /api/v1/namespaces/{ns}/serviceaccounts/{sa}/token               (TokenRequest)
//
// plus GET and DELETE on the ServiceAccount and binding for revocation.

const (
	// ReadOnlyClusterRole is the ClusterRole every read-only credential is bound to.
	ReadOnlyClusterRole = "alethia:view"
	// DefaultReadOnlyNamespace is where the read-only ServiceAccount lives. The platform installs no
	// other in-cluster namespace of its own, so this one is created for the purpose.
	DefaultReadOnlyNamespace = "alethia-system"
	// DefaultReadOnlyServiceAccount is the ServiceAccount the read-only tier mints tokens for.
	DefaultReadOnlyServiceAccount = "alethia-view"
	// ManagedByLabel and ManagedByValue mark every object this tier creates, so revocation (and an
	// operator with kubectl) can find exactly those objects: `-l app.kubernetes.io/managed-by=alethia`.
	ManagedByLabel = "app.kubernetes.io/managed-by"
	// ManagedByValue is the value of ManagedByLabel on every object this tier creates.
	ManagedByValue = "alethia"
	// FieldManager is the server-side-apply field manager this tier writes as.
	FieldManager = "alethia"
)

// expiryExtensionTolerance is how far past now+TTL a server's reported token expiry may land before
// it is treated as an extension rather than clock skew between the runner and the API server.
const expiryExtensionTolerance = 5 * time.Minute

// dnsLabel is a Kubernetes namespace / ServiceAccount name (RFC 1123 label).
var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)

// ReadOnlyOptions names where the read-only identity lives. The zero value means the defaults.
// It exists so a per-user identity later is "one ServiceAccount per user" (decision 7), not a fork.
type ReadOnlyOptions struct {
	// Namespace defaults to DefaultReadOnlyNamespace.
	Namespace string
	// ServiceAccount defaults to DefaultReadOnlyServiceAccount.
	ServiceAccount string
}

// resolved returns opts with defaults filled in, or an error for a name Kubernetes would refuse.
func (o ReadOnlyOptions) resolved() (ReadOnlyOptions, error) {
	if o.Namespace == "" {
		o.Namespace = DefaultReadOnlyNamespace
	}
	if o.ServiceAccount == "" {
		o.ServiceAccount = DefaultReadOnlyServiceAccount
	}
	if !dnsLabel.MatchString(o.Namespace) {
		return o, fmt.Errorf("%w: namespace %q is not a DNS-1123 label", ErrKubeAPI, o.Namespace)
	}
	if !dnsLabel.MatchString(o.ServiceAccount) {
		return o, fmt.Errorf("%w: service account %q is not a DNS-1123 label", ErrKubeAPI, o.ServiceAccount)
	}
	return o, nil
}

// BindingName is the ClusterRoleBinding that grants ReadOnlyClusterRole to opts' ServiceAccount.
// It is namespace-qualified so two namespaces' identically named ServiceAccounts cannot collide.
func (o ReadOnlyOptions) BindingName() string {
	r, _ := o.resolved()
	return ReadOnlyClusterRole + ":" + r.Namespace + ":" + r.ServiceAccount
}

// PolicyRule is one RBAC rule, the rbac.authorization.k8s.io/v1 wire shape.
type PolicyRule struct {
	APIGroups       []string `json:"apiGroups"`
	Resources       []string `json:"resources"`
	Verbs           []string `json:"verbs"`
	ResourceNames   []string `json:"resourceNames,omitempty"`
	NonResourceURLs []string `json:"nonResourceURLs,omitempty"`
}

// readVerbs is the only verb set the read-only role grants.
var readVerbs = []string{"get", "list", "watch"}

// ReadOnlyRules returns the rules of ReadOnlyClusterRole: the built-in `view` role's rules written
// out EXPLICITLY, plus nodes, namespaces and events. It is deliberately not an aggregationRule over
// `view`: a cluster whose operators aggregate extra rules into `view` (any ClusterRole labelled
// rbac.authorization.k8s.io/aggregate-to-view) would otherwise widen this role silently.
//
// `view` itself grants no Secrets and no proxy/exec/attach/portforward subresources; neither does
// this. A fresh slice is returned on every call, so a caller cannot mutate the role.
func ReadOnlyRules() []PolicyRule {
	rule := func(group string, resources ...string) PolicyRule {
		return PolicyRule{APIGroups: []string{group}, Resources: resources, Verbs: append([]string(nil), readVerbs...)}
	}
	return []PolicyRule{
		// `view`, core group.
		rule("", "configmaps", "endpoints", "persistentvolumeclaims", "persistentvolumeclaims/status",
			"pods", "replicationcontrollers", "replicationcontrollers/scale", "serviceaccounts",
			"services", "services/status"),
		rule("", "bindings", "events", "limitranges", "namespaces/status", "pods/log", "pods/status",
			"replicationcontrollers/status", "resourcequotas", "resourcequotas/status"),
		// `view` grants namespaces; decision 7 names it again, with nodes, which `view` lacks.
		rule("", "namespaces", "nodes"),
		rule("discovery.k8s.io", "endpointslices"),
		rule("apps", "controllerrevisions", "daemonsets", "daemonsets/status", "deployments",
			"deployments/scale", "deployments/status", "replicasets", "replicasets/scale",
			"replicasets/status", "statefulsets", "statefulsets/scale", "statefulsets/status"),
		rule("autoscaling", "horizontalpodautoscalers", "horizontalpodautoscalers/status"),
		rule("batch", "cronjobs", "cronjobs/status", "jobs", "jobs/status"),
		rule("extensions", "daemonsets", "daemonsets/status", "deployments", "deployments/scale",
			"deployments/status", "ingresses", "ingresses/status", "networkpolicies", "replicasets",
			"replicasets/scale", "replicasets/status", "replicationcontrollers/scale"),
		rule("policy", "poddisruptionbudgets", "poddisruptionbudgets/status"),
		rule("networking.k8s.io", "ingresses", "ingresses/status", "networkpolicies"),
		// events.k8s.io is where `kubectl events` reads; `view` grants only the core-group events.
		rule("events.k8s.io", "events"),
	}
}

// objectMeta is the slice of ObjectMeta this tier writes and reads.
type objectMeta struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
	UID       string            `json:"uid,omitempty"`
}

// managedLabels is the label set on every object this tier applies.
func managedLabels() map[string]string { return map[string]string{ManagedByLabel: ManagedByValue} }

// typeMeta is apiVersion + kind.
type typeMeta struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
}

// clusterRole is the applied and returned ClusterRole. AggregationRule is decoded only so a
// response carrying one (another field manager added it) is refused.
type clusterRole struct {
	typeMeta
	Metadata        objectMeta   `json:"metadata"`
	Rules           []PolicyRule `json:"rules"`
	AggregationRule any          `json:"aggregationRule,omitempty"`
}

// roleRef is a binding's role reference.
type roleRef struct {
	APIGroup string `json:"apiGroup"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
}

// subject is a binding subject.
type subject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	APIGroup  string `json:"apiGroup,omitempty"`
}

// clusterRoleBinding is the applied and returned binding.
type clusterRoleBinding struct {
	typeMeta
	Metadata objectMeta `json:"metadata"`
	RoleRef  roleRef    `json:"roleRef"`
	Subjects []subject  `json:"subjects"`
}

// serviceAccount is the applied ServiceAccount.
type serviceAccount struct {
	typeMeta
	Metadata                     objectMeta `json:"metadata"`
	AutomountServiceAccountToken *bool      `json:"automountServiceAccountToken,omitempty"`
}

// namespace is the applied Namespace.
type namespace struct {
	typeMeta
	Metadata objectMeta `json:"metadata"`
}

// tokenRequest is authentication.k8s.io/v1 TokenRequest, both directions.
type tokenRequest struct {
	typeMeta
	Spec struct {
		Audiences         []string `json:"audiences,omitempty"`
		ExpirationSeconds int64    `json:"expirationSeconds"`
	} `json:"spec"`
	Status struct {
		Token               string `json:"token"`
		ExpirationTimestamp string `json:"expirationTimestamp"`
	} `json:"status"`
}

// Paths, one place. Names are path-escaped; `alethia:view` keeps its colon, which a path segment allows.
const (
	rbacPrefix  = "/apis/rbac.authorization.k8s.io/v1"
	applyType   = "application/apply-patch+yaml"
	applyParams = "?fieldManager=" + FieldManager + "&force=true"
)

// namespacePath is the Namespace object path.
func namespacePath(ns string) string { return "/api/v1/namespaces/" + url.PathEscape(ns) }

// serviceAccountPath is the ServiceAccount object path.
func serviceAccountPath(ns, sa string) string {
	return namespacePath(ns) + "/serviceaccounts/" + url.PathEscape(sa)
}

// clusterRolePath is the ClusterRole object path.
func clusterRolePath(name string) string { return rbacPrefix + "/clusterroles/" + url.PathEscape(name) }

// clusterRoleBindingPath is the ClusterRoleBinding object path.
func clusterRoleBindingPath(name string) string {
	return rbacPrefix + "/clusterrolebindings/" + url.PathEscape(name)
}

// apply server-side-applies obj at path as FieldManager with force, decoding the result into out.
// Force takes ownership of every field this tier sets, so a second run overwrites drift (a rule
// someone added, a subject someone swapped) instead of conflicting with it.
func apply(ctx context.Context, kube KubeAPI, path string, obj, out any) error {
	return call(ctx, kube, http.MethodPatch, path+applyParams, applyType, obj, out)
}

// EnsureReadOnlyAccess makes the read-only identity exist, exactly once, however many times it runs:
// the Namespace, the ServiceAccount (automountServiceAccountToken: false — it is a remote identity,
// never a pod's), the ReadOnlyClusterRole with exactly ReadOnlyRules, and a binding of the one to the
// other. Every object is server-side applied and labelled ManagedByLabel=ManagedByValue.
//
// After applying, it checks what the SERVER now holds, not what it sent: a ClusterRole whose rules
// differ (or that carries an aggregationRule another manager added) and a binding whose roleRef or
// subjects differ are refused. A binding whose roleRef points elsewhere cannot be changed in place
// (roleRef is immutable), so it is deleted and recreated — a binding of this name that grants some
// other role is exactly the drift that would make a "read-only" token admin.
func EnsureReadOnlyAccess(ctx context.Context, kube KubeAPI, opts ReadOnlyOptions) error {
	o, err := opts.resolved()
	if err != nil {
		return err
	}
	if err := apply(ctx, kube, namespacePath(o.Namespace), namespace{
		typeMeta: typeMeta{APIVersion: "v1", Kind: "Namespace"},
		Metadata: objectMeta{Name: o.Namespace, Labels: managedLabels()},
	}, nil); err != nil {
		return fmt.Errorf("ensure namespace %s: %w", o.Namespace, err)
	}
	noAutomount := false
	if err := apply(ctx, kube, serviceAccountPath(o.Namespace, o.ServiceAccount), serviceAccount{
		typeMeta:                     typeMeta{APIVersion: "v1", Kind: "ServiceAccount"},
		Metadata:                     objectMeta{Name: o.ServiceAccount, Namespace: o.Namespace, Labels: managedLabels()},
		AutomountServiceAccountToken: &noAutomount,
	}, nil); err != nil {
		return fmt.Errorf("ensure service account %s/%s: %w", o.Namespace, o.ServiceAccount, err)
	}
	if err := ensureClusterRole(ctx, kube); err != nil {
		return err
	}
	return ensureBinding(ctx, kube, o)
}

// ensureClusterRole applies ReadOnlyClusterRole and verifies the server's copy is exactly it.
func ensureClusterRole(ctx context.Context, kube KubeAPI) error {
	want := clusterRole{
		typeMeta: typeMeta{APIVersion: "rbac.authorization.k8s.io/v1", Kind: "ClusterRole"},
		Metadata: objectMeta{Name: ReadOnlyClusterRole, Labels: managedLabels()},
		Rules:    ReadOnlyRules(),
	}
	var got clusterRole
	if err := apply(ctx, kube, clusterRolePath(ReadOnlyClusterRole), want, &got); err != nil {
		return fmt.Errorf("ensure cluster role %s: %w", ReadOnlyClusterRole, err)
	}
	if got.AggregationRule != nil || !rulesEqual(got.Rules, want.Rules) {
		return fmt.Errorf("%w: cluster role %s on the server is not the read-only rule set this tier applied (an aggregationRule or extra rules are present); refusing to bind to it", ErrKubeAPI, ReadOnlyClusterRole)
	}
	return nil
}

// ensureBinding applies the binding, recreating it once if an immutable roleRef blocks the apply,
// and verifies the server's copy grants exactly ReadOnlyClusterRole to exactly the ServiceAccount.
func ensureBinding(ctx context.Context, kube KubeAPI, o ReadOnlyOptions) error {
	name := o.BindingName()
	want := clusterRoleBinding{
		typeMeta: typeMeta{APIVersion: "rbac.authorization.k8s.io/v1", Kind: "ClusterRoleBinding"},
		Metadata: objectMeta{Name: name, Labels: managedLabels()},
		RoleRef:  roleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: ReadOnlyClusterRole},
		Subjects: []subject{{Kind: "ServiceAccount", Name: o.ServiceAccount, Namespace: o.Namespace}},
	}
	path := clusterRoleBindingPath(name)
	var got clusterRoleBinding
	err := apply(ctx, kube, path, want, &got)
	if isStatus(err, http.StatusUnprocessableEntity) {
		// roleRef is immutable: the existing binding of this name points at another role.
		if delErr := call(ctx, kube, http.MethodDelete, path, "", nil, nil); delErr != nil && !isStatus(delErr, http.StatusNotFound) {
			return fmt.Errorf("replace cluster role binding %s: %w", name, delErr)
		}
		err = apply(ctx, kube, path, want, &got)
	}
	if err != nil {
		return fmt.Errorf("ensure cluster role binding %s: %w", name, err)
	}
	if got.RoleRef != want.RoleRef || len(got.Subjects) != 1 || got.Subjects[0] != want.Subjects[0] {
		return fmt.Errorf("%w: cluster role binding %s on the server does not bind exactly %s to %s/%s", ErrKubeAPI, name, ReadOnlyClusterRole, o.Namespace, o.ServiceAccount)
	}
	return nil
}

// rulesEqual compares two rule lists element by element, order included (apply replaces the list
// atomically, so the server's order is the one sent).
func rulesEqual(a, b []PolicyRule) bool {
	if len(a) != len(b) {
		return false
	}
	eq := func(x, y []string) bool {
		if len(x) != len(y) {
			return false
		}
		for i := range x {
			if x[i] != y[i] {
				return false
			}
		}
		return true
	}
	for i := range a {
		if !eq(a[i].APIGroups, b[i].APIGroups) || !eq(a[i].Resources, b[i].Resources) || !eq(a[i].Verbs, b[i].Verbs) ||
			!eq(a[i].ResourceNames, b[i].ResourceNames) || !eq(a[i].NonResourceURLs, b[i].NonResourceURLs) {
			return false
		}
	}
	return true
}

// MintedToken is a ServiceAccount token and the expiry the API server actually gave it.
//
// It formats as a redaction under every fmt verb (%v, %+v, %#v, %s, %q) and marshals to JSON without
// the token, so logging or serialising the struct by accident cannot leak it. The one way to the
// token is reading the Token field, which only the renderer or the sealer should do.
type MintedToken struct {
	Token     string    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Format implements fmt.Formatter: every verb prints a redaction carrying only the expiry.
func (t MintedToken) Format(f fmt.State, _ rune) {
	_, _ = fmt.Fprintf(f, "MintedToken{Token:<redacted>, ExpiresAt:%s}", t.ExpiresAt.UTC().Format(time.RFC3339))
}

// MintReadOnlyToken requests a token for opts' ServiceAccount through the TokenRequest API with
// expirationSeconds = ttl, and returns the expiry the SERVER reports, not the one requested: an API
// server may clamp a request (--service-account-max-token-expiration). A server that EXTENDS it past
// ttl (beyond a few minutes of clock skew) is refused, because the caller promised the user a credential
// no longer than ttl. ttl must be whole seconds within the mint bounds (15m–8h).
//
// It does not create the identity; call EnsureReadOnlyAccess first. No error it returns contains the
// token: a malformed answer is described, never quoted.
func MintReadOnlyToken(ctx context.Context, kube KubeAPI, opts ReadOnlyOptions, ttl time.Duration) (MintedToken, error) {
	o, err := opts.resolved()
	if err != nil {
		return MintedToken{}, err
	}
	if ttl%time.Second != 0 {
		return MintedToken{}, fmt.Errorf("%w: ttl %s is not a whole number of seconds", ErrKubeAPI, ttl)
	}
	seconds := int64(ttl / time.Second)
	if err := types.ValidateKubeconfigMintTTL(int(seconds)); err != nil {
		return MintedToken{}, err
	}
	var req tokenRequest
	req.APIVersion, req.Kind = "authentication.k8s.io/v1", "TokenRequest"
	req.Spec.ExpirationSeconds = seconds
	var resp tokenRequest
	requested := time.Now()
	if err := call(ctx, kube, http.MethodPost, serviceAccountPath(o.Namespace, o.ServiceAccount)+"/token", "application/json", req, &resp); err != nil {
		return MintedToken{}, fmt.Errorf("mint read-only token for %s/%s: %w", o.Namespace, o.ServiceAccount, err)
	}
	if resp.Status.Token == "" {
		return MintedToken{}, fmt.Errorf("%w: TokenRequest for %s/%s answered without a token", ErrKubeAPI, o.Namespace, o.ServiceAccount)
	}
	exp, err := time.Parse(time.RFC3339, resp.Status.ExpirationTimestamp)
	if err != nil {
		return MintedToken{}, fmt.Errorf("%w: TokenRequest for %s/%s answered without a parsable expirationTimestamp", ErrKubeAPI, o.Namespace, o.ServiceAccount)
	}
	now := time.Now()
	if !exp.After(now) {
		return MintedToken{}, fmt.Errorf("%w: TokenRequest for %s/%s answered with a token that has already expired (%s)", ErrKubeAPI, o.Namespace, o.ServiceAccount, exp.UTC().Format(time.RFC3339))
	}
	if limit := requested.Add(ttl + expiryExtensionTolerance); exp.After(limit) {
		return MintedToken{}, fmt.Errorf("%w: the API server extended the token for %s/%s to %s, past the requested %s; refusing a credential longer than asked for", ErrKubeAPI, o.Namespace, o.ServiceAccount, exp.UTC().Format(time.RFC3339), ttl)
	}
	return MintedToken{Token: resp.Status.Token, ExpiresAt: exp}, nil
}

// RevokeReadOnlyAccess deletes opts' ClusterRoleBinding and then its ServiceAccount. Deleting the
// ServiceAccount invalidates every token ever minted for it at once (bound tokens are checked
// against the ServiceAccount's UID); deleting the binding first means nothing it minted still grants
// anything even if the second delete fails. Each object is deleted only if it carries
// ManagedByLabel=ManagedByValue — an object of the same name that this tier did not create is
// refused, not removed — and only that exact object (a UID precondition). Already absent is success,
// so revocation is idempotent. The ClusterRole and Namespace are left: neither grants anything alone.
func RevokeReadOnlyAccess(ctx context.Context, kube KubeAPI, opts ReadOnlyOptions) error {
	o, err := opts.resolved()
	if err != nil {
		return err
	}
	if err := deleteManaged(ctx, kube, clusterRoleBindingPath(o.BindingName()), "cluster role binding "+o.BindingName()); err != nil {
		return err
	}
	return deleteManaged(ctx, kube, serviceAccountPath(o.Namespace, o.ServiceAccount), "service account "+o.Namespace+"/"+o.ServiceAccount)
}

// deleteManaged deletes the object at path if it exists and is labelled as this tier's.
func deleteManaged(ctx context.Context, kube KubeAPI, path, what string) error {
	var obj struct {
		Metadata objectMeta `json:"metadata"`
	}
	err := call(ctx, kube, http.MethodGet, path, "", nil, &obj)
	if isStatus(err, http.StatusNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("revoke: read %s: %w", what, err)
	}
	if obj.Metadata.Labels[ManagedByLabel] != ManagedByValue {
		return fmt.Errorf("%w: revoke: %s is not labelled %s=%s; refusing to delete an object this tier did not create", ErrKubeAPI, what, ManagedByLabel, ManagedByValue)
	}
	opts := map[string]any{"apiVersion": "v1", "kind": "DeleteOptions"}
	if obj.Metadata.UID != "" {
		opts["preconditions"] = map[string]string{"uid": obj.Metadata.UID}
	}
	err = call(ctx, kube, http.MethodDelete, path, "application/json", opts, nil)
	if err != nil && !isStatus(err, http.StatusNotFound) {
		return fmt.Errorf("revoke: delete %s: %w", what, err)
	}
	return nil
}
