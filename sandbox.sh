#!/usr/bin/env bash
# Launches the sandbox, the engine's test player for local media, and opens it in the default browser.
#
# Checks that the npm dependencies are installed, then runs `npm run sandbox`, which builds the served assets with
# scripts/build.mjs and starts the Vite dev server from sandbox/vite.config.ts.
# The asset build stops with the command to run when the WebAssembly decoders are not built.
# Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

engine_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly engine_directory

open_browser=true
vite_arguments=()

print_usage() {
    cat <<'USAGE'
Usage: ./sandbox.sh [options] [Vite options]

Builds the engine's served assets, starts the sandbox's dev server, and opens it in the default browser.
In the page, click Pick folder, choose a folder of media, and click a file to play it.
Ctrl+C stops the server.

Options:
  --no-open    Start the server without opening a browser.
  -h, --help   Show this help.

Other options go to Vite, such as --port <number> to serve on another port.
Vite opens the browser that BROWSER names, when it is set.

The sandbox needs the npm dependencies and the WebAssembly decoders; see docs/src/setup.md.

Examples:
  ./sandbox.sh
  BROWSER=firefox ./sandbox.sh
  ./sandbox.sh --no-open --port 5190
USAGE
}

fail() {
    printf 'sandbox.sh: %s\n' "$*" >&2
    exit 1
}

# Options
while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-open)
            open_browser=false
            shift
            ;;
        -h | --help)
            print_usage
            exit 0
            ;;
        *)
            vite_arguments+=("$1")
            shift
            ;;
    esac
done

command -v node >/dev/null 2>&1 || fail 'node is required'
command -v npm >/dev/null 2>&1 || fail 'npm is required'
cd "$engine_directory"

# Every package the engine declares, looked up as Node does: upward from the engine, which covers a host workspace's node_modules
missing_packages="$(node -e '
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const manifest = require("./package.json");
const packageNames = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
const isInstalled = packageName => require.resolve.paths(packageName)
    .some(directory => existsSync(join(directory, packageName, "package.json")));
console.log(packageNames.filter(packageName => !isInstalled(packageName)).join(" "));
')" || fail 'Cannot read package.json'
# npm prefix names the host's root when a host lists the engine as a workspace, and the engine root otherwise
[ -z "$missing_packages" ] || fail "Missing npm packages: $missing_packages; run npm ci in $(npm prefix)"

if [ "$open_browser" = true ]; then
    vite_arguments+=('--open')
fi

# npm passes the arguments after -- to the script's last command, which is Vite
exec npm run sandbox -- ${vite_arguments[@]+"${vite_arguments[@]}"}
