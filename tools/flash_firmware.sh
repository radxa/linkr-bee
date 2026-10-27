#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${LINKR_IMAGE:-}
CHIP=${LINKR_CHIP:-}
FLASH_ADDRESS=${LINKR_FLASH_ADDRESS:-}
PORT=${LINKR_PORT:-}
BAUD=${LINKR_BAUD:-921600}

usage() {
    cat <<EOF
Usage: $(basename "$0") [--port DEVICE] [--image FILE] [--chip CHIP]
       [--address OFFSET] [--baud RATE]

Flash a Linkr Bee ESP32-WROOM-32, ESP32-CAM, ESP32-C3 or ESP32-C5 image
without erasing settings. The ESP32-CAM has no USB-serial bridge: connect a
3.3 V USB-UART adapter to U0T/U0R (GPIO1/GPIO3) and hold GPIO0 low while
resetting to enter the ROM downloader.
CHIP and OFFSET are inferred for standard artifact filenames.
Environment overrides: LINKR_IMAGE, LINKR_CHIP, LINKR_FLASH_ADDRESS,
LINKR_PORT, LINKR_BAUD.
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
        --chip)
            CHIP=$2
            shift 2
            ;;
        --address)
            FLASH_ADDRESS=$2
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

if [ -z "$IMAGE" ]; then
    # Discover the packaged image by name rather than enumerating board slugs,
    # so a new board artifact needs no change here. The released bundle keeps
    # the script next to the image, which makes "$SCRIPT_DIR" and
    # "$SCRIPT_DIR/../dist" the same directory: visit each real path once so a
    # single image is not reported as "multiple images".
    matches=""
    seen_dirs=""
    for dir in "$SCRIPT_DIR" "$SCRIPT_DIR/../dist"; do
        [ -d "$dir" ] || continue
        real_dir=$(CDPATH='' cd -- "$dir" && pwd)
        case " $seen_dirs " in
            *" $real_dir "*) continue ;;
        esac
        seen_dirs="$seen_dirs $real_dir"
        for candidate in "$real_dir"/linkr-bee-*.bin "$real_dir"/linkr-ble-*.bin; do
            if [ -f "$candidate" ]; then
                matches="${matches}${matches:+
}$candidate"
            fi
        done
    done
    count=$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
    if [ "$count" -eq 1 ]; then
        IMAGE=$matches
    elif [ "$count" -gt 1 ]; then
        echo "Multiple firmware images found; pass --image FILE:" >&2
        printf '%s\n' "$matches" >&2
        exit 1
    fi
fi

if [ -z "$IMAGE" ] || [ ! -f "$IMAGE" ]; then
    echo "Firmware image not found: $IMAGE" >&2
    exit 1
fi

if [ -z "$CHIP" ]; then
    case "$(basename "$IMAGE")" in
        *esp32c3*) CHIP=esp32c3 ;;
        *esp32c5*) CHIP=esp32c5 ;;
        *esp32-wroom-32*) CHIP=esp32 ;;
        *esp32-cam*) CHIP=esp32 ;;
        *)
            echo "Cannot infer chip from image name; pass --chip." >&2
            exit 1
            ;;
    esac
fi
case "$CHIP" in
    esp32)
        : "${FLASH_ADDRESS:=0x1000}"
        ;;
    esp32c3)
        : "${FLASH_ADDRESS:=0x0}"
        ;;
    esp32c5)
        : "${FLASH_ADDRESS:=0x2000}"
        ;;
    *)
        echo "Unsupported chip: $CHIP (expected esp32, esp32c3 or esp32c5)" >&2
        exit 2
        ;;
esac

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

# Releases ship a SHA256SUMS next to the image. Verify it when present so a
# truncated or substituted download never reaches the board.
verify_checksum() {
    checksums="$(dirname -- "$IMAGE")/SHA256SUMS"
    [ -f "$checksums" ] || return 0

    expected=$(awk -v name="$(basename -- "$IMAGE")" \
        '$2 == name || $2 == "*" name { print $1; exit }' "$checksums")
    if [ -z "$expected" ]; then
        echo "SHA256SUMS does not list $(basename -- "$IMAGE"); skipping verification" >&2
        return 0
    fi

    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$IMAGE" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        actual=$(shasum -a 256 "$IMAGE" | awk '{print $1}')
    else
        echo "no sha256 tool found; skipping checksum verification" >&2
        return 0
    fi

    if [ "$actual" != "$expected" ]; then
        echo "Checksum mismatch for $IMAGE" >&2
        echo "  expected $expected" >&2
        echo "  actual   $actual" >&2
        exit 1
    fi
    echo "Checksum verified: $expected"
}

verify_checksum

echo "Flashing $IMAGE to $PORT ($CHIP, address $FLASH_ADDRESS) at $BAUD baud"
run_esptool --chip "$CHIP" --port "$PORT" --baud "$BAUD" \
    write-flash "$FLASH_ADDRESS" "$IMAGE"
echo "Flash complete."
