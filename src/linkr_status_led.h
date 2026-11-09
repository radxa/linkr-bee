/*
 * Linkr Bee status LED.
 *
 * Two board generations exist behind one interface:
 *   - the ESP32-C3/C5 dev boards and the Super Mini drive a plain GPIO LED
 *     (led0), activity = a 40 ms pulse, exactly like before;
 *   - the Linkr Bee X1.0 has an addressable RGB LED on GPIO8. It
 *     shows BLE blue, WiFi white and AI takeover cyan, with UART activity
 *     blinking the current colour.
 *
 * Keeping the choice here means main.c and the control commands do not have
 * to know which kind of LED the board has.
 */
#ifndef LINKR_STATUS_LED_H_
#define LINKR_STATUS_LED_H_

#include <stdbool.h>
#include <stdint.h>

/* True when this board can show status at all. */
bool linkr_status_led_available(void);

/* Configure the LED hardware. Safe to call once during init; returns
 * -ENODEV when the board has no status LED. */
int linkr_status_led_init(void);

/* Flash the activity indication (UART traffic). Cheap and safe to call from
 * any thread; RGB output is rate-limited even under continuous traffic. */
void linkr_status_led_activity(void);

/* Automatic connection state; only RGB boards use these notifications.
 * AI is a 15-second lease renewed by the current controller; false clears it. */
void linkr_status_led_ble(bool connected);
void linkr_status_led_wifi(bool connected);
void linkr_status_led_ai(bool active);

/* Preview a colour for five seconds on RGB boards, then return to automatic
 * status. AI status has priority over the preview. On other boards, set the
 * steady colour. On a single-colour LED any non-black value means
 * "on". Returns -ENODEV when the board has no status LED. */
int linkr_status_led_set_rgb(uint8_t r, uint8_t g, uint8_t b);

/* Preview black on RGB boards; turn a single-colour LED off. */
void linkr_status_led_off(void);

/* Read the current status/preview colour, ignoring activity blink phase. */
void linkr_status_led_get_rgb(uint8_t *r, uint8_t *g, uint8_t *b);

/* Blocking blink used by the UART loopback self-test. */
void linkr_status_led_blink(int count, int delay_ms);

#endif /* LINKR_STATUS_LED_H_ */
