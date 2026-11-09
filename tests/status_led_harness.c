/* Exercise the production RGB status policy with a deterministic workqueue. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

#define CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR 0x123456
#define CONFIG_LINKR_BLE_BRIDGE_RGB_BRIGHTNESS 30
#define LINKR_ACTIVITY_MS 40
#define ARG_UNUSED(value) (void)(value)
#define K_NO_WAIT 0
#define K_MSEC(value) (value)
#define ENODEV 19

struct linkr_rgb { uint8_t r, g, b; };
struct k_spinlock { int unused; };
typedef unsigned int k_spinlock_key_t;
struct k_work { void (*handler)(struct k_work *); };
struct k_work_delayable { struct k_work work; bool pending; int64_t due; };
static int64_t now_ms;
static unsigned int locks, writes, schedules;
static struct linkr_rgb last_color;
static struct k_work_delayable *timers[1];
static size_t timer_count;

static k_spinlock_key_t k_spin_lock(struct k_spinlock *lock)
{
    (void)lock;
    assert(!locks++);
    return 0;
}
static void k_spin_unlock(struct k_spinlock *lock, k_spinlock_key_t key)
{
    (void)lock; (void)key;
    assert(locks-- == 1);
}
static int64_t k_uptime_get(void) { return now_ms; }
static void k_work_init_delayable(struct k_work_delayable *work,
                                 void (*handler)(struct k_work *))
{
    assert(timer_count < 1);
    work->work.handler = handler;
    timers[timer_count++] = work;
}
static int k_work_reschedule(struct k_work_delayable *work, int64_t delay)
{
    assert(!locks);
    work->due = now_ms + delay;
    work->pending = true;
    ++schedules;
    return 1;
}
static void k_sleep(int64_t delay) { now_ms += delay; }
static bool linkr_ws2812_available(void) { return true; }
static int linkr_ws2812_init(void) { return 0; }
static int linkr_ws2812_write(const struct linkr_rgb *color, size_t count)
{
    assert(!locks && count == 1);
    last_color = *color;
    ++writes;
    return 0;
}

#include "status_led_functions.inc"

static bool run_one(int64_t target)
{
    struct k_work_delayable *next = NULL;
    for (size_t i = 0; i < timer_count; ++i) {
        if (timers[i]->pending && timers[i]->due <= target &&
            (!next || timers[i]->due < next->due)) next = timers[i];
    }
    if (!next) return false;
    if (now_ms < next->due) now_ms = next->due;
    next->pending = false;
    next->work.handler(&next->work);
    return true;
}
static void advance(int64_t target)
{
    assert(target >= now_ms);
    unsigned int count = 0;
    while (run_one(target)) assert(++count < 1000);
    now_ms = target;
}
static void expect(uint8_t r, uint8_t g, uint8_t b)
{
    assert(last_color.r == r && last_color.g == g && last_color.b == b);
}

int main(int argc, char **argv)
{
    assert(argc == 2);
    int scenario = atoi(argv[1]);
    if (scenario == 0) {
        linkr_status_led_activity();
        linkr_status_led_ble(true);
        linkr_status_led_wifi(true);
        linkr_status_led_ai(true);
        assert(!writes && !schedules);
        assert(linkr_status_led_set_rgb(1, 2, 3) == -ENODEV);
        return 0;
    }
    assert(linkr_status_led_init() == 0);
    advance(100);
    linkr_status_led_ble(true);
    advance(100);
    expect(0, 0, 10);
    advance(200);
    writes = schedules = 0;
    if (scenario <= 4) {
        linkr_status_led_activity();
        advance(200);
        expect(0, 0, 0);
        if (scenario == 1) {
            for (int i = 201; i < 1200; ++i) {
                advance(i);
                linkr_status_led_activity();
            }
            advance(1240);
            expect(0, 0, 10);
            assert(writes >= 10 && writes <= 13 && schedules < 100);
        } else if (scenario == 2) {
            advance(239);
            linkr_status_led_activity();
            advance(240);
            expect(0, 0, 0);
            advance(279);
            expect(0, 0, 10);
        } else if (scenario == 3) {
            advance(220);
            linkr_status_led_wifi(true);
            advance(220);
            expect(0, 0, 0);
            advance(240);
            expect(7, 7, 7);
        } else {
            advance(239);
            now_ms = 240; /* New RX arrives before the due work runs. */
            linkr_status_led_activity();
            advance(240);
            expect(0, 0, 0);
            advance(280);
            expect(0, 0, 10);
        }
    } else if (scenario == 5) {
        linkr_status_led_wifi(true); advance(200); expect(7, 7, 7);
        advance(300); linkr_status_led_ai(true); advance(300); expect(0, 7, 7);
        advance(400); linkr_status_led_ble(false); advance(400); expect(0, 7, 7);
        advance(500); linkr_status_led_ai(false); advance(500); expect(7, 7, 7);
        advance(600); linkr_status_led_wifi(false); advance(600); expect(0, 0, 0);
    } else if (scenario == 6) {
        linkr_status_led_ai(true); advance(200); expect(0, 7, 7);
        advance(15199); expect(0, 7, 7);
        advance(15200); expect(0, 0, 10);
    } else if (scenario == 7) {
        linkr_status_led_ai(true); advance(200);
        advance(1000); linkr_status_led_ai(true); advance(1000);
        advance(15200); expect(0, 7, 7);
        advance(16000); expect(0, 0, 10);
    } else if (scenario == 8) {
        linkr_status_led_set_rgb(255, 128, 64); advance(200); expect(77, 38, 19);
        uint8_t r, g, b;
        linkr_status_led_get_rgb(&r, &g, &b);
        assert(r == 255 && g == 128 && b == 64);
        advance(5199); expect(77, 38, 19);
        advance(5200); expect(0, 0, 10);
    } else if (scenario == 9) {
        linkr_status_led_ai(true); advance(200);
        advance(300); linkr_status_led_off(); advance(300); expect(0, 7, 7);
        advance(5300); expect(0, 7, 7);
        advance(5400); linkr_status_led_ai(false); advance(5400); expect(0, 0, 10);
    } else if (scenario == 10) {
        for (int i = 200; i < 1200; ++i) {
            advance(i);
            linkr_status_led_set_rgb(i & 255, 1, 2);
        }
        advance(1240);
        assert(writes <= 27); /* All sources, including manual, stay bounded. */
    } else if (scenario == 11) {
        linkr_status_led_ble(false); advance(200);
        advance(300); linkr_status_led_activity(); advance(300); expect(5, 16, 26);
        advance(340); expect(0, 0, 0);
    } else assert(false);
    assert(!locks);
    return 0;
}
