// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cross-account keyless CONTAINER REGISTRY in-cluster pull (#1047) — the PURE half.
//
// This closes the last unproven link in epic #1046. The `registry-token` MINT was proven against a
// live registry in July 2026 (apps/runner/internal/agent/registry_token_real_test.go, ambient local
// credentials, no cluster). What was never proven is the half the product actually ships: the B4 tofu
// Workload-Identity pull role federating the in-cluster refresher's ServiceAccount, the refresher
// minting with NO local credential and PATCHING the `<slug>-pull` Secret, and a real app pod using
// that Secret to pull an image out of a DIFFERENT account/project/subscription.
//
// It looked shipped. `scripts/e2e/registry-e2e.sh` invoked `-run TestT2XacctRegistry`, and that
// function existed in no file; `docs/testing/xacct-registry-parity.md` named
// ALETHIA_E2E_XACCT_REGISTRY as the vehicle, and nothing in .github/workflows/ ever set it. A script
// naming a test nobody wrote records BLOCKED forever, which reads exactly like a lane waiting on a
// maintainer rather than a harness that does not exist.
//
// Everything here is deterministic and unit-tested without a cloud (t2_xacct_registry_pure_test.go);
// the *_run_test.go sibling drives it against a real cluster under the e2e_t2 build tag.
package e2e

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/alethialabs-io/alethialabs/packages/core/categories"
)

// Scenario env. Every per-cloud value also honours the "<base>_<PROVIDER>" override idiom
// (t2ArgoEnvForProvider): the three clouds' targets live in three different accounts with three
// different host shapes, so a single shared value could never drive more than one leg.
const (
	envXacctRegistry          = "ALETHIA_E2E_XACCT_REGISTRY"            // truthy ⇒ enable
	envXacctRegistryHost      = "ALETHIA_E2E_XACCT_REGISTRY_HOST"       // the dockerconfig `auths` key
	envXacctRegistryImage     = "ALETHIA_E2E_XACCT_REGISTRY_IMAGE"      // the fully-qualified cross-account image
	envXacctRegistryAccount   = "ALETHIA_E2E_XACCT_REGISTRY_ACCOUNT"    // aws account id · azure subscription id
	envXacctRegistryProjectID = "ALETHIA_E2E_XACCT_REGISTRY_PROJECT_ID" // gcp target project
	envXacctRegistryRegion    = "ALETHIA_E2E_XACCT_REGISTRY_REGION"     // aws/gcp registry location
	envXacctRegistryRoleARN   = "ALETHIA_E2E_XACCT_REGISTRY_ROLE_ARN"   // aws: the target-account pull role
	envXacctRegistryReaderSA  = "ALETHIA_E2E_XACCT_REGISTRY_READER_SA"  // gcp: the reader service account
	envXacctRegistryClientID  = "ALETHIA_E2E_XACCT_REGISTRY_CLIENT_ID"  // azure: the AcrPull identity client id
	envXacctRegistryService   = "ALETHIA_E2E_XACCT_REGISTRY_SERVICE"    // the probe service that pulls the image
	envXacctRegistryNamespace = "ALETHIA_E2E_XACCT_REGISTRY_NAMESPACE"  // where the refresher + app land
	envXacctRegistrySummary   = "ALETHIA_E2E_XACCT_REGISTRY_SUMMARY"    // where to write the proof summary
)

// registryPullKSA is the refresher's ServiceAccount AND its Deployment name — a constant mirror of
// manifests' registryPullKSAName (unexported there). The per-cloud B4 tofu pull role federates
// `default:alethia-registry-pull` specifically, so this is a literal on both sides, not a knob.
const registryPullKSA = "alethia-registry-pull"

// xacctRegistryDefaultNS is where BOTH the refresher and the generated app pods land: a constant
// mirror of provisioner.appNamespace (unexported). The `<slug>-pull` Secret is namespaced, and an
// imagePullSecret only resolves in the pod's own namespace, so a mismatch here would render a
// refresher nothing could pull through. The env override exists for a future placement model.
const xacctRegistryDefaultNS = "default"

// xacctRegistryDeniedPod is the NEGATIVE control's pod: the SAME cross-account image, in the SAME
// namespace, with NO imagePullSecrets. It must never pull.
const xacctRegistryDeniedPod = "xacct-registry-unauthenticated-probe"

// refresherSkipMarker is the substring every fail-closed `writeRegistryRefresher` skip carries. It is
// a COUPLING with packages/core/provisioner/manifests_gen.go, pinned by
// TestXacctRegistrySkipMarkerPinnedToProvisioner so a reworded skip fails in unit tests rather than
// silently disarming assertion (a) at 04:00 against a real cluster.
const refresherSkipMarker = "pull refresher not rendered"

// xacctRegistryConfig is the resolved scenario input.
type xacctRegistryConfig struct {
	provider    string
	account     string // aws account id · azure subscription id
	projectID   string // gcp
	region      string
	roleARN     string // aws
	readerSA    string // gcp
	clientID    string // azure
	host        string // the registry endpoint / dockerconfig auths key
	image       string // the cross-account image the probe service pulls
	serviceName string
	namespace   string
	summaryPath string
	enabled     bool
}

// xacctRegistryEnabled reports whether the opt-in scenario was requested. Off by default: the base T2
// proof is unchanged unless a maintainer opts in.
func xacctRegistryEnabled() bool { return t2Truthy(os.Getenv(envXacctRegistry)) }

// xacctRegistryLane is the SINGLE source of truth for which clouds this scenario can prove, and why
// the others cannot. It is asserted by the pure tests and quoted by both the run half and
// scripts/e2e/registry-e2e.sh, so a lane cannot look covered in one place while being excluded in
// another.
//
// Unlike its #1268 sibling, all THREE managed registry clouds are runnable here, and the reason is
// structural rather than lucky: the trust anchor the target account grants is a STANDING customer
// object (an IAM role, a reader GSA, an AcrPull assignment on a client id) that the cluster-side
// identity assumes or impersonates — it does not have to name a per-run identity, which is exactly
// what blocks gcp/azure on the secrets lane.
func xacctRegistryLane(provider string) (ok bool, blocked string) {
	switch provider {
	case "aws", "gcp", "azure":
		return true, ""
	case "alibaba":
		return false, "Alibaba: there is no `acr-xacct`-shaped connector — the catalog ships cross-account keyless registries for ECR, GAR and ACR only, so an alibaba lane would have nothing to select. A documented exclusion, not a gap; adding one means shipping the connector, the B4 pull role and a registry-token minter first."
	case "hetzner":
		return false, "Hetzner: a token cloud with no cross-account registry federation and no workload-identity plane for a refresher to mint from — the same explicit parity exclusion docs/testing/xacct-registry-parity.md records for Hetzner/DO/Civo."
	default:
		return false, fmt.Sprintf("%s has no cross-account keyless container registry.", provider)
	}
}

// xacctRegistryFromEnv resolves the scenario config for a provider.
//
// The registry HOST is required explicitly rather than derived from the account id and region: only
// the AWS host is derivable, and deriving one cloud's while requiring the other two would put a
// second copy of ECR's endpoint format here — the exact class of second-literal the keyless cell
// table exists to avoid.
func xacctRegistryFromEnv(provider string) xacctRegistryConfig {
	return xacctRegistryConfig{
		provider:    provider,
		enabled:     xacctRegistryEnabled(),
		account:     t2ArgoEnvForProvider(envXacctRegistryAccount, provider, ""),
		projectID:   t2ArgoEnvForProvider(envXacctRegistryProjectID, provider, ""),
		region:      t2ArgoEnvForProvider(envXacctRegistryRegion, provider, ""),
		roleARN:     t2ArgoEnvForProvider(envXacctRegistryRoleARN, provider, ""),
		readerSA:    t2ArgoEnvForProvider(envXacctRegistryReaderSA, provider, ""),
		clientID:    t2ArgoEnvForProvider(envXacctRegistryClientID, provider, ""),
		host:        strings.TrimSpace(t2ArgoEnvForProvider(envXacctRegistryHost, provider, "")),
		image:       strings.TrimSpace(t2ArgoEnvForProvider(envXacctRegistryImage, provider, "")),
		serviceName: t2Env(envXacctRegistryService, "xacct-registry-probe"),
		namespace:   t2Env(envXacctRegistryNamespace, xacctRegistryDefaultNS),
		summaryPath: t2Env(envXacctRegistrySummary, ""),
	}
}

// decide resolves whether the scenario runs. Mirrors secretsXacctConfig.decide / keylessDBConfig.decide:
//   - not requested                    → (false, nil), silent
//   - requested on an EXCLUDED cloud   → (false, nil) + the recorded reason (the run half logs it)
//   - requested but partly configured  → ERROR naming every missing key, BEFORE any cloud spend
//
// The IMAGE must live under the configured registry host. Without that check the scenario would
// happily deploy a Docker Hub image, watch the pod come up, and report a cross-account pull that
// never touched the foreign account — a green run proving nothing at all, which is the failure mode
// this whole unit exists to close.
//
// The apps repo is a HARD requirement for the same reason keyless has one: the refresher AND the
// probe workload reach the cluster only through the GitOps apps repo. Without it the scenario would
// poll for a Deployment nobody ever pushed and time out looking exactly like a federation failure.
func (c xacctRegistryConfig) decide() (bool, string, error) {
	if !c.enabled {
		return false, "", nil
	}
	if ok, blocked := xacctRegistryLane(c.provider); !ok {
		return false, blocked, nil
	}
	var missing []string
	need := func(key, v string) {
		if strings.TrimSpace(v) == "" {
			missing = append(missing, key)
		}
	}
	need(envXacctRegistryHost, c.host)
	need(envXacctRegistryImage, c.image)
	switch c.provider {
	case "aws":
		need(envXacctRegistryAccount, c.account)
		need(envXacctRegistryRegion, c.region)
		need(envXacctRegistryRoleARN, c.roleARN)
	case "gcp":
		need(envXacctRegistryProjectID, c.projectID)
		need(envXacctRegistryRegion, c.region)
		need(envXacctRegistryReaderSA, c.readerSA)
	case "azure":
		need(envXacctRegistryAccount, c.account)
		need(envXacctRegistryClientID, c.clientID)
	}
	// The GitOps repo, without which nothing renders into the cluster.
	need(envArgoAppsRepo, t2ArgoEnvForProvider(envArgoAppsRepo, c.provider, ""))
	need(envArgoGitToken, os.Getenv(envArgoGitToken))
	if len(missing) > 0 {
		sort.Strings(missing)
		return false, "", fmt.Errorf("%s is enabled for %s but these are unset: %s",
			envXacctRegistry, c.provider, strings.Join(missing, ", "))
	}
	if !imageIsUnderHost(c.image, c.host) {
		return false, "", fmt.Errorf("%s (%q) is not hosted on %s (%q) — a probe pulling from anywhere else would come up green having never touched the cross-account registry",
			envXacctRegistryImage, c.image, envXacctRegistryHost, c.host)
	}
	if c.namespace != xacctRegistryDefaultNS {
		return false, "", fmt.Errorf("%s must be %q — the refresher renders into the app namespace and an imagePullSecret only resolves in the pod's own namespace, so a probe elsewhere could never use it (got %q)",
			envXacctRegistryNamespace, xacctRegistryDefaultNS, c.namespace)
	}
	return true, "", nil
}

// imageIsUnderHost reports whether an image reference is served by host. Compared on the registry
// component alone (everything before the first "/"), so a tag or a digest cannot change the answer
// and a host that merely appears inside a repository path cannot fake one.
func imageIsUnderHost(image, host string) bool {
	image, host = strings.TrimSpace(image), strings.TrimSpace(host)
	if image == "" || host == "" {
		return false
	}
	registry, _, ok := strings.Cut(image, "/")
	return ok && strings.EqualFold(registry, host)
}

// connectorSlug is the cross-account registry connector this cloud selects.
func (c xacctRegistryConfig) connectorSlug() string {
	switch c.provider {
	case "aws":
		return "ecr-xacct"
	case "gcp":
		return "gar-xacct"
	case "azure":
		return "acr-xacct"
	}
	return ""
}

// pullSecretName is the imagePullSecret the refresher patches and the app pods reference. Delegates
// to the product SSOT so a convention change there breaks compilation here rather than producing a
// test that polls a Secret nobody makes.
func (c xacctRegistryConfig) pullSecretName() string {
	return categories.KeylessRegistryTarget{Slug: c.connectorSlug()}.SecretName()
}

// targetRef is the customer-created trust anchor in the target account — an identity REFERENCE,
// never a key. Carried into the proof summary so a run records WHICH grant it exercised.
func (c xacctRegistryConfig) targetRef() string {
	switch c.provider {
	case "aws":
		return c.roleARN
	case "gcp":
		return c.readerSA
	case "azure":
		return c.clientID
	}
	return ""
}

// providerConfig is the connector's provider_config for this cloud. The KEYS are the contract with
// packages/core/categories/catalog.json — a pure test pins them against the catalog, so a rename
// there fails in unit tests rather than as an opaque validation error mid-provision.
func (c xacctRegistryConfig) providerConfig() map[string]any {
	switch c.provider {
	case "aws":
		return map[string]any{
			"target_account_id": c.account,
			"region":            c.region,
			"registry_host":     c.host,
			"target_role_arn":   c.roleARN,
		}
	case "gcp":
		return map[string]any{
			"target_project_id":      c.projectID,
			"region":                 c.region,
			"registry_host":          c.host,
			"target_service_account": c.readerSA,
		}
	case "azure":
		pc := map[string]any{
			"target_subscription_id":    c.account,
			"registry_host":             c.host,
			"target_identity_client_id": c.clientID,
		}
		// Optional on ACR (the catalog marks it not required) — omitted rather than sent empty, so a
		// blank never reaches the tfvars as a meaningful-looking value.
		if c.region != "" {
			pc["region"] = c.region
		}
		return pc
	}
	return nil
}

// applyToSnapshot layers the scenario onto a DEPLOY config_snapshot: the cross-account registry row,
// plus a service whose image lives IN that registry — the binding-equivalent for this feature, since
// a registry selection alone renders a refresher nothing ever pulls through.
//
// It APPENDS to any existing `container_registries`/`services` rather than assigning, for the reason
// #1268 documents: MaxConfigSnapshot writes whole snapshot keys, so on a full-bar run this must layer
// ON TOP of the max-config surface. Appending is also what makes the selection DOMINANT without
// destroying anything: max-config's registry row is native (provider ""), which categories'
// dominantProvider skips, so the appended pluggable row is chosen — and a keyless registry sets the
// separate `registry_pull_provider` guard, never `registry_provider`, so the cluster keeps its own
// native registry.
func (c xacctRegistryConfig) applyToSnapshot(snap map[string]any) {
	registry := map[string]any{
		"name":            c.registryName(),
		"provider":        c.connectorSlug(),
		"provider_config": c.providerConfig(),
	}
	snap["container_registries"] = append(existingList(snap, "container_registries"), registry)

	svc := map[string]any{
		"name":   c.serviceName,
		"type":   "deployment",
		"source": map[string]any{"kind": "image", "image": c.image},
	}
	snap["services"] = append(existingList(snap, "services"), svc)
}

// registryName is the project-side name of the cross-account registry row. Derived from the slug so
// two clouds' rows never collide on a snapshot that somehow carried both.
func (c xacctRegistryConfig) registryName() string { return c.connectorSlug() }

// ── the render decision (assertion (a)) ───────────────────────────────────────────────────────

// xacctRegistryRenderSkips returns the fail-closed refresher skips the deploy recorded.
//
// A CAVEAT worth stating plainly, because it is weaker than the siblings' and a reader would
// otherwise assume parity: `writeRegistryRefresher` leaves NO positive decision record. Where keyless
// DB writes `keyless_bindings` and the cross-account secret store writes an `infra_services` row —
// both of which say "wired" out loud — the registry refresher only speaks when it REFUSES, through
// gitops_status.manifest_warnings. So an empty result here means "nothing refused", NOT "the
// refresher was rendered", and it can never be treated as proof on its own. The positive proof is
// entirely cluster-side: assertions (b)–(e) observe objects that exist only if the refresher really
// rendered and really minted. Giving this feature a positive decision record is a product change and
// is left explicitly undone rather than faked here.
func xacctRegistryRenderSkips(metaRaw []byte) ([]string, error) {
	var meta struct {
		GitopsStatus struct {
			ManifestWarnings []string `json:"manifest_warnings"`
		} `json:"gitops_status"`
	}
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return nil, fmt.Errorf("decode execution_metadata: %w", err)
	}
	var out []string
	for _, w := range meta.GitopsStatus.ManifestWarnings {
		if strings.Contains(w, refresherSkipMarker) {
			out = append(out, w)
		}
	}
	return out, nil
}

// ── in-cluster observation (pure parsers over kubectl -o json output) ──────────────────────────

// dockerConfigAuth is one host entry of a .dockerconfigjson. The token FIELDS are carried so their
// emptiness can be judged; their VALUES never leave this file — see assertPullSecretMinted.
type dockerConfigAuth struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Auth     string `json:"auth"`
}

// parsePullSecretAuths decodes a kubernetes.io/dockerconfigjson Secret's `auths` map.
//
// Fail-closed at every step: a missing key, an undecodable payload and a malformed document are all
// errors, never an empty map that a caller could mistake for "no auth yet" and keep polling past a
// real breakage.
func parsePullSecretAuths(secretJSON []byte) (map[string]dockerConfigAuth, error) {
	var obj struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(secretJSON, &obj); err != nil {
		return nil, fmt.Errorf("decode Secret: %w", err)
	}
	enc, ok := obj.Data[".dockerconfigjson"]
	if !ok {
		keys := make([]string, 0, len(obj.Data))
		for k := range obj.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		return nil, fmt.Errorf("the pull Secret has no .dockerconfigjson key (present: %v)", keys)
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return nil, fmt.Errorf(".dockerconfigjson is not valid base64: %w", err)
	}
	var doc struct {
		Auths map[string]dockerConfigAuth `json:"auths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("decode .dockerconfigjson: %w", err)
	}
	if doc.Auths == nil {
		doc.Auths = map[string]dockerConfigAuth{}
	}
	return doc.Auths, nil
}

// assertPullSecretMinted reports whether the refresher has patched a real credential for host into
// the pull Secret, distinguishing the three states that matter:
//
//	minted=false, err=nil  — still the `{"auths":{}}` placeholder the manifest ships, or an entry
//	                         with no material. The refresher has not minted yet; keep polling.
//	minted=false, err!=nil — the Secret is unreadable or auth'd for a DIFFERENT host. Polling would
//	                         never fix either, so it fails immediately with the hosts it did find.
//	minted=true            — a non-empty credential for exactly this host.
//
// The token NEVER leaves this function — not in the return, not in the error, not in a log. The whole
// value of a short-lived pull token is that it never reaches a CI log or a proof bundle, and a
// failure is precisely when output gets pasted into an issue.
func assertPullSecretMinted(secretJSON []byte, host string) (minted bool, err error) {
	auths, err := parsePullSecretAuths(secretJSON)
	if err != nil {
		return false, err
	}
	if len(auths) == 0 {
		return false, nil // the placeholder — the refresher has not minted yet
	}
	a, ok := auths[host]
	if !ok {
		hosts := make([]string, 0, len(auths))
		for h := range auths {
			hosts = append(hosts, h)
		}
		sort.Strings(hosts)
		return false, fmt.Errorf("the pull Secret carries auth for %v but not for %q — the refresher minted against a different registry host than the scenario configured", hosts, host)
	}
	if a.Auth == "" && a.Password == "" {
		return false, nil // an entry with no material yet
	}
	return true, nil
}

// podSpecView is the slice of a Deployment's pod template this scenario asserts on. parsePodTemplate
// (the #1511 parser) deliberately carries containers and the service account but NOT
// imagePullSecrets, which is the whole subject here — so this is a second, narrow view rather than a
// widening of a parser five other assertions depend on.
type podSpecView struct {
	ImagePullSecrets []string
	Images           []string
}

// parsePodSpecView extracts the imagePullSecrets + container images from a Deployment.
func parsePodSpecView(objJSON []byte) (podSpecView, error) {
	var obj struct {
		Spec struct {
			Template struct {
				Spec struct {
					ImagePullSecrets []struct {
						Name string `json:"name"`
					} `json:"imagePullSecrets"`
					Containers []struct {
						Image string `json:"image"`
					} `json:"containers"`
				} `json:"spec"`
			} `json:"template"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(objJSON, &obj); err != nil {
		return podSpecView{}, fmt.Errorf("decode Deployment pod spec: %w", err)
	}
	v := podSpecView{}
	for _, s := range obj.Spec.Template.Spec.ImagePullSecrets {
		v.ImagePullSecrets = append(v.ImagePullSecrets, s.Name)
	}
	for _, c := range obj.Spec.Template.Spec.Containers {
		v.Images = append(v.Images, c.Image)
	}
	return v, nil
}

// hasPullSecret reports whether the pod attaches the named imagePullSecret.
func (v podSpecView) hasPullSecret(name string) bool {
	for _, s := range v.ImagePullSecrets {
		if s == name {
			return true
		}
	}
	return false
}

// hasImage reports whether any container runs the named image.
func (v podSpecView) hasImage(image string) bool {
	for _, i := range v.Images {
		if i == image {
			return true
		}
	}
	return false
}

// pullState is one pod's image-pull outcome, read from its container statuses.
type pullState struct {
	Pulled  bool   // a container is running (or ran) — the image is on the node
	Failed  bool   // the kubelet reported a pull failure
	Reason  string // the waiting reason, e.g. ImagePullBackOff
	Message string // the kubelet's message (a registry error; never a credential)
}

// imagePullFailureReasons are the kubelet waiting reasons that mean the image could not be fetched.
// ErrImagePull is the first attempt's failure and ImagePullBackOff the retry state; a probe that only
// matched the backoff would miss a fast single failure, and one that only matched ErrImagePull would
// miss the steady state it settles into within seconds.
var imagePullFailureReasons = map[string]bool{
	"ErrImagePull":            true,
	"ImagePullBackOff":        true,
	"InvalidImageName":        true,
	"RegistryUnavailable":     true,
	"ImageInspectError":       true,
	"SignatureValidationFail": true,
}

// parsePullState reads a core/v1 Pod's container statuses.
//
// "Running or terminated" is what counts as PULLED: the probe image may be a `pause`-shaped container
// that never exits, or a short command that completes — both mean the kubelet fetched the image,
// which is the only claim this scenario makes about the workload itself.
func parsePullState(podJSON []byte) (pullState, error) {
	var obj struct {
		Status struct {
			ContainerStatuses []struct {
				State struct {
					Waiting *struct {
						Reason  string `json:"reason"`
						Message string `json:"message"`
					} `json:"waiting"`
					Running    *struct{} `json:"running"`
					Terminated *struct{} `json:"terminated"`
				} `json:"state"`
			} `json:"containerStatuses"`
		} `json:"status"`
	}
	if err := json.Unmarshal(podJSON, &obj); err != nil {
		return pullState{}, fmt.Errorf("decode Pod: %w", err)
	}
	st := pullState{}
	for _, cs := range obj.Status.ContainerStatuses {
		if cs.State.Running != nil || cs.State.Terminated != nil {
			st.Pulled = true
		}
		if w := cs.State.Waiting; w != nil && imagePullFailureReasons[w.Reason] {
			st.Failed = true
			st.Reason = w.Reason
			st.Message = w.Message
		}
	}
	return st, nil
}

// parseServiceAccountPullSecrets reads the imagePullSecrets a ServiceAccount attaches to every pod
// that runs as it. The negative control depends on `default` carrying NONE: if it carried the pull
// Secret, an unauthenticated probe would pull for reasons that have nothing to do with what the
// product wired, and the control would be void rather than merely weak.
func parseServiceAccountPullSecrets(saJSON []byte) ([]string, error) {
	var obj struct {
		ImagePullSecrets []struct {
			Name string `json:"name"`
		} `json:"imagePullSecrets"`
	}
	if err := json.Unmarshal(saJSON, &obj); err != nil {
		return nil, fmt.Errorf("decode ServiceAccount: %w", err)
	}
	out := make([]string, 0, len(obj.ImagePullSecrets))
	for _, s := range obj.ImagePullSecrets {
		out = append(out, s.Name)
	}
	return out, nil
}

// buildUnauthenticatedPullPod renders the NEGATIVE control: the SAME cross-account image, in the SAME
// namespace, on the default ServiceAccount, with NO imagePullSecrets and no token mounted. Exactly
// one variable changes from the positive case — the pull credential.
//
// If this pod CAN pull, the image is reachable without the credential the platform minted, and the
// positive proof degenerates into "a registry served an image". The control's sharpness does rest on
// one property of the SETUP, which is worth naming rather than assuming: the target repository policy
// must grant only the refresher's identity. That is the documented shape in
// docs/testing/xacct-registry-parity.md — a target left world-readable would make this pod pull and
// the run would fail here, loudly, which is the correct outcome.
func buildUnauthenticatedPullPod(name, ns, image string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Pod
metadata:
  name: %s
  namespace: %s
  labels:
    alethia.io/e2e: xacct-registry-negative-control
spec:
  restartPolicy: Never
  serviceAccountName: default
  automountServiceAccountToken: false
  containers:
    - name: probe
      image: %s
      command: ["sleep", "60"]
`, name, ns, image)
}

// ── proof summary ─────────────────────────────────────────────────────────────────────────────

// xacctRegistrySummary is the machine-readable record folded into the proof bundle. Names, verdicts
// and identity REFERENCES only — never a pull token, never a credential.
type xacctRegistrySummary struct {
	Feature           string `json:"feature"`
	Provider          string `json:"provider"`
	Slug              string `json:"connector_slug"`
	RegistryHost      string `json:"registry_host"`
	PullSecret        string `json:"pull_secret"`
	TargetRef         string `json:"target_ref,omitempty"`
	Image             string `json:"image"`
	RefresherRendered bool   `json:"refresher_rendered"`
	IdentityAnnotated bool   `json:"identity_annotated"`
	SecretMinted      bool   `json:"pull_secret_minted"`
	ImagePulled       bool   `json:"cross_account_image_pulled"`
	ScopeDenied       bool   `json:"unauthenticated_pull_denied"`
	Verdict           string `json:"verdict"`
	Detail            string `json:"detail,omitempty"`
}

// xacctRegistrySummaryJSON renders the summary for the proof bundle.
func xacctRegistrySummaryJSON(s xacctRegistrySummary) ([]byte, error) {
	s.Feature = "xacct-registry"
	return json.MarshalIndent(s, "", "  ")
}
