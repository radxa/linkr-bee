#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEFAULT_IMAGE="$SCRIPT_DIR/linkr-ble-esp32c3-supermini.bin"
if [ ! -f "$DEFAULT_IMAGE" ]; then
    DEFAULT_IMAGE="$SCRIPT_DIR/../dist/linkr-ble-esp32c3-supermini.bin"
fi

IMAGE=$DEFAULT_IMAGE
PORT=${LINKR_PORT:-}
BAUD=${LINKR_BAUD:-921600}

usage() {
    cat <<EOF
Usage: $(basename "$0") [--port DEVICE] [--image FILE] [--baud RATE]

Flash the Linkr BMC Lite ESP32-C3 Super Mini image without erasing settings.
Environment overrides: LINKR_PORT, LINKR_BAUD.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --port)
            PORT=$2
            shift 2
            ;;
        --image)
            IMAGE=$2
            shift 2
            ;;
        --baud)
            BAUD=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [ ! -f "$IMAGE" ]; then
    echo "Firmware image not found: $IMAGE" >&2
    exit 1
fi

if [ -z "$PORT" ]; then
    matches=""
    for candidate in /dev/cu.usbmodem* /dev/ttyACM* /dev/ttyUSB*; do
        if [ -e "$candidate" ]; then
            matches="${matches}${matches:+
}$candidate"
        fi
    done
    count=$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
    if [ "$count" -eq 1 ]; then
        PORT=$matches
    elif [ "$count" -eq 0 ]; then
        echo "No ESP32 serial device found; pass --port DEVICE." >&2
        exit 1
    else
        echo "Multiple serial devices found; pass --port DEVICE:" >&2
        printf '%s\n' "$matches" >&2
        exit 1
    fi
fi

run_esptool() {
    if command -v esptool >/dev/null 2>&1; then
        esptool "$@"
    elif python3 -c 'import esptool' >/dev/null 2>&1; then
        python3 -m esptool "$@"
    else
        echo "esptool is not installed. Install it with: python3 -m pip install esptool" >&2
        exit 1
    fi
}

echo "Flashing $IMAGE to $PORT at $BAUD baud"
run_esptool --chip esp32c3 --port "$PORT" --baud "$BAUD" \
    write-flash 0x0 "$IMAGE"
echo "Flash complete."
