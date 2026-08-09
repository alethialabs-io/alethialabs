// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"errors"
	"strings"
	"testing"

	awsmiddleware "github.com/aws/aws-sdk-go-v2/aws/middleware"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/iam"
	iamtypes "github.com/aws/aws-sdk-go-v2/service/iam/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go/middleware"
)

// covStubResponse is a canned answer for one AWS operation: either a typed operation
// output or an error. Exactly one is set.
type covStubResponse struct {
	result interface{}
	err    error
}

// covStubAPI short-circuits the smithy stack in front of the retry/signing middleware, so
// the SDK client never resolves credentials and never opens a socket. Every operation the
// stub does not name returns a zero-valued output for that operation via `fallback`.
func covStubAPI(t *testing.T, responses map[string]covStubResponse) func(*middleware.Stack) error {
	t.Helper()
	return func(stack *middleware.Stack) error {
		return stack.Finalize.Add(middleware.FinalizeMiddlewareFunc("covStubAPI",
			func(ctx context.Context, _ middleware.FinalizeInput, _ middleware.FinalizeHandler) (middleware.FinalizeOutput, middleware.Metadata, error) {
				op := awsmiddleware.GetOperationName(ctx)
				resp, ok := responses[op]
				if !ok {
					t.Errorf("unexpected AWS operation %q reached the stub", op)
					return middleware.FinalizeOutput{}, middleware.Metadata{}, errors.New("unstubbed operation " + op)
				}
				return middleware.FinalizeOutput{Result: resp.result}, middleware.Metadata{}, resp.err
			}), middleware.Before)
	}
}

// covS3 builds an S3Client whose every call is answered by the stub.
func covS3(t *testing.T, responses map[string]covStubResponse) *S3Client {
	t.Helper()
	return &S3Client{Client: s3.New(s3.Options{
		Region:     "eu-central-1",
		APIOptions: []func(*middleware.Stack) error{covStubAPI(t, responses)},
	})}
}

// covEC2 builds an EC2Client whose every call is answered by the stub.
func covEC2(t *testing.T, responses map[string]covStubResponse) *EC2Client {
	t.Helper()
	return &EC2Client{Client: ec2.New(ec2.Options{
		Region:     "eu-central-1",
		APIOptions: []func(*middleware.Stack) error{covStubAPI(t, responses)},
	})}
}

// covHardenOK is the four bucket-hardening calls all succeeding.
func covHardenOK() map[string]covStubResponse {
	return map[string]covStubResponse{
		"PutPublicAccessBlock":       {result: &s3.PutPublicAccessBlockOutput{}},
		"PutBucketEncryption":        {result: &s3.PutBucketEncryptionOutput{}},
		"PutBucketVersioning":        {result: &s3.PutBucketVersioningOutput{}},
		"PutBucketOwnershipControls": {result: &s3.PutBucketOwnershipControlsOutput{}},
	}
}

// covNoCreds strips every ambient AWS credential + config source so the SDK's credential
// chain resolves nothing and the call fails locally, before any socket is opened. CI has
// none of these, but this Mac does — the test must behave identically on both.
func covNoCreds(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AWS_CONFIG_FILE", "/nonexistent/alethia-cov/config")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/alethia-cov/credentials")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	for _, k := range []string{
		"AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_SDK_LOAD_CONFIG",
	} {
		t.Setenv(k, "")
	}
}

// TestCloud_NewS3Client_BuildsFromAmbientConfig pins that the S3/EC2 constructors resolve an
// ambient (keyless) config and hand back a usable client — no credential is required to build one.
func TestCloud_NewS3Client_BuildsFromAmbientConfig(t *testing.T) {
	covNoCreds(t)
	s3c, err := NewS3Client(context.Background(), AWSOptions{Region: "eu-central-1"})
	if err != nil {
		t.Fatalf("NewS3Client: %v", err)
	}
	if s3c == nil || s3c.Client == nil {
		t.Fatal("NewS3Client returned no client")
	}
	ec2c, err := NewEC2Client(context.Background(), AWSOptions{Region: "eu-central-1"})
	if err != nil {
		t.Fatalf("NewEC2Client: %v", err)
	}
	if ec2c == nil || ec2c.Client == nil {
		t.Fatal("NewEC2Client returned no client")
	}
}

// TestCloud_NewS3Client_ConfigErrorIsWrapped pins that a config-load failure (a named profile
// that does not exist) is reported, not swallowed, by both constructors.
func TestCloud_NewS3Client_ConfigErrorIsWrapped(t *testing.T) {
	covNoCreds(t)
	opts := AWSOptions{Region: "eu-central-1", Profile: "alethia-cov-missing-profile"}
	if _, err := NewS3Client(context.Background(), opts); err == nil {
		t.Fatal("expected NewS3Client to fail on a missing shared-config profile")
	} else if !strings.Contains(err.Error(), "failed to load AWS config") {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := NewEC2Client(context.Background(), opts); err == nil {
		t.Fatal("expected NewEC2Client to fail on a missing shared-config profile")
	} else if !strings.Contains(err.Error(), "failed to load AWS config") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_CreateS3BucketIfNotExists_ExistingBucketIsANoop pins that a HeadBucket that
// succeeds short-circuits: the bucket is never re-created.
func TestCloud_CreateS3BucketIfNotExists_ExistingBucketIsANoop(t *testing.T) {
	c := covS3(t, map[string]covStubResponse{
		"HeadBucket": {result: &s3.HeadBucketOutput{}},
	})
	if err := c.CreateS3BucketIfNotExists(context.Background(), "b", "eu-central-1", false); err != nil {
		t.Fatalf("CreateS3BucketIfNotExists: %v", err)
	}
}

// TestCloud_CreateS3BucketIfNotExists_DryRunSkipsCreation pins that dry-run reports the
// intent and returns before any mutating call is made.
func TestCloud_CreateS3BucketIfNotExists_DryRunSkipsCreation(t *testing.T) {
	c := covS3(t, map[string]covStubResponse{
		"HeadBucket": {err: &s3types.NotFound{}},
	})
	if err := c.CreateS3BucketIfNotExists(context.Background(), "b", "eu-central-1", true); err != nil {
		t.Fatalf("dry run: %v", err)
	}
}

// TestCloud_CreateS3BucketIfNotExists_CreatesAndHardens pins the happy path: a missing
// bucket is created and then hardened (public-access block, SSE, versioning, ownership).
func TestCloud_CreateS3BucketIfNotExists_CreatesAndHardens(t *testing.T) {
	responses := covHardenOK()
	responses["HeadBucket"] = covStubResponse{err: &s3types.NotFound{}}
	responses["CreateBucket"] = covStubResponse{result: &s3.CreateBucketOutput{}}
	c := covS3(t, responses)
	if err := c.CreateS3BucketIfNotExists(context.Background(), "b", "eu-central-1", false); err != nil {
		t.Fatalf("CreateS3BucketIfNotExists: %v", err)
	}
}

// TestCloud_CreateS3BucketIfNotExists_HardeningFailureIsNonFatal pins that a bucket which
// was created but could not be fully hardened still returns success (a warning, not an error) —
// the create is what the caller depends on.
func TestCloud_CreateS3BucketIfNotExists_HardeningFailureIsNonFatal(t *testing.T) {
	responses := covHardenOK()
	responses["HeadBucket"] = covStubResponse{err: &s3types.NotFound{}}
	responses["CreateBucket"] = covStubResponse{result: &s3.CreateBucketOutput{}}
	responses["PutPublicAccessBlock"] = covStubResponse{err: errors.New("denied")}
	c := covS3(t, responses)
	if err := c.CreateS3BucketIfNotExists(context.Background(), "b", "eu-central-1", false); err != nil {
		t.Fatalf("a hardening failure must not fail the create: %v", err)
	}
}

// TestCloud_CreateS3BucketIfNotExists_CreateErrorIsWrapped pins that a failed CreateBucket
// surfaces as an error naming the bucket.
func TestCloud_CreateS3BucketIfNotExists_CreateErrorIsWrapped(t *testing.T) {
	c := covS3(t, map[string]covStubResponse{
		"HeadBucket":   {err: &s3types.NotFound{}},
		"CreateBucket": {err: errors.New("boom")},
	})
	err := c.CreateS3BucketIfNotExists(context.Background(), "mybucket", "eu-central-1", false)
	if err == nil || !strings.Contains(err.Error(), "failed to create bucket 'mybucket'") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_CreateS3BucketIfNotExists_NonNotFoundHeadErrorFailsClosed pins that a HeadBucket
// error which is NOT "no such bucket" (e.g. AccessDenied) aborts instead of blindly creating.
func TestCloud_CreateS3BucketIfNotExists_NonNotFoundHeadErrorFailsClosed(t *testing.T) {
	c := covS3(t, map[string]covStubResponse{
		"HeadBucket": {err: errors.New("access denied")},
	})
	err := c.CreateS3BucketIfNotExists(context.Background(), "mybucket", "eu-central-1", false)
	if err == nil || !strings.Contains(err.Error(), "failed to check for bucket 'mybucket'") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_HardenBucket_EachStepReportsItsOwnFailure pins that every hardening step is
// checked and named — a silent partial hardening would leave a public/unencrypted bucket.
func TestCloud_HardenBucket_EachStepReportsItsOwnFailure(t *testing.T) {
	cases := []struct {
		op   string
		want string
	}{
		{"PutPublicAccessBlock", "failed to set public access block"},
		{"PutBucketEncryption", "failed to enable encryption"},
		{"PutBucketVersioning", "failed to enable versioning"},
		{"PutBucketOwnershipControls", "failed to set ownership controls"},
	}
	for _, tc := range cases {
		t.Run(tc.op, func(t *testing.T) {
			responses := covHardenOK()
			responses[tc.op] = covStubResponse{err: errors.New("nope")}
			c := covS3(t, responses)
			err := c.hardenBucket(context.Background(), "b")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
	c := covS3(t, covHardenOK())
	if err := c.hardenBucket(context.Background(), "b"); err != nil {
		t.Fatalf("all-green hardening: %v", err)
	}
}

// TestCloud_ListRegions_ReturnsNames pins that ListRegions flattens the describe response to
// region names, and that a describe failure is wrapped.
func TestCloud_ListRegions_ReturnsNames(t *testing.T) {
	c := covEC2(t, map[string]covStubResponse{
		"DescribeRegions": {result: &ec2.DescribeRegionsOutput{Regions: []ec2types.Region{
			{RegionName: strPtr("eu-central-1")},
			{RegionName: strPtr("us-east-1")},
		}}},
	})
	got, err := c.ListRegions(context.Background())
	if err != nil {
		t.Fatalf("ListRegions: %v", err)
	}
	if len(got) != 2 || got[0] != "eu-central-1" || got[1] != "us-east-1" {
		t.Fatalf("unexpected regions: %v", got)
	}

	bad := covEC2(t, map[string]covStubResponse{"DescribeRegions": {err: errors.New("boom")}})
	if _, err := bad.ListRegions(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "failed to describe regions") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_ListSubnets_MapsFieldsAndTreatsNilMapPublicAsFalse pins the subnet projection,
// including that a nil MapPublicIpOnLaunch is read as private rather than dereferenced.
func TestCloud_ListSubnets_MapsFieldsAndTreatsNilMapPublicAsFalse(t *testing.T) {
	c := covEC2(t, map[string]covStubResponse{
		"DescribeSubnets": {result: &ec2.DescribeSubnetsOutput{Subnets: []ec2types.Subnet{
			{SubnetId: strPtr("subnet-a"), CidrBlock: strPtr("10.0.1.0/24"), AvailabilityZone: strPtr("eu-central-1a"), VpcId: strPtr("vpc-1"), MapPublicIpOnLaunch: boolPtr(true)},
			{SubnetId: strPtr("subnet-b"), CidrBlock: strPtr("10.0.2.0/24"), AvailabilityZone: strPtr("eu-central-1b"), VpcId: strPtr("vpc-1")},
		}}},
	})
	got, err := c.ListSubnets(context.Background(), "vpc-1")
	if err != nil {
		t.Fatalf("ListSubnets: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 subnets, got %d", len(got))
	}
	if !got[0].MapPublicIpOnLaunch || got[0].ID != "subnet-a" || got[0].CIDR != "10.0.1.0/24" ||
		got[0].AvailabilityZone != "eu-central-1a" || got[0].VpcID != "vpc-1" {
		t.Fatalf("unexpected first subnet: %+v", got[0])
	}
	if got[1].MapPublicIpOnLaunch {
		t.Fatalf("nil MapPublicIpOnLaunch must read as false: %+v", got[1])
	}

	bad := covEC2(t, map[string]covStubResponse{"DescribeSubnets": {err: errors.New("boom")}})
	if _, err := bad.ListSubnets(context.Background(), "vpc-1"); err == nil ||
		!strings.Contains(err.Error(), "failed to describe subnets") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_ListVPCs_ReadsNameTag pins that the VPC "Name" tag is projected into Name (and
// that a VPC whose tags do not include one still lists, with an empty name).
func TestCloud_ListVPCs_ReadsNameTag(t *testing.T) {
	c := covEC2(t, map[string]covStubResponse{
		"DescribeVpcs": {result: &ec2.DescribeVpcsOutput{Vpcs: []ec2types.Vpc{
			{VpcId: strPtr("vpc-1"), CidrBlock: strPtr("10.0.0.0/16"), IsDefault: boolPtr(false), Tags: []ec2types.Tag{
				{Key: strPtr("env"), Value: strPtr("prod")},
				{Key: strPtr("Name"), Value: strPtr("primary")},
			}},
			{VpcId: strPtr("vpc-2"), CidrBlock: strPtr("172.31.0.0/16"), IsDefault: boolPtr(true)},
		}}},
	})
	got, err := c.ListVPCs(context.Background())
	if err != nil {
		t.Fatalf("ListVPCs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 vpcs, got %d", len(got))
	}
	if got[0].Name != "primary" || got[0].ID != "vpc-1" || got[0].CIDR != "10.0.0.0/16" || got[0].IsDefault {
		t.Fatalf("unexpected first vpc: %+v", got[0])
	}
	if got[1].Name != "" || !got[1].IsDefault {
		t.Fatalf("unexpected second vpc: %+v", got[1])
	}

	bad := covEC2(t, map[string]covStubResponse{"DescribeVpcs": {err: errors.New("boom")}})
	if _, err := bad.ListVPCs(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "failed to describe VPCs") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// covFakeIAM answers the four IAM role calls the per-namespace identity lifecycle makes.
type covFakeIAM struct {
	createOut *iam.CreateRoleOutput
	createErr error
	getOut    *iam.GetRoleOutput
	getErr    error
	updateErr error
	deleteErr error

	updateCalls int
}

func (f *covFakeIAM) CreateRole(context.Context, *iam.CreateRoleInput, ...func(*iam.Options)) (*iam.CreateRoleOutput, error) {
	return f.createOut, f.createErr
}
func (f *covFakeIAM) GetRole(context.Context, *iam.GetRoleInput, ...func(*iam.Options)) (*iam.GetRoleOutput, error) {
	return f.getOut, f.getErr
}
func (f *covFakeIAM) UpdateAssumeRolePolicy(context.Context, *iam.UpdateAssumeRolePolicyInput, ...func(*iam.Options)) (*iam.UpdateAssumeRolePolicyOutput, error) {
	f.updateCalls++
	return &iam.UpdateAssumeRolePolicyOutput{}, f.updateErr
}
func (f *covFakeIAM) DeleteRole(context.Context, *iam.DeleteRoleInput, ...func(*iam.Options)) (*iam.DeleteRoleOutput, error) {
	return &iam.DeleteRoleOutput{}, f.deleteErr
}

// TestCloud_EnsureNamespaceIRSARole_CreateReturningNoARNIsAnError pins that a CreateRole which
// reports success but carries no ARN is rejected rather than returning an empty role ARN — an
// empty ARN would be annotated onto the ServiceAccount and silently break impersonation.
func TestCloud_EnsureNamespaceIRSARole_CreateReturningNoARNIsAnError(t *testing.T) {
	for name, out := range map[string]*iam.CreateRoleOutput{
		"no role": {},
		"no arn":  {Role: &iamtypes.Role{}},
	} {
		t.Run(name, func(t *testing.T) {
			f := &covFakeIAM{createOut: out}
			if _, err := EnsureNamespaceIRSARole(context.Background(), f, "r", "{}", nil); err == nil ||
				!strings.Contains(err.Error(), "returned no ARN") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// TestCloud_EnsureNamespaceIRSARole_NonExistsErrorIsFatal pins that a create failure which is
// NOT "already exists" aborts — it must never fall through to the reconcile path.
func TestCloud_EnsureNamespaceIRSARole_NonExistsErrorIsFatal(t *testing.T) {
	f := &covFakeIAM{createErr: errors.New("access denied")}
	if _, err := EnsureNamespaceIRSARole(context.Background(), f, "r", "{}", nil); err == nil ||
		!strings.Contains(err.Error(), `create per-namespace role "r"`) {
		t.Fatalf("unexpected error: %v", err)
	}
	if f.updateCalls != 0 {
		t.Fatal("a fatal create error must not reconcile the trust policy")
	}
}

// TestCloud_EnsureNamespaceIRSARole_AlreadyExistsReconcilesTrust pins the idempotent path: an
// existing role has its trust policy reconciled and its ARN read back.
func TestCloud_EnsureNamespaceIRSARole_AlreadyExistsReconcilesTrust(t *testing.T) {
	arn := "arn:aws:iam::123456789012:role/alethia-ns-team-a-0badc0de"
	f := &covFakeIAM{
		createErr: &iamtypes.EntityAlreadyExistsException{},
		getOut:    &iam.GetRoleOutput{Role: &iamtypes.Role{Arn: strptr(arn)}},
	}
	got, err := EnsureNamespaceIRSARole(context.Background(), f, "r", "{}", namespaceRoleTags("c", "ns"))
	if err != nil {
		t.Fatalf("EnsureNamespaceIRSARole: %v", err)
	}
	if got != arn {
		t.Fatalf("want %q, got %q", arn, got)
	}
	if f.updateCalls != 1 {
		t.Fatalf("trust policy must be reconciled exactly once, got %d", f.updateCalls)
	}
}

// TestCloud_EnsureNamespaceIRSARole_ReconcileFailuresAreReported pins that each step of the
// already-exists path (update trust, get role, ARN present) fails closed with its own message.
func TestCloud_EnsureNamespaceIRSARole_ReconcileFailuresAreReported(t *testing.T) {
	exists := &iamtypes.EntityAlreadyExistsException{}
	cases := []struct {
		name string
		fake *covFakeIAM
		want string
	}{
		{"update fails", &covFakeIAM{createErr: exists, updateErr: errors.New("denied")}, "reconcile trust policy on existing role"},
		{"get fails", &covFakeIAM{createErr: exists, getErr: errors.New("denied")}, `get existing role "r"`},
		{"get returns no role", &covFakeIAM{createErr: exists, getOut: &iam.GetRoleOutput{}}, "returned no ARN"},
		{"get returns no arn", &covFakeIAM{createErr: exists, getOut: &iam.GetRoleOutput{Role: &iamtypes.Role{}}}, "returned no ARN"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := EnsureNamespaceIRSARole(context.Background(), tc.fake, "r", "{}", nil); err == nil ||
				!strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}
}

// TestCloud_DeleteNamespaceIRSARole_MissingRoleIsSuccess pins teardown: a deleted role, an
// already-absent role, and a genuine failure are told apart.
func TestCloud_DeleteNamespaceIRSARole_MissingRoleIsSuccess(t *testing.T) {
	if err := DeleteNamespaceIRSARole(context.Background(), &covFakeIAM{}, "r"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	notFound := &covFakeIAM{deleteErr: &iamtypes.NoSuchEntityException{}}
	if err := DeleteNamespaceIRSARole(context.Background(), notFound, "r"); err != nil {
		t.Fatalf("an absent role must not be an error: %v", err)
	}
	failing := &covFakeIAM{deleteErr: errors.New("denied")}
	if err := DeleteNamespaceIRSARole(context.Background(), failing, "r"); err == nil ||
		!strings.Contains(err.Error(), `delete per-namespace role "r"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCloud_NamespaceRoleTags_IdentifyTheManagedRole pins the three tags that make an
// Alethia-managed per-namespace role discoverable and cleanable out of band.
func TestCloud_NamespaceRoleTags_IdentifyTheManagedRole(t *testing.T) {
	tags := namespaceRoleTags("fabric-a", "team-ns")
	got := map[string]string{}
	for _, tag := range tags {
		got[*tag.Key] = *tag.Value
	}
	want := map[string]string{
		"alethia:managed-by": "fabric-namespace",
		"alethia:cluster":    "fabric-a",
		"alethia:namespace":  "team-ns",
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("tag %q: want %q, got %q", k, v, got[k])
		}
	}
	if len(tags) != len(want) {
		t.Fatalf("want %d tags, got %d", len(want), len(tags))
	}
}

// TestCloud_NamespaceRoleAndTrust_RejectsUnusableClusters pins the three fail-closed guards on
// the derivation: no IRSA issuer, an unparseable cluster ARN, and a non-https issuer.
func TestCloud_NamespaceRoleAndTrust_RejectsUnusableClusters(t *testing.T) {
	cases := []struct {
		name string
		conn EKSClusterConn
		want string
	}{
		{
			"no oidc issuer",
			EKSClusterConn{ARN: "arn:aws:eks:eu-central-1:123456789012:cluster/c"},
			"reports no OIDC issuer",
		},
		{
			"unparseable cluster arn",
			EKSClusterConn{ARN: "not-an-arn", OIDCIssuer: "https://oidc.eks.eu-central-1.amazonaws.com/id/ABC"},
			"cannot extract account id",
		},
		{
			"non-https issuer",
			EKSClusterConn{ARN: "arn:aws:eks:eu-central-1:123456789012:cluster/c", OIDCIssuer: "oidc.eks.eu-central-1.amazonaws.com/id/ABC"},
			"is not an https URL",
		},
		{
			"scheme-only issuer",
			EKSClusterConn{ARN: "arn:aws:eks:eu-central-1:123456789012:cluster/c", OIDCIssuer: "https://"},
			"has no host",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := namespaceRoleAndTrust(tc.conn, "c", "ns"); err == nil ||
				!strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want %q, got %v", tc.want, err)
			}
		})
	}

	// An empty namespace must not render a trust policy — `system:serviceaccount::*` would
	// scope the role to nothing recognisable.
	ok := EKSClusterConn{
		ARN:        "arn:aws:eks:eu-central-1:123456789012:cluster/c",
		OIDCIssuer: "https://oidc.eks.eu-central-1.amazonaws.com/id/ABC",
	}
	if _, _, err := namespaceRoleAndTrust(ok, "c", ""); err == nil ||
		!strings.Contains(err.Error(), "needs providerARN, conditionKey and namespace") {
		t.Fatalf("empty namespace: unexpected error %v", err)
	}

	// The resolvable case yields a deterministic role name and a trust scoped to `<ns>:*`.
	roleName, trust, err := namespaceRoleAndTrust(ok, "c", "team-ns")
	if err != nil {
		t.Fatalf("namespaceRoleAndTrust: %v", err)
	}
	if roleName != namespaceRoleName("c", "team-ns") {
		t.Fatalf("role name is not the deterministic derivation: %q", roleName)
	}
	for _, want := range []string{
		"arn:aws:iam::123456789012:oidc-provider/oidc.eks.eu-central-1.amazonaws.com/id/ABC",
		"system:serviceaccount:team-ns:*",
		"sts.amazonaws.com",
	} {
		if !strings.Contains(trust, want) {
			t.Fatalf("trust policy missing %q: %s", want, trust)
		}
	}
}

// TestCloud_BuildNamespaceTrustPolicy_RequiresEveryInput pins that a missing provider ARN,
// condition key or namespace is refused — a partially-rendered trust would widen the role.
func TestCloud_BuildNamespaceTrustPolicy_RequiresEveryInput(t *testing.T) {
	cases := [][3]string{
		{"", "key", "ns"},
		{"arn", "", "ns"},
		{"arn", "key", ""},
	}
	for _, c := range cases {
		if _, err := buildNamespaceTrustPolicy(c[0], c[1], c[2]); err == nil ||
			!strings.Contains(err.Error(), "needs providerARN, conditionKey and namespace") {
			t.Fatalf("%v: unexpected error %v", c, err)
		}
	}
}

// TestCloud_ProvisionNamespaceIdentity_FailsClosedWithoutCredentials pins that the ambient-session
// entrypoints surface a resolve failure rather than provisioning against a half-resolved session.
// With every credential source stripped the SDK fails before any request leaves the process.
func TestCloud_ProvisionNamespaceIdentity_FailsClosedWithoutCredentials(t *testing.T) {
	covNoCreds(t)
	ctx := context.Background()
	if _, err := ProvisionNamespaceIdentity(ctx, "eu-central-1", "cluster-a", "team-ns"); err == nil {
		t.Fatal("expected ProvisionNamespaceIdentity to fail without credentials")
	}
	if err := DeprovisionNamespaceIdentity(ctx, "eu-central-1", "cluster-a", "team-ns"); err == nil {
		t.Fatal("expected DeprovisionNamespaceIdentity to fail without credentials")
	}
}

// TestCloud_ProvisionNamespaceIdentity_ConfigLoadErrorIsWrapped pins that a broken shared-config
// profile is reported as a config-load failure by both ambient entrypoints.
func TestCloud_ProvisionNamespaceIdentity_ConfigLoadErrorIsWrapped(t *testing.T) {
	covNoCreds(t)
	t.Setenv("AWS_PROFILE", "alethia-cov-missing-profile")
	ctx := context.Background()
	if _, err := ProvisionNamespaceIdentity(ctx, "eu-central-1", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "load aws config") {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := DeprovisionNamespaceIdentity(ctx, "eu-central-1", "c", "ns"); err == nil ||
		!strings.Contains(err.Error(), "load aws config") {
		t.Fatalf("unexpected error: %v", err)
	}
}
