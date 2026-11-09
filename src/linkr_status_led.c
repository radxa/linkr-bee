/*
 * Linkr Bee status LED: addressable RGB on the X1.0, plain GPIO elsewhere.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include "linkr_status_led.h"

#include <errno.h>

#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include "linkr_ws2812.h"

/* Shares main.c's log source: same prefix, no second source slot in RAM. */
LOG_MODULE_DECLARE(linkr_ble_bridge, LOG_LEVEL_INF);

/* How long one activity flash stays visible. */
#define LINKR_ACTIVITY_MS 40

#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_RGB_STATUS_LED) && DT_HAS_ALIAS(linkr_rgb)

/* ---------------------------------------------------------------------- */
/* Addressable RGB status LED (Linkr Bee X1.0)                            */
/* ---------------------------------------------------------------------- */

static struct linkr_rgb led_base;
static const struct linkr_rgb led_activity_color = {
	.r = (CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR >> 16) & 0xff,
	.g = (CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR >> 8) & 0xff,
	.b = CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR & 0xff,
};
/* Dim colours keep the single pixel's power and glare low. */
static const struct linkr_rgb led_blue = {0, 0, 32};
static const struct linkr_rgb led_white = {24, 24, 24};
static const struct linkr_rgb led_cyan = {0, 24, 24};
#define LED_BLINK_MS 100
#define LED_PREVIEW_MS 5000
#define LED_AI_LEASE_MS 15000
static bool led_ready, led_ble_connected, led_wifi_connected;
static bool led_activity_active, led_last_valid;
static int64_t led_activity_deadline, led_activity_start;
static int64_t led_preview_deadline, led_ai_deadline, led_last_write;
static uint32_t led_revision;
static struct linkr_rgb led_last_color;
static struct k_spinlock led_lock;
static struct k_work_delayable led_apply_work;

static void led_write(const struct linkr_rgb *color)
{
	/* Scale once at the output boundary, before the driver locks IRQs. */
	const struct linkr_rgb output = {
		.r = (color->r * CONFIG_LINKR_BLE_BRIDGE_RGB_BRIGHTNESS + 50U) / 100U,
		.g = (color->g * CONFIG_LINKR_BLE_BRIDGE_RGB_BRIGHTNESS + 50U) / 100U,
		.b = (color->b * CONFIG_LINKR_BLE_BRIDGE_RGB_BRIGHTNESS + 50U) / 100U,
	};
	(void)linkr_ws2812_write(&output, 1);
}

/* Called with led_lock held. Manual commands preview for five seconds; AI
 * ownership remains visible even during a preview. */
static struct linkr_rgb led_color(int64_t now)
{
	if (now < led_ai_deadline) return led_cyan;
	if (now < led_preview_deadline) return led_base;
	if (led_wifi_connected) return led_white;
	if (led_ble_connected) return led_blue;
	return (struct linkr_rgb){0, 0, 0};
}

static void led_next(int64_t *next, int64_t deadline, int64_t now)
{
	if (deadline > now && (!*next || deadline < *next)) *next = deadline;
}

static void led_apply(struct k_work *work)
{
	ARG_UNUSED(work);
	int64_t now = k_uptime_get(), next = 0;
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	uint32_t revision = led_revision;
	struct linkr_rgb color = led_color(now);
	led_next(&next, led_ai_deadline, now);
	led_next(&next, led_preview_deadline, now);
	led_activity_active = now < led_activity_deadline;
	if (led_activity_active) {
		int64_t phase = (now - led_activity_start) / LED_BLINK_MS;
		/* Connected: blink the current status colour off. Disconnected:
		 * flash the configured activity colour so UART traffic stays visible. */
		if (!(phase & 1)) {
			color = (color.r | color.g | color.b) ?
				(struct linkr_rgb){0, 0, 0} : led_activity_color;
		}
		led_next(&next, led_activity_start + (phase + 1) * LED_BLINK_MS, now);
		led_next(&next, led_activity_deadline, now);
	}
	bool changed = !led_last_valid || color.r != led_last_color.r ||
		color.g != led_last_color.g || color.b != led_last_color.b;
	/* No UART pattern can force more than 25 RGB frames/s. A WS2812 write
	 * masks IRQs and latches for 300 us; never do it once per RX chunk. */
	bool write = changed && (!led_last_valid || now - led_last_write >= LINKR_ACTIVITY_MS);
	if (write) {
		led_last_valid = true;
		led_last_color = color;
		led_last_write = now;
	} else if (changed) {
		led_next(&next, led_last_write + LINKR_ACTIVITY_MS, now);
	}
	k_spin_unlock(&led_lock, key);
	if (write) led_write(&color);
	if (next) (void)k_work_reschedule(&led_apply_work, K_MSEC(next - now));
	/* A connection/lease/preview update during the write must not be hidden
	 * by the timer calculated from the old state. */
	key = k_spin_lock(&led_lock);
	bool stale = revision != led_revision;
	k_spin_unlock(&led_lock, key);
	if (stale) (void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
}

bool linkr_status_led_available(void)
{
	return linkr_ws2812_available();
}

int linkr_status_led_init(void)
{
	int err = linkr_ws2812_init();
	if (err) return err;
	k_work_init_delayable(&led_apply_work, led_apply);
	led_ready = true;
	return 0;
}

void linkr_status_led_ble(bool connected)
{
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	bool changed = led_ble_connected != connected;
	led_ble_connected = connected;
	if (changed) ++led_revision;
	k_spin_unlock(&led_lock, key);
	if (changed && led_ready) (void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
}

void linkr_status_led_wifi(bool connected)
{
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	bool changed = led_wifi_connected != connected;
	led_wifi_connected = connected;
	if (changed) ++led_revision;
	k_spin_unlock(&led_lock, key);
	if (changed && led_ready) (void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
}

void linkr_status_led_ai(bool active)
{
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	led_ai_deadline = active ? k_uptime_get() + LED_AI_LEASE_MS : 0;
	++led_revision;
	k_spin_unlock(&led_lock, key);
	if (led_ready) (void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
}

void linkr_status_led_activity(void)
{
	if (!led_ready) return;
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	bool start = !led_activity_active;
	if (start) {
		led_activity_active = true;
		led_activity_start = k_uptime_get();
		++led_revision;
	}
	led_activity_deadline = k_uptime_get() + LINKR_ACTIVITY_MS;
	k_spin_unlock(&led_lock, key);
	if (start) (void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
}

int linkr_status_led_set_rgb(uint8_t r, uint8_t g, uint8_t b)
{
	if (!led_ready) return -ENODEV;
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	led_base = (struct linkr_rgb){r, g, b};
	led_preview_deadline = k_uptime_get() + LED_PREVIEW_MS;
	++led_revision;
	k_spin_unlock(&led_lock, key);
	(void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
	return 0;
}

void linkr_status_led_off(void)
{
	(void)linkr_status_led_set_rgb(0, 0, 0);
}

void linkr_status_led_get_rgb(uint8_t *r, uint8_t *g, uint8_t *b)
{
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	struct linkr_rgb color = led_color(k_uptime_get());
	k_spin_unlock(&led_lock, key);
	if (r) *r = color.r;
	if (g) *g = color.g;
	if (b) *b = color.b;
}

void linkr_status_led_blink(int count, int delay_ms)
{
	if (!led_ready) return;
	for (int i = 0; i < count; i++) {
		led_write(&led_activity_color);
		k_sleep(K_MSEC(delay_ms));
		struct linkr_rgb color;
		linkr_status_led_get_rgb(&color.r, &color.g, &color.b);
		led_write(&color);
		k_sleep(K_MSEC(delay_ms));
	}
	/* The blocking self-test bypassed the cached output. */
	k_spinlock_key_t key = k_spin_lock(&led_lock);
	led_last_valid = false;
	++led_revision;
	k_spin_unlock(&led_lock, key);
	(void)k_work_reschedule(&led_apply_work, K_NO_WAIT);
}

#elif DT_HAS_ALIAS(led0) && DT_NODE_HAS_STATUS(DT_ALIAS(led0), okay)

/* ---------------------------------------------------------------------- */
/* Single-colour GPIO status LED (dev boards, Super Mini)                  */
/* ---------------------------------------------------------------------- */

#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>

static const struct gpio_dt_spec led_gpio = GPIO_DT_SPEC_GET(DT_ALIAS(led0), gpios);
static struct k_work_delayable led_off_work;
static bool led_ready;
static bool led_on;

static void led_off_handler(struct k_work *work)
{
	ARG_UNUSED(work);
	gpio_pin_set_dt(&led_gpio, 0);
}

bool linkr_status_led_available(void)
{
	return true;
}

int linkr_status_led_init(void)
{
	if (!device_is_ready(led_gpio.port)) {
		return -ENODEV;
	}

	if (gpio_pin_configure_dt(&led_gpio, GPIO_OUTPUT_INACTIVE) != 0) {
		return -EIO;
	}

	k_work_init_delayable(&led_off_work, led_off_handler);
	led_ready = true;
	led_on = false;
	return 0;
}

void linkr_status_led_activity(void)
{
	if (!led_ready) {
		return;
	}

	gpio_pin_set_dt(&led_gpio, 1);
	(void)k_work_reschedule(&led_off_work, K_MSEC(LINKR_ACTIVITY_MS));
}

int linkr_status_led_set_rgb(uint8_t r, uint8_t g, uint8_t b)
{
	if (!led_ready) {
		return -ENODEV;
	}

	led_on = (r | g | b) != 0;
	gpio_pin_set_dt(&led_gpio, led_on ? 1 : 0);
	return 0;
}

void linkr_status_led_off(void)
{
	(void)linkr_status_led_set_rgb(0, 0, 0);
}

void linkr_status_led_get_rgb(uint8_t *r, uint8_t *g, uint8_t *b)
{
	/* The LED only has on/off state; report white so callers see "on". */
	uint8_t value = led_on ? 0xff : 0x00;

	if (r != NULL) {
		*r = value;
	}
	if (g != NULL) {
		*g = value;
	}
	if (b != NULL) {
		*b = value;
	}
}

void linkr_status_led_blink(int count, int delay_ms)
{
	if (!led_ready) {
		return;
	}

	for (int i = 0; i < count; i++) {
		gpio_pin_set_dt(&led_gpio, 1);
		k_sleep(K_MSEC(delay_ms));
		gpio_pin_set_dt(&led_gpio, 0);
		k_sleep(K_MSEC(delay_ms));
	}
}

#else

/* ---------------------------------------------------------------------- */
/* No status LED on this board                                            */
/* ---------------------------------------------------------------------- */

bool linkr_status_led_available(void)
{
	return false;
}

int linkr_status_led_init(void)
{
	return -ENODEV;
}

void linkr_status_led_activity(void)
{
}

int linkr_status_led_set_rgb(uint8_t r, uint8_t g, uint8_t b)
{
	ARG_UNUSED(r);
	ARG_UNUSED(g);
	ARG_UNUSED(b);
	return -ENODEV;
}

void linkr_status_led_off(void)
{
}

void linkr_status_led_get_rgb(uint8_t *r, uint8_t *g, uint8_t *b)
{
	if (r != NULL) {
		*r = 0;
	}
	if (g != NULL) {
		*g = 0;
	}
	if (b != NULL) {
		*b = 0;
	}
}

void linkr_status_led_blink(int count, int delay_ms)
{
	ARG_UNUSED(count);
	ARG_UNUSED(delay_ms);
}

#endif

#if !(IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_RGB_STATUS_LED) && DT_HAS_ALIAS(linkr_rgb))
/* Connection colours are specific to the X1.0 RGB LED. */
void linkr_status_led_ble(bool connected) { ARG_UNUSED(connected); }
void linkr_status_led_wifi(bool connected) { ARG_UNUSED(connected); }
void linkr_status_led_ai(bool active) { ARG_UNUSED(active); }
#endif
