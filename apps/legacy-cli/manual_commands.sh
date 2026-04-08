#!/bin/bash

# Set Variables
#IMAGE_NAME="082127478945.dkr.ecr.eu-central-1.amazonaws.com/idp-installer:latest"
IMAGE_NAME="automationscripts:latest"
#CONFIG_FILE_PATH="$(pwd)/$CONFIG_FILE"  # Path to config.yaml on the host
CONFIG_FILE="config.yaml" # Default value for config file
DRY_RUN_FLAG=""  # Default value for dry run flag

# Function to choose SSH key
choose_ssh_key() {
    # Scan for private keys
    keys=($(ls ~/.ssh/*.pub | sed 's/\.pub$//'))
    
    if [ ${#keys[@]} -eq 0 ]; then
        echo "No SSH keys found in ~/.ssh."
        exit 1
    elif [ ${#keys[@]} -eq 1 ]; then
        chosen_key=${keys[0]}
    else
        echo -e "Multiple SSH keys found\nPlease Choose the one which grants access to repositories.\nUsually either the default 'id_rsa' or one matching the username:"
        select key in "${keys[@]}"; do
            if [[ -n $key ]]; then
                chosen_key=$key
                break
            else
                echo "Invalid selection. Please try again."
            fi
        done
    fi
    
    echo "Using SSH key: $chosen_key"
    chosen_key=$(basename "$chosen_key")
}

# Function to choose AWS profile
choose_aws_profile() {
    # Parse the available profiles from ~/.aws/config
    #profiles=($(awk '/^\[/{gsub(/[\[\]]/,""); print $1}' ~/.aws/config))
    IFS=$'\n' profiles=($(awk '/^\[/{gsub(/^\[|\]$/,""); print $0}' ~/.aws/config))

    if [ ${#profiles[@]} -eq 0 ]; then
        echo "No AWS profiles found in ~/.aws/config."
        exit 1
    elif [ ${#profiles[@]} -eq 1 ]; then
        chosen_profile=${profiles[0]}
    else
        echo -e "Multiple AWS profiles found:"
        select profile in "${profiles[@]}"; do
            if [[ -n $profile ]]; then
                chosen_profile=$profile
                break
            else
                echo "Invalid selection. Please try again."
            fi
        done
    fi
    # Strip "profile " prefix if it exists
    chosen_profile="${chosen_profile#profile }"
    echo "Using AWS profile: $chosen_profile"
}

# Function to initialize
initialize() {
    choose_ssh_key
    choose_aws_profile
    
    # Ensure chosen_key is just the filename, not full path
    #chosen_key=$(basename "$chosen_key")
    cmd_ssh="eval \$(ssh-agent -s) && ssh-add /root/.ssh/${chosen_key}"

    # Since we have IDP in container and Templates are public
    # This should not require ssh-config
    ##cmd="cp -a /tmp/config /root/.ssh/config && ssh-keyscan github.com >> /root/.ssh/known_hosts && ssh-keyscan github.com >> /root/.ssh/known_hosts && cd /root/adp-client && ./idpinstall.py --awsprofile=${chosen_profile} ${DRY_RUN_FLAG} --config-file /root/config.yaml"
    cmd="ssh-keyscan github.com >> /root/.ssh/known_hosts && ssh-keyscan github.com >> /root/.ssh/known_hosts && cd /root/adp-client && ./idpinstall.py --awsprofile=${chosen_profile} ${DRY_RUN_FLAG} --config-file /root/config.yaml"
    # Determine if running on macOS
    if [[ "$OSTYPE" == "darwin"* ]]; then
        platform_arg="linux/amd64"
    else
        platform_arg="linux/amd64"
    fi

    # Convert CONFIG_FILE_PATH to an absolute path if it's relative
    if [[ ! "$CONFIG_FILE_PATH" = /* ]]; then
        CONFIG_FILE_PATH="$(pwd)/$(basename "$CONFIG_FILE_PATH")"
    fi
    # Debug
    echo "Chosen SSH key file: ~/.ssh/${chosen_key}"


    docker run --platform $platform_arg -e SSH_KEY_TO_USE=$chosen_key -e AWS_PROFILE=$chosen_profile -e USER=$USER --rm \
        -v "$CONFIG_FILE_PATH":/root/config.yaml \
        -v $HOME/.aws/config:/root/.aws/config:ro \
        -v $HOME/.ssh/:/tmp/.ssh/ \
        "$IMAGE_NAME" /bin/bash -c "cp -a /tmp/.ssh/$chosen_key /root/.ssh/$chosen_key && aws sso login --profile ${chosen_profile} && $cmd_ssh && $cmd"
}

# Check if the container is already running
if ! docker ps -q --filter "name=${IMAGE_NAME}" >/dev/null; then
    echo "Container is not running. Please start it"
fi

# Help message function
show_help() {
    echo -e "Usage: $0 {initialize|help} [options]\n"
    echo -e "  initialize - Run initialization script inside container\n"
    echo -e "  help       - Show this help message\n"
    echo -e "Options:\n"
    echo -e "  --dry-run - Run the script with the dry-run flag\n"
    echo -e "  --config-file   - Specify a custom config file\n"
    exit 1
}

# Check if at least one argument is provided
if [ $# -eq 0 ]; then
    show_help
fi

# Determine which action to perform
case "$1" in
    initialize)
        echo -e "We are Initializing\n"
        # Check for additional options
        shift
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --dry-run)
                    DRY_RUN_FLAG="--dry-run"
                    shift
                    ;;
                --config-file)
                    CONFIG_FILE_PATH="$2"
                    shift 2
                    ;;
                *)
                    echo -e "Error: Invalid option '$1'\n"
                    show_help
                    ;;
            esac
        done
        # Use default config file if none specified
        if [[ -z "$CONFIG_FILE_PATH" ]]; then
            CONFIG_FILE_PATH="$(pwd)/$CONFIG_FILE"
        fi
        initialize
        ;;
    help)
        show_help
        ;;
    *)
        echo -e "Error: Invalid argument '$1'\n"
        show_help
        ;;
esac
