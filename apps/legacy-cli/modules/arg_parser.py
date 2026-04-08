import argparse
import os

def parse_args():
    if ("test.py" in argparse._sys.argv[0]):
        required = False
    else:
        required = True

    parser = argparse.ArgumentParser(description='Process command line arguments.')

    # Create a mutually exclusive group for --dry-run and --create-state-bucket-only
    group = parser.add_mutually_exclusive_group()

    group.add_argument('--dry-run', action='store_true', help='Run in dry-run mode without making actual changes')
    group.add_argument('--create-state-bucket-only', action='store_true', help='Only create the state bucket if it does not exist, then exit.')

    parser.add_argument('--awsprofile', type=str, required=required, help='AWS profile name')
    parser.add_argument('--loglevel', type=str, required=False, help='Loglevel. warn, normal, critical. Default normal')
    parser.add_argument('--config-file', type=str, default='config/template.yml', help='Path to the config file. Default is config/template.yml')
    parser.add_argument('--infracost-token', type=str, required=False, help='Infracost API token')
    parser.add_argument('--update-infra', action='store_true', help='Update (overwrite) infrastructure (terraform) repository')
    parser.add_argument('--update-gitops', action='store_true', help='Update (overwrite) GitOps (argocd) repositories')
    parser.add_argument('--update-all', action='store_true', help='Update both infrastructure and GitOps repositories')
    parser.add_argument('--update-infra-facts-only', action='store_true', help='Update only the infra-facts.yaml in the repositories')

    args = parser.parse_args()

    if args.update_all:
        args.update_infra = True
        args.update_gitops = True

    # Set Infracost API key if provided
    if args.infracost_token:
        os.environ['INFRACOST_API_KEY'] = args.infracost_token

    return args
