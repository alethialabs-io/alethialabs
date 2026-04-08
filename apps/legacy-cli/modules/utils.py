import subprocess
import os
import platform
from modules.logs import LOGS

myLOGS = LOGS()


def execute(CMD, log_file=None, append=False, exit_on_failure=False, silent=False, display_cmd=None):
    myLOGS.log("normal", f"Executing: {display_cmd or CMD}")

    mode = 'a' if append else 'w'

    if log_file:
        with open(log_file, mode) as lf:
            result = subprocess.run(CMD, shell=True, stdout=lf, stderr=lf)
    else:
        result = subprocess.run(CMD, shell=True, capture_output=True, text=True)

    if result.returncode != 0:
        if not silent:
            myLOGS.log("critical", f"Command failed with return code {result.returncode}.")
            myLOGS.log("critical", f"Check the log file: {log_file}" if log_file else f"Error output: {result.stderr.strip()}")

        if exit_on_failure:
            exit(1)
        raise RuntimeError(f"Command failed with return code {result.returncode}")

    return None if log_file else result.stdout.strip()


def get_system_architecture():
    """Detect system architecture and platform for downloading appropriate binaries."""
    system_type = platform.system().lower()
    cpu_arch = platform.machine().lower()

    if system_type not in ['linux', 'darwin']:
        myLOGS.log("error", f"Unsupported system type: {system_type}")
        raise ValueError(f"Unsupported system type: {system_type}")

    if cpu_arch in ['arm', 'arm64']:
        arch = cpu_arch
    elif 'x86_64' in cpu_arch or 'amd64' in cpu_arch:
        arch = 'amd64'
    else:
        arch = 'amd64'  # Default to amd64 if unrecognized

    return system_type, arch
