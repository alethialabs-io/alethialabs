# idpinstaller
Installer for the ITGix Application Development Platform


## Getting started
This is a set of automation tools that will allow you to rapidly spin up an empty ready to go environment in AWS with Kubernetes and a database. 
Read below on what you need to configure as prerequisites to be able to use it.

## Description
The purpose of the platform is to provide a ready build solution for software and product companies to start easily develop their new product and host it’s production environment with build-in security and redundancy without the need to build a platform from scratch. Build upon best practices that we’ve gathered over the years working with more than 60 companies and hundreds of different applications and development processes and strategies. 

The platform is based on Kubernetes and is planned to include a full-featured source control system with ready pipelines for building a generic container image or custom tailored pipelines for some of the popular languages like golang, Java, Php.

It’s based on open source products so there is no vendor lock-in, the users of the platform have the option to maintain it themselves

It’s build with strong security measures, based on practices used in FinTech for payment providers and banks. It’s ready to pass SOC  or PCI-DSS security certification.

The main platform is using AWS cloud.



## Quickstart guide

### 1. Prerequisites: 

You'll need to create a set of git repositories for the automation to bootstrap your environment configuration and token to access them.

- Repository to host the generated terraform code
- Repository to host the generated Kubernetes manifests that install the services on the cluster
- Optional 3rd repository to store the manifests of your custom applications that run on top of the container platform


### 2. Prepare your machine to run the platform automation 

Next, you have to run the appopriate script for your operating system to install all command line tools and prerequisites:

 This needs to be executed only once to setup your host. It will download automatically all tools and repositories needed for environment provisioning.

   - For MacOS:
   ```
    chmod +x prepare-mac.sh
    ./prepare-mac.sh
   ```
   - For Linux:
   ```
    chmod +x prepare-host.sh
    ./prepare-host.sh
   ```

### 3. Setup AWS profile:

Generate an API KEY in AWS and store it under
~/.aws/credentials
```
[myaws]
aws_access_key_id = AKIxxxxxx
aws_secret_access_key = xxxxxx
```
Setup the main profile file where you choose your main region:
~/.aws/profile
```
[profile myaws]
region=eu-central-1
```

Or use ```aws configure --profile myaws``` for a wizzard to set those up.


Note: For SSO login read below.


### 4. Prepare AWS account
If you'll use dynamic domain registration features make sure that there is a working Route53 zoen in the AWS account you provision in. Setup the zone ID and main domain in the config file.

### 5. Configuration
Use the config generator at https://adp.itgix.com or write your yaml config by modifying the template file in config/template.yaml. There is a description of the configuration options below.
Store under a directory on your local machine where you have access to like the home directory ~/myconfig.yaml

### 6. Run the command to provision your environment
   You can run in dry-run mode to only see what the installer will do without actually creating resources. You'll need to create a state bucket first if it's the first time you're running with this config.
   ```
   ./idpinstall.py --awsprofile myaws --config-file ~/myconfig.yaml --create-state-bucket-only
   ./idpinstall.py --awsprofile myaws --config-file ~/myconfig.yaml --dry-run
   ```
   - Or you can run the script in order to create the resources, without the ``` --dry-run ``` flag:
   ```
   ./idpinstall.py --awsprofile myaws --config-file ~/myconfig.yaml 
   ```
   - In that time you can check the generated logs in the logs directory of the idp-installer repository.

## Work with your newly created environment

   - After the script finishes, you'll have to set your kubeconfig with the desired aks cluster - name of the cluster and region:
   ```
   aws eks update-kubeconfig list-clusters -region eu-central-1
   aws eks update-kubeconfig --name eks-ec1-dev-mysetup -region eu-central-1
   ```
   - You can check the created ingresses like this.  It takes 5-10 minutes to be created:
   ```
   kubectl get ing -A | grep argocd
   ```
   - And you can get the generated admin user password for argocd :
   ```
   kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d; echo
   ```


## Installation full guide

Either run the prepare-hosts.sh script or do the following to set-up your Python virtual environment and download required modules 

```
python3 -m venv venv
source ./venv/bin/activate
pip3 install --upgrade pip
pip3 install -r requirements.txt
deactivate

mkdir temp; mkdir git

./idpinstaller.py --awsprofile=itgixlab --dry-run

```

set access key and secret in ~/.aws/credentials


You need to have installed the following cli command tools:
- aws-cli
- helm
- terraform
- yq

## Requirements
To be able to run the script and bootstrap the application development platform you'll need to following prepared in advance

- AWS_PROFILE - with either credentials and pofile configured in .aws/config or an assumed role with Admin priviledges for the target AWS account
- Destination git repositories with SSH key allowed to access 
  - create repository for terraform code and configure it in the config ""
  - create application repository for argo CD in advance and configure it in the config "" with the https link
    - create an access token for this repository and specify it in the config. Needed rights: read_repository and developer role.
- Linux and python3.8 installed on the machine on which you'll run this


## Usage

Command line options:
Mandatory arguments:
```
  --awsprofile AWSPROFILE
                        the AWS profile name that is configured on the local machine typically under ~/.aws/config that 
                        info about the credentials to authenticate against AWS.
```
Optional arguments:
```
  -h, --help            show this help message and exit
  --loglevel LOGLEVEL   Loglevel. warn, normal, critical. Default normal
  --dry-run             Run in dry-run mode without making actual changes
  --config-file CONFIG_FILE
                        Path to the config file. Default is config/template.yml
  --create-state-bucket-only Only creates the tfstate s3 bucket if it does not exists and then exits. 
  --update-infra        Update (overwrite) infrastructure (terraform) repository
  --update-gitops       Update (overwrite) GitOps (argocd) repositories
  --update-all          Update both infrastructure and GitOps repositories
```

Examples

```
# Example with default config (config/template.yml) just to do dry-run without actually changing anything
./idpinstaller.py --awsprofile=itgixlab --dry-run
```

Specify a configuration file
```
# Exqample Specify config file
./idpinstaller.py --awsprofile=itgixlab --config-file config/demo-dev.yml

```

The Dry-run flag allows to run the script without making actual changes to the environemnt. This allows you to test certain config, check the Terraform plan 
before actually applying or check the generated files for the destination repositories before they're comitted and pushed


When using SSO you need to first configure the profile and login, then execute normally pointing to that profile:

```commandline
## in ~/.aws/config
[profile itgixlandingzone]
region=eu-central-1
sso_start_url=https://d-9067fxxxx.awsapps.com/start
sso_region=us-east-1
sso_account_id=9054180518XX
sso_role_name=AdministratorAccess

## Make sure you unset any old AWS keys you might have in your bash profile
$ unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
## export the configured profile
$ export AWS_PROFILE=itgixlandingzone
$ aws sso login --profile itgixlandingzone
Attempting to automatically open the SSO authorization page in your default browser.
If the browser does not open or you wish to use a different device to authorize this request, open the following URL:

https://device.sso.us-east-1.amazonaws.com/

Then enter the code:

XXX-XXX
Successfully logged into Start URL: https://d-9067f9b701.awsapps.com/start
$ ./idpinstaller.py --awsprofile itgixlandingzone --config-file config/itgix-landing-zone.yml
Start script.                                                                                       
Read configuration file: config/itgix-landing-zone.yml                                              
Overriding tfvars git/template_repo/variable-template/terraform.tfvars with config/itgix-landing-zone.yml
Generating backend config git/template_repo/backends/backend.tfvars                                 
Initializing Terraform ...    
```


After the deployment is finished you can get the generated password for Argo CD in the following way:

```commandline
export KUBECONFIG=$PWD/temp/kubeconfig
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | base64 -d
```

To get also the generated URL of Argo you can do the following:

```commandline
$ kubectl get ingress -n argocd
NAME            CLASS    HOSTS                                  ADDRESS                                                       PORTS   AGE
argocd-server   <none>   igxadp-eu-west-1-argocd-dev.itgix.eu   k8s-public-a517c30797-516243070.eu-west-1.elb.amazonaws.com   80      28m

```


## Configuration
You can have multiple central environment configuration yaml files copied from the template.

Here is the set of available configuration options.

Mandatory:

| Option | default     | Description                                                                                                                                                                   |
|--------|-------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| project_name | no default  | The name of the project, it will be used in the naming convention , please keep short under 4 lett                                                                            |
| environment | no default  | Environment stage - sample - dev,stg,prd , but it can be any name , please keep under 4 letters                                                                               |
| region | no default  | The region in AWS, can be eu-central-1 , eu-west-2	, us-east-1	, or any of https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RegionsAndAvailabilityZones.html   |
| aws_account_id | no default  | The AWS account ID  , unique number of the AWS tenant account to be used for this environment                                                                                 |
| env_template_repo || Source git repository for the environment template, this is the template fo IaC that will be used to bootstrap the current environemnt                                        | 
| env_template_repo_branch | | Branch of the template repository to be used                                                                                                                                  |
| env_git_repo | | Destination git repository that will be bootstrapped from the template and from there the terraform code will be applied.                                                     |
| gitops_template_repo | | Source git repository for the teplate of infastructure services that will run on the container platform , like service for managing ALBs, DNS , secrets, autoscaling and more |
| gitops_destination_repo | | Destination git repository that will be bootstrapped with infrastructure services, where argocd will be pointed to, should be a http/s as this is the protocol Argo expects |
| gitops_argo_access_token| | access token for the desitnation git repositories with read access that ArgoCD will use to get it's configuration |
| gitops_argo_access_token| | access token for the desitnation git repositories with read access that ArgoCD will use to get it's configuration |
| enable_karpenter| ||



Optional:

| Option                          | default                    | Description                                                                                                                                                                                                                                             |
|---------------------------------|----------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| terraform_ver                   | 1.7.0                      | Version of the terraform binary that will be auto-downloaded and used                                                                                                                                                                                   |
| applications_template_repo      | none                       | Source git repository for the teplate of custom applications that will run on the container platform. If left empty no application bootstrapping will be done                                                                                           |
| applications_template_repo_branch | | Branch of the applications template repository to be used                                                                                                                                  |
| applications_destination_repo   | none                       | Destination git repository that will be bootstrapped with application repo template , where argocd will be pointed to, should be a http/s as this is the protocol Argo expects. If left empty no application bootstrapping will be done                 |
| applications_argo_access_token  | none                       | access token for the desitnation git repositories with read access that ArgoCD will use to get it's configuration.If left empty no application bootstrapping will be done                                                                               |
| gitops_template_repo_branch | | Branch of the gitops template repository to be used                                                                                                                                  |
| eks_aws_auth_users              | user used for provisioning | providing additional IAM users to have access to Kubernetes apart from the user used for provisioning.  It should be a yaml list containing "username" and "group" as shown in the example below                                                        |
| custom_secrets                  | none                       | Optionally generate random secrets in Secrets manager to be used later by applications. Samples provided below and in the template file                                                                                                                 |
| acm_certificate_enable          | true                       | If you would like to request an Amazon managed server wildcard certificate for the configured main domain. This has a pre-requisite to have a managed DNS zone in Route53 to automate the verification process, so if you don't have, set this to false |

We can additionally override any of the exposed terraform variables as described below

Overriding terraform variables.

In order to override a terraform variable that you have a default for in the tf template you can place in the yaml file a variable with the same name.
We have access to all the variables that are in the variable template standard-env/variable-template/terraform.tfvars
Some specifics when needing lists or maps:
```
In tfvars we have
addons_versions = {
  coredns    = "v1.11.1-eksbuild.4"
  kube_proxy = "v1.29.0-eksbuild.1"
  vpc_cni    = "v1.16.0-eksbuild.1"
  ebs_csi    = "v1.27.0-eksbuild.1"
}
```

### VPC Configuration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `provision_vpc` | bool | Whether to provision a new VPC. | `true` |
| `vpc_cidr` | string | CIDR block for the VPC. | `"10.61.0.0/16"` |
| `vpc_single_nat_gateway` | bool | Use a single NAT gateway instead of multiple. | `true` |

---

### DNS Configuration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `dns_hosted_zone` | string | AWS Route53 Hosted Zone ID. | `"Z32O12XQLNTSW2"` |
| `dns_main_domain` | string | Primary DNS domain for the environment. | `"itgix.eu"` |

---

### RDS Configuration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `create_rds` | bool | Whether to create an RDS instance. | `false` |
| `rds_scaling_config.min_capacity` | float | Minimum Aurora Serverless v2 capacity units. | `0.5` |
| `rds_allowed_cidr_blocks` | list | Additional CIDR blocks allowed to access the DB. | `["10.50.0.0/16", "10.51.0.0/16"]` |

---

### EKS Configuration

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `eks_automode_enabled` | bool | Enable Amazon EKS Auto Mode. | `true` |
| `eks_cluster_admins` | list | List of IAM usernames with admin rights in EKS. | `[{ username: "ytodorov" }, { username: "mvukadinoff" }]` |
| `eks_aws_users_path` | string | Path for AWS IAM users in the config map. | `"/users/"` |
| `eks_ng_min_size` | int | Minimum number of nodes in a node group. | `3` |
| `eks_ng_desired_size` | int | Desired number of nodes. | `4` |
| `eks_ng_max_size` | int | Maximum number of nodes. | `4` |
| `eks_ng_capacity_type` | string | Node capacity type (`SPOT` or `ON_DEMAND`). | `"SPOT"` |

---

### AWS Services Toggles

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `provision_sqs` | bool | Provision SQS queues. | `false` |
| `application_waf_enabled` | bool | Enable WAF for application load balancers. | `true` |
| `cloudfront_waf_enabled` | bool | Enable WAF for CloudFront. | `false` |
| `create_elasticache_redis` | bool | Provision ElastiCache Redis. | `true` |
| `redis_allowed_cidr_blocks` | list | CIDR blocks allowed for Redis access. | `["10.56.0.0/16"]` |
| `enable_karpenter` | bool | Enable Karpenter autoscaler. | `true` |
| `provision_ecr` | bool | Provision Amazon ECR repositories. | `false` |
| `enable_fluent_bit` | bool | Enable Fluent Bit logging. | `true` |
| `aws_loadbalancer_enabled` | bool | Enable AWS Load Balancer Controller. | `true` |
| `external_dns_enabled` | bool | Enable External DNS for Kubernetes. | `true` |
| `external_secrets_enabled` | bool | Enable External Secrets Operator. | `true` |
| `enable_metrics_server` | bool | Enable Metrics Server for Kubernetes. | `true` |
| `enable_vpa` | bool | Enable Vertical Pod Autoscaler. | `true` |
| `enable_kyverno` | bool | Enable Kyverno policy engine. | `true` |
| `enable_policy_reporter` | bool | Enable Policy Reporter. | `true` |
| `enable_default_policies` | bool | Apply default security policies. | `true` |
| `demo_app_enabled` | bool | Deploy sample demo application. | `true` |
| `adp_agent_enabled` | bool | Enable ADP agent for telemetry. | `true` |
| `enable_prometheus_stack` | bool | Enable Prometheus monitoring stack. | `true` |
| `enable_tempo` | bool | Enable Tempo tracing. | `true` |
| `enable_loki` | bool | Enable Loki logging. | `true` |

---

### ACM / TLS

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `acm_certificate_enable` | bool | Automatically create a wildcard ACM certificate. | `true` |

---

### S3 Buckets

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `s3_create` | bool | Whether to create S3 buckets. | `true` |
| `bucket_configuration` | list | List of S3 bucket configurations (see below). | *See sample* |

**Bucket configuration fields:**

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `bucket_name_suffix` | string | Suffix for the bucket name. | `"rag-demo"` |
| `acl_type` | string | ACL type for the bucket. | `"log-delivery-write"` |
| `create_s3_user` | bool | Create a dedicated IAM user for the bucket. | `false` |
| `versioning_enabled` | bool | Enable versioning. | `true` |
| `sse_algorithm` | string | Server-side encryption algorithm. | `"AES256"` |
| `store_access_key_in_ssm` | bool | Store generated access keys in SSM. | `true` |
| `block_public_acls` | bool | Block public ACLs. | `false` |
| `block_public_policy` | bool | Block public bucket policies. | `false` |
| `ignore_public_acls` | bool | Ignore public ACLs. | `true` |
| `restrict_public_buckets` | bool | Restrict public buckets. | `true` |
| `cors_configuration` | list | CORS configuration rules. | `[]` |

---

### Secrets

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `custom_secrets` | list | List of custom secrets to generate in AWS Secrets Manager. | `[{ secret_name: "qdrant-env-secret", length: 20, special: false }]` |

---

### Naming

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `allow_long_names` | bool | Allow resource names longer than AWS defaults. | `false` |

---

### AWS WAF Override Rules

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `rules` | list | Custom WAF rule overrides. | See sample YAML |

---


In the config yaml we are allowed to override in the following way

```
addons_version:
  kube_proxy: "some_other_version"
```

Sample for providing additional IAM users to have access to Kubernetes apart from the user used for provisioning 
```commandline
eks_cluster_admins:
  - username: "myuser"
    path: /
  - username: "anotheruser"
    path: /
```

For more info on the available options please check the readme of the template terraform repository

## Upgrade Notes for Versions with Breaking Changes

### Update to ADP v1.1.3 - upgrading legacy EKS cluster to use Access Entries

The `v1.1.3` upgrade makes the shift towards `API_AND_CONFIGMAP` authentication_mode and EKS Access Entries. During this the EKS automatically makes translates the original cluster creator to an eks entry which will cause an error if you try to add the same using the `eks_cluster_admins` variable. So in this case you'll want to either not specify the original cluster creator in the variable OR import it with terraform.

This might look like this (depending on the existing entry's principal ARN):
```
terraform import -var-file=config/stg/eu-west-1/terraform.tfvars "module.eks[0].module.eks.aws_eks_access_entry.this[\"htonev\"]" eks-ew1-stg-igxadp:arn:aws:iam::XXXXXXXXXXXX:user/users/htonev
```

## Update to ADP v1.2.3 with Kubernetes 1.33

Before making the upgrade to version 1.33, you have to update the AMI version.
If you have used until now the adp-tf-envtempl-standard with tag v1.2.2, you have to change it to version v1.2.3, where we have the new AMI type, and run the idp-installer in order to change the AMY type.
  
https://github.com/itgix/adp-tf-envtempl-standard/blob/develop/variables.tf#L147

  ```
  variable "eks_ami_type" {
  description = "Default AMI type for the EKS worker nodes"
  type        = string
  default     = "BOTTLEROCKET_x86_64"
  }
  
  ```
After that you have to run once again the idp-installer, but this time change the eks_cluster_version to 1.33 and the addons versions 
Example:
  ```
  # EKS related variable
  eks_cluster_version: "1.33"
  addons_versions:
   coredns: "v1.12.3-eksbuild.1"
   kube_proxy: "v1.33.3-eksbuild.6"
   vpc_cni: "v1.20.1-eksbuild.5"
   ebs_csi: "v1.48.0-eksbuild.1"
 
 ```
 If you use Karpenter you can run :
 ./idpinstall.py --update-gitops --awsprofile your-profile --config-file config/idp-client-configs/template.yml

So that it updates the following variable in the helm/karpenter/values/stage/region/values.yaml file:  amiFamily: Bottlerocket

## Upgrade to ADP profile v1.2.7 and v1.2.8 wich upgrades Karpenter to v1.8.1
1. We have to completely drain and scale down the karpenter provisioned nodes.
For that purpose we have two options:
   - We can temporary scale up our current nodegroup and move the workloads there, uninstall and install karpenter and then scale down the temporary nodegroup. Take in mind that during scale down, the oldest nodes will be deleted and all workloads will be moved across the new nodes of the cluster nodegroup.
   - We can create second node group with second role attached to it (giving the same permissions of the old node group's role)

When we have the new nodes up and running, we can drain the karpenter provisioned nodes.

2. Afterwards we have to disable and uninstall Karpenter and remove any remaining resources and crds:

```
kubectl get nodeclaims
kubectl get ec2nodeclasses
kubectl get nodepools

```

If we have found any resources, we have to delete them:

```
kubectl delete nodeclaims <NodeClaimName>
kubectl delete ec2nodeclasses <ec2nodeclassesName>
Kubectl delete nodepools <nodepoolsName>

```

If any of the upper-given resources stuck in deleting state, we can patch the finalizers, for instance:

```
kubectl patch ec2nodeclasses default   --type=json   -p='[{"op":"remove","path":"/metadata/finalizers"}]'

```
After that we can safely delete the crds:

```
kubectl get crd | grep karpenter
ec2nodeclasses.karpenter.k8s.aws                        2026-02-03T08:52:23Z
nodeclaims.karpenter.sh                                 2026-02-03T08:52:23Z
nodepools.karpenter.sh                                  2026-02-03T08:52:23Z

kubectl delete crd ec2nodeclasses.karpenter.k8s.aws
kubectl delete crd nodeclaims.karpenter.sh
kubectl delete crd nodeclaims.karpenter.sh

```
3. And with that we are ready to install the new version of karpenter:

We have to add the new tags in the environment config file:

```

env_template_repo: "git@github.com:itgix/adp-tf-envtempl-standard.git"
env_template_repo_branch: "v1.2.7"

gitops_template_repo: "git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git"
gitops_template_repo_branch: "v1.2.8"

```

And run the platform with --update-all flag:

```
./idpinstall.py --awsprofile <example> --config-file <path_to_env_config_file.yaml> --update-all

```

## Support
Rocket channel
```
#ITGix-Container-platform
```
or log issues here in Github


## Roadmap

- further expand the AI profile to include local model run in Kubernetes
  
- Adapt profiles to be PCIDSS and SOC2 compliant

- Self service portal with AI agents to execute the DevOps engineer tasks for updating the gitops repositories

- Capability to deploy in Azure

## Contributing
We welcome contributions from the community

If you’re interested in contributing to this project or any of its related open-source components (templates, profiles, tooling, or documentation), there are several ways to get involved:

Open an issue to report bugs, suggest improvements, or propose new features

Fork the repository and submit a pull request

Join the discussion on CNCF Slack and reach out to Mihail Vukadinoff

Review existing issues and help with testing, documentation, or code reviews

Before submitting a pull request:

Keep changes focused and well-scoped

Follow existing patterns and conventions

Add or update documentation where relevant

By participating in this project, you agree to follow our code of conduct and collaborate in a respectful, constructive way.

Thank you for helping improve the project!

## Authors and acknowledgment

main contributors from ITGix

Hristyan Tonev

Mihail Vukadinoff

Vladimir Dimitrov

Stanislava Racheva

Tsvetana Kanzova

## License
GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007
