#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLANTUML_DIR="$SCRIPT_DIR/plantuml/"
JAR="$SCRIPT_DIR/plantuml-mit-1.2026.2.jar"
PLANTUML_ARGS="-tsvg --ignore-startuml-filename"

get_mtime() {
    stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# Resolve SVG path: with --ignore-startuml-filename the name matches the source,
# but fall back to parsing @startuml for compatibility without that flag
get_svg_path() {
    local puml="$1"
    local simple="${puml%.puml}.svg"
    [ -f "$simple" ] && { echo "$simple"; return; }
    local name=$(sed -n 's/^@startuml \+\(.\+\)/\1/p' "$puml" | head -1)
    if [ -n "$name" ]; then
        echo "$PLANTUML_DIR/$name.svg"
    else
        echo "$simple"
    fi
}

needs_compile() {
    local puml="$1"
    local svg=$(get_svg_path "$puml")
    [ ! -f "$svg" ] && return 0
    local puml_mt=$(get_mtime "$puml")
    local svg_mt=$(get_mtime "$svg")
    [ "$puml_mt" -gt "$svg_mt" ] 2>/dev/null
}

declare -A MTIMES
declare -A COMPILING

echo "Compiling stale .puml files..."
PIDS=()
for f in "$PLANTUML_DIR"/*.puml; do
    [ -f "$f" ] || continue
    if needs_compile "$f"; then
        echo "Compiling: $(basename "$f")"
        COMPILING[$f]=1
        java -jar "$JAR" $PLANTUML_ARGS "$f" -o "$PLANTUML_DIR" &
        PIDS+=($!)
    fi
done
for pid in "${PIDS[@]}"; do wait "$pid"; done
for f in "$PLANTUML_DIR"/*.puml; do
    [ -f "$f" ] || continue
    MTIMES[$f]=$(get_mtime "$f")
    unset "COMPILING[$f]"
done
echo "Watching for changes (press Enter to force check, Ctrl+C to stop)..."

check_files() {
    declare -A SEEN
    PIDS=()
    COMPILE_LIST=()
    for f in "$PLANTUML_DIR"/*.puml; do
        [ -f "$f" ] || continue
        SEEN[$f]=1
        [ -n "${COMPILING[$f]}" ] && continue
        mtime=$(get_mtime "$f")
        prev="${MTIMES[$f]}"
        if [ -z "$prev" ]; then
            echo "New: $(basename "$f") — compiling..."
            COMPILING[$f]=1
            COMPILE_LIST+=("$f")
            java -jar "$JAR" $PLANTUML_ARGS "$f" -o "$PLANTUML_DIR" &
            PIDS+=($!)
        elif [ "$mtime" != "$prev" ]; then
            echo "Changed: $(basename "$f") — recompiling..."
            COMPILING[$f]=1
            COMPILE_LIST+=("$f")
            java -jar "$JAR" $PLANTUML_ARGS "$f" -o "$PLANTUML_DIR" &
            PIDS+=($!)
        fi
        MTIMES[$f]="$mtime"
    done
    for pid in "${PIDS[@]}"; do wait "$pid"; done
    # Refresh mtimes after compile and clear dirty flags
    for f in "${COMPILE_LIST[@]}"; do
        MTIMES[$f]=$(get_mtime "$f")
        unset "COMPILING[$f]"
    done
    for f in "${!MTIMES[@]}"; do
        if [ -z "${SEEN[$f]}" ]; then
            echo "Removed: $(basename "$f")"
            unset "MTIMES[$f]"
        fi
    done
    unset SEEN
}

while true; do
    if read -t 1 -s; then
        echo "Manual check..."
        check_files
    else
        check_files
    fi
done
