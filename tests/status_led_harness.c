/* Exercise the production RGB status policy with a deterministic workqueue. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>

#define CONFIG_LINKR_BLE_BRIDGE_RGB_ACTIVITY_COLOR 0x123456
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
static struct k_work_delayable *timers[2];
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
    assert(timer_count < 2);
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
        assert(!writes && !schedules);
        assert(linkr_status_led_set_rgb(1, 2, 3) == -ENODEV);
        return 0;
    }
    assert(linkr_status_led_init() == 0);
    assert(linkr_status_led_set_rgb(1, 2, 3) == 0);
    advance(0);
    expect(1, 2, 3);
    writes = schedules = 0;
    linkr_status_led_activity();
    advance(0);
    expect(0x12, 0x34, 0x56);
    if (scenario == 1) {
        for (int i = 1; i < 1000; ++i) {
            advance(i);
            linkr_status_led_activity();
        }
        advance(1038);
        expect(0x12, 0x34, 0x56);
        assert(writes == 1);
        advance(1039);
        expect(1, 2, 3);
        assert(writes == 2 && schedules < 100);
    } else if (scenario == 2) {
        advance(39);
        linkr_status_led_activity();
        advance(40);
        expect(0x12, 0x34, 0x56);
        advance(78);
        expect(0x12, 0x34, 0x56);
        advance(79);
        expect(1, 2, 3);
    } else if (scenario == 3) {
        advance(20);
        assert(linkr_status_led_set_rgb(4, 5, 6) == 0);
        advance(20);
        expect(0x12, 0x34, 0x56);
        uint8_t r, g, b;
        linkr_status_led_get_rgb(&r, &g, &b);
        assert(r == 4 && g == 5 && b == 6);
        advance(40);
        expect(4, 5, 6);
    } else if (scenario == 4) {
        assert(run_one(40)); /* Expiry queued a base-color update. */
        linkr_status_led_activity();
        advance(40);
        expect(0x12, 0x34, 0x56);
        advance(79);
        expect(0x12, 0x34, 0x56);
        advance(80);
        expect(1, 2, 3);
    } else assert(false);
    assert(!locks);
    return 0;
}
