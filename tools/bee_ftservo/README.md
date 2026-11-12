# Bee FT servo debugger

Drive a FEETECH bus servo (STS/SMS/SCS family, e.g. STS3215) through a Linkr
Bee, over Bluetooth LE, using the official
[ftservo-python-sdk](https://github.com/ftservo/FTServo_Python) packet layer.
No USB-TTL adapter and no cable to the robot.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

There is also a browser-only counterpart, [web/servo.html](../../web/servo.html):
it implements the same packet layer in JavaScript and talks to the Bee with Web
Bluetooth, so it needs neither Python nor a host. Its tabs mirror the vendor
utility: bench (position control with normal/sync/async writes, live feedback,
a scrolling chart with CSV export, per-channel vertical bounds, horizontal
zoom/offset, and a step/sweep auto test) and program
(register table, JSON parameter save/load/restore, midpoint calibration,
factory restore). It identifies SCS0009, STS3215 and HD1910 from the model
bytes and switches byte order, travel range, lock/offset registers, register
table and position-write layout accordingly. SCS servos get the documented
motor mode (time register) instead of the STS wheel mode. The vendor utility's
PWM tab is a PWM-signal generator on its debug board, which the Bee's J7 UART
does not provide, so the page does not fake it. Use the Python tool below for
scripts and agents; use the page when you want a servo bench in Chrome.

## How it fits together

```text
host: bee_ftservo.py + ftservo-python-sdk
        │  BLE (Nordic UART Service bytes + Management v1 commands)
        ▼
Linkr Bee  ── J7 UART ──►  FEETECH half-duplex bus  ──►  servo(s)
   │
   └─ @u=1000000,8,n,1,none sets the bus baud rate
```

The Bee's NUS characteristic is a raw byte pipe in both directions, and the
Management service can change the UART format at run time. A servo bus is
therefore just a serial port that happens to be 15–40 ms away.

## Wiring

J7 on Linkr Bee X1.0 (and the same UART pins on the other supported boards):

| J7 | Signal | Connect to |
| --- | --- | --- |
| 1 | UART RX (GPIO20) | servo signal wire, together with J7.2 |
| 2 | UART TX (GPIO21) | servo signal wire, together with J7.1 |
| 3 | GND | servo GND **and** the servo power supply GND |
| 4 | 5 V **input** | leave open; it powers the Bee, it does not power servos |

A FEETECH bus servo has one shared signal wire, so tie **J7.1 and J7.2
together** and run one wire to the servo's signal pin. The X1.0 board already
makes this safe: J7.1 has a 4.7 kΩ pull-up and a 1 kΩ series resistor, J7.2 has
a 499 Ω series resistor, so a servo that drives the wire while the Bee idles
only fights ~6.6 mA. This is the same "tie TX and RX through a resistor"
technique used for [ST3215 on an ESP32](https://github.com/sepastian/ESP32_ST3215).

- **Power the servo from its own supply** (6–12 V depending on the model), and
  share ground with J7.3. Never back-feed the servo supply from the Bee.
- The bus is 3.3 V TTL. STS3215 is a 3.3 V part; an older SCS servo may idle at
  5 V, in which case add a level shifter before J7.
- Keep the signal wire short (a few tens of centimetres) and do not also leave
  the Bee's J7 connected to a target board's console — the servo bus and a
  console cannot share one UART.

If you use a direction-controlled half-duplex adapter (a buffer with OE driven
by TX) instead of the jumper, there is no echo; the tool handles both, see
`--echo`.

## Install

```sh
python3 -m pip install bleak ftservo-python-sdk
```

`bleak` is the BLE host stack; `ftservo-python-sdk` is the FEETECH SDK that
supplies `sms_sts` and the packet handler.

## Use

```sh
# what is connected, and which UART format the Bee is using
python3 tools/bee_ftservo/bee_ftservo.py info

# let the tool hot-swap the servo bus, and give the UART back afterwards
python3 tools/bee_ftservo/bee_ftservo.py --restore-uart scan --ids 1-12

# telemetry, then move
python3 tools/bee_ftservo/bee_ftservo.py status 1
python3 tools/bee_ftservo/bee_ftservo.py move 1 2048 --speed 2400 --acc 50
python3 tools/bee_ftservo/bee_ftservo.py monitor 1 --hz 5

# bring-up probe: a raw PING packet for ID 1
python3 tools/bee_ftservo/bee_ftservo.py raw ff ff 01 02 01 fb

# no hardware? the same CLI runs against an internal servo bus
python3 tools/bee_ftservo/bee_ftservo.py --simulate selftest
python3 tools/bee_ftservo/bee_ftservo.py --simulate scan --ids 1-4
```

The simulator models the jumpered wiring (echo present) by default;
`--sim-no-echo` models a direction-controlled adapter instead.

Run it as a library when you want the SDK API directly:

```python
from bee_ftservo import BeeLink, open_packet_handler
from scservo_sdk import SMS_STS_TORQUE_ENABLE

link = BeeLink(name="Linkr Bee").open()
handler, packet = open_packet_handler(link, baud=1000000)
packet.write1ByteTxRx(1, SMS_STS_TORQUE_ENABLE, 1)
packet.WritePosEx(1, 2048, 2400, 50)
print(packet.ReadPos(1))
handler.closePort()
link.close()
```

## Commands

| Command | Meaning |
| --- | --- |
| `info` | BLE link, management API, current UART format, control owner |
| `scan --ids 1-253` | ping IDs and read the model number of every servo that answers |
| `ping ID` | one ping, model number and error field |
| `status ID` | position, speed, load, voltage, temperature, moving, current |
| `read ID ADDR LEN` | raw memory read |
| `write ID ADDR HEX` | raw memory write |
| `move ID POS [--speed S --acc A]` | torque on + `WritePosEx` |
| `torque ID on\|off` | torque enable register |
| `wheel ID SPEED` | wheel mode + speed |
| `monitor ID --hz 5` | continuous position/speed read |
| `raw HEX...` | send bytes, print the reply (wiring bring-up) |
| `selftest` | simulated bus: ping, read, write, sync write, timeout |

Useful flags:

- `--address` / `--name` — which Bee to connect to (default: BLE name prefix
  `Linkr Bee`).
- `--baud` — servo bus baud rate (default `1000000`; `500000`, `250000`,
  `115200`, `76800` … are valid FEETECH settings, the Bee accepts 300–3 M).
- `--timeout` — reply timeout floor in ms (default 250). Raise it if a bus with
  many servos or a slow BLE link times out.
- `--restore-uart` — put back the UART format the Bee had before the command, so
  a Bee normally used as a console returns to its console duty.
- `--no-claim` / `--keep-control` — control ownership handling for multi-client
  firmware.
- `--echo auto|on|off` — request-echo suppression for the jumpered half-duplex
  wiring (default `auto`; `off` sends and receives bytes untouched).

## What the bridge has to solve

Two things break a plain serial forwarder here:

1. **Reply latency.** FTServo waits `LATENCY_TIMER` (50 ms) plus a byte time for
   a status packet. A BLE round trip is one connection interval (15–40 ms on
   desktop hosts), so the default is too tight. `make_port_handler()` raises the
   floor to `--timeout` ms without touching the SDK.
2. **Half-duplex echo.** With TX and RX tied to the servo wire, the Bee hears
   its own transmission before the servo's answer, and that echo is a
   checksum-valid FEETECH frame: the unmodified SDK would parse the request as
   the status packet. `ServoSerial` remembers each request and strips a byte
   prefix only when the complete request comes back; a mismatch (a
   direction-controlled adapter) releases the held bytes unchanged.

## Limits

- Each servo transaction costs roughly one BLE interval plus the servo's reply,
  so `monitor` is comfortable up to a few Hz and usable to ~10 Hz. This is a
  debug and bring-up tool, not a real-time motion controller.
- Servo packets from the host are visible as binary noise in every connected
  terminal (the Bee broadcasts UART output to all clients). A dedicated Bee is
  the clean setup.
- A `sync write` spanning many servos is split into several BLE writes. Servos
  normally tolerate the gaps, but if a large group misbehaves, move the group in
  smaller batches.
- The tool takes console ownership while it runs (so its writes are accepted)
  and releases it afterwards; `--no-claim` skips that.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `scan` finds nothing | Servo power and common ground; signal wire on J7.1+J7.2; baud (`--baud`); try `raw ff ff 01 02 01 fb` and watch the reply |
| Nothing from `raw`, echo jumper only | That is correct: the echo filter removed the Bee's own bytes. Re-run with `--echo off` to see them |
| Every transaction times out | `--timeout 400`; confirm the host is not still paired to another Bee; check `info` |
| `not_owner` / writes ignored | Another client (web terminal, phone) owns the console. Let it go idle, or pass `--no-claim` and type nothing there |
| Reply arrives but data is nonsense | Wrong servo model family (SCS vs STS bit order), or the bus is shared with a console. A `raw` PING should return `ff ff <id> 02 00 <chk>` |

## Validation status

- Host tests: `python3 -m unittest tests.test_bee_ftservo -v` — packet framing,
  echo filter (whole/split/no echo), SDK ping/read/write/sync-write, timeout
  floor, CLI surface.
- Bench on firmware 1.1.5 / macOS: connect, Management v1, claim/release,
  `@u=1000000,8,n,1,none` set and restore, raw packets written to J7.
- **Not yet verified with a physical servo on the authors' bench.** The protocol
  path is exercised against the simulator; when a servo is wired, `scan` and
  `status` are the first checks. Report the model and baud in the PR.

The tool depends on `ftservo-python-sdk` (MIT) and `bleak` (MIT) at run time and
ships none of their code. All other code here is under the repository license.
