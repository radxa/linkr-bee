/* Run the production consumer against a bounded source and transport. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <setjmp.h>
#include <string.h>

#define IS_ENABLED(x) 0
#define UART_RX_CHUNK 232
#define UART_RX_HIGH_WATERMARK ((16384u * 80) / 100)
#define UART_RX_LOW_WATERMARK ((16384u * 50) / 100)
#define CONFIG_LINKR_BLE_BRIDGE_UART_IDLE_MS 8
#define K_FOREVER -1
#define K_MSEC(x) (x)
#define K_SECONDS(x) ((x) * 1000)
#define LOG_WRN(...) ((void)0)

static int uart_rx_dropped, bridge_start_sem, uart_rx_sem, uart_rx_ring;
static uint32_t buffered_bytes, read_offset, delivered, waits, now_ms;
static uint32_t initial, refill, retries;
static bool refilled;
static jmp_buf finished;

static uint32_t atomic_set(int *slot, int value)
{
	int old = *slot;

	*slot = value;
	return (uint32_t)old;
}

static int k_sem_take(int *sem, int timeout)
{
	(void)sem;
	(void)timeout;
	now_ms++;
	if (++waits >= 1000) {
		longjmp(finished, 1);
	}
	if (!refilled && buffered_bytes == 0 && delivered == initial) {
		buffered_bytes = refill;
		refilled = true;
	}
	return 0;
}

static void k_sleep(int ms) { now_ms += (uint32_t)ms; }
static int64_t k_uptime_get(void) { return now_ms; }
static unsigned int irq_lock(void) { return 0; }
static void irq_unlock(unsigned int key) { (void)key; }
static void signal_uart_activity(void) {}

/* Also available if the old watermark branch is restored by a regression. */
uint32_t ring_buf_size_get(int *ring)
{
	(void)ring;
	return buffered_bytes;
}

static uint32_t ring_buf_get(int *ring, uint8_t *data, size_t capacity)
{
	uint32_t count = buffered_bytes < capacity ? buffered_bytes : (uint32_t)capacity;

	(void)ring;
	for (uint32_t i = 0; i < count; i++) {
		data[i] = (uint8_t)read_offset++;
	}
	buffered_bytes -= count;
	return count;
}

static int uart_forward_chunk(const uint8_t *data, uint16_t len, bool *accounted)
{
	(void)accounted;
	if (retries > 0) {
		retries--;
		return -11;
	}
	for (uint32_t i = 0; i < len; i++) {
		if (data[i] != (uint8_t)(delivered + i)) {
			abort(); /* bytes were lost, duplicated, or reordered */
		}
	}
	delivered += len;
	return 0;
}

#include "uart_rx_functions.inc"

int main(int argc, char **argv)
{
	if (argc != 4) {
		return 2;
	}
	initial = buffered_bytes = (uint32_t)strtoul(argv[1], NULL, 10);
	refill = (uint32_t)strtoul(argv[2], NULL, 10);
	retries = (uint32_t)strtoul(argv[3], NULL, 10);
	if (setjmp(finished) == 0) {
		uart_to_ble_thread();
	}
	printf("buffered=%u delivered=%u refilled=%u\n",
	       buffered_bytes, delivered, refilled ? 1u : 0u);
	return 0;
}
