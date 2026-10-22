/* Compile the C host's name helpers against hand-written management replies.
 *
 * Both functions are pure: one decides what a name heard over the air may
 * print, the other reads a name out of `OK name=...`. Keeping them out of the
 * DBus path is what lets this run without a radio or libdbus. */
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "production_name.inc"

static int failures;

static void expect_reply(const char *label, const char *reply, bool query,
                         const char *expected)
{
    char out[64] = "sentinel";
    bool ok = ble_name_from_reply(reply, query, out, sizeof(out));

    if (!ok || strcmp(out, expected) != 0) {
        fprintf(stderr, "%s: ok=%d name=\"%s\", expected ok=1 name=\"%s\"\n",
                label, ok, ok ? out : "", expected);
        failures++;
    }
}

static void expect_no_reply(const char *label, const char *reply, bool query)
{
    char out[64] = "sentinel";
    bool ok = ble_name_from_reply(reply, query, out, sizeof(out));

    if (ok) {
        fprintf(stderr, "%s: parsed \"%s\" from a reply without a name\n",
                label, out);
        failures++;
    }
}

static void expect_printable(const char *label, const char *name,
                             const char *expected)
{
    char out[64];

    printable_ble_name(name, out, sizeof(out));
    if (strcmp(out, expected) != 0) {
        fprintf(stderr, "%s: \"%s\", expected \"%s\"\n", label, out, expected);
        failures++;
    }
}

int main(void)
{
    /* Query replies carry custom=; a name ending in that text survives it. */
    expect_reply("query-default", "OK name=Linkr Bee 078C custom=no\r\n", true,
                 "Linkr Bee 078C");
    expect_reply("query-custom", "OK name=测试 Bee custom=yes\r\n", true,
                 "测试 Bee");
    expect_reply("query-tricky", "OK name=Bee custom=yes custom=no\r\n", true,
                 "Bee custom=yes");
    expect_reply("query-space", "OK name=Bench Bee custom=no\n", true,
                 "Bench Bee");

    /* A write's reply has no custom= field: the trailing text is the name. */
    expect_reply("write-tricky", "OK name=Bee custom=yes\r\n", false,
                 "Bee custom=yes");
    expect_reply("write-plain", "OK name=Bench Bee\r\n", false, "Bench Bee");
    expect_reply("write-utf8", "OK name=测试😀", false, "测试😀");

    /* Anything without a name is not a confirmation. */
    expect_no_reply("err", "ERR name expected 1-29 UTF-8 bytes\r\n", true);
    expect_no_reply("empty", "", true);
    expect_no_reply("other-line", "OK uart=115200,8,N,1,none\r\n", true);
    expect_no_reply("empty-name", "OK name= custom=yes\r\n", true);

    /* Names heard over the air cannot drive the terminal. */
    expect_printable("plain", "Linkr Bee 078C", "Linkr Bee 078C");
    expect_printable("esc", "Bee\x1b[31m", "Bee[31m");
    expect_printable("c0", "Bee\x01\x02", "Bee");
    expect_printable("c1", "Bee\xc2\x85", "Bee");
    expect_printable("null", NULL, "(unknown)");
    expect_printable("only-controls", "\x01\x02\x7f", "(unknown)");

    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("harness ok\n");
    return 0;
}
