/* Exercise the production ISR with Zephyr 4.5's void uart_irq_update(). */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ARG_UNUSED(x) (void)(x)
#define IS_ENABLED(x) 0
struct device { int unused; };
static int uart_rx_ring, uart_rx_dropped, uart_rx_sem;
static uint8_t incoming[100], queued[80];
static size_t read_bytes, queued_bytes;
static unsigned int updates;
static bool updated;

static void uart_irq_update(const struct device *dev)
{
	(void)dev;
	assert(++updates <= 4);
	updated = true;
}

static int uart_irq_rx_ready(const struct device *dev)
{
	(void)dev;
	assert(updated);
	updated = false;
	return read_bytes < sizeof(incoming);
}

static int uart_fifo_read(const struct device *dev, uint8_t *out, size_t size)
{
	(void)dev;
	size_t count = sizeof(incoming) - read_bytes;
	if (count > size) count = size;
	memcpy(out, incoming + read_bytes, count);
	read_bytes += count;
	return (int)count;
}

static uint32_t ring_buf_put(int *ring, const uint8_t *data, size_t size)
{
	assert(ring == &uart_rx_ring);
	size_t count = sizeof(queued) - queued_bytes;
	if (count > size) count = size;
	memcpy(queued + queued_bytes, data, count);
	queued_bytes += count;
	return (uint32_t)count;
}

static void atomic_add(int *value, int count) { *value += count; }
static void k_sem_give(int *sem) { ++*sem; }

#include "uart_irq_functions.inc"

int main(void)
{
	struct device dev = {0};
	for (size_t i = 0; i < sizeof(incoming); i++) incoming[i] = (uint8_t)i;
	uart_rx_irq_callback(&dev, NULL);
	assert(read_bytes == 100 && queued_bytes == 80);
	assert(memcmp(queued, incoming, sizeof(queued)) == 0);
	assert(uart_rx_dropped == 20 && uart_rx_sem == 2 && updates == 3);
	/* An interrupt with no RX bytes does not fabricate data or a wakeup. */
	uart_rx_irq_callback(&dev, NULL);
	assert(updates == 4 && uart_rx_dropped == 20 && uart_rx_sem == 2);
	return 0;
}
