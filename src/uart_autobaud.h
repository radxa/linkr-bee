/*
 * BACKLOG M5 — follow the peer's UART line rate instead of demanding it match.
 *
 * This lives in its own translation unit on purpose: src/main.c, Kconfig and
 * CMakeLists.txt are compiled by every board in the project (esp32, esp32c3,
 * esp32c5), and a few hundred lines of Espressif register work sitting in there
 * would be a standing merge conflict for anything else that touches the
 * bridge. Disable CONFIG_LINKR_BLE_BRIDGE_UART_AUTOBAUD and this whole header
 * collapses to no-op inline stubs; the file compiles to nothing.
 */
#ifndef LINKR_UART_AUTOBAUD_H_
#define LINKR_UART_AUTOBAUD_H_

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <zephyr/sys/util.h>

/*
 * The loopback test config drives the port from the test harness itself, so
 * there is no peer on the other end to follow and no rate to look for.
 */
#if IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_UART_AUTOBAUD) && \
	!IS_ENABLED(CONFIG_LINKR_BLE_BRIDGE_TEST_UART_LOOPBACK_VERIFY)
#define LINKR_UART_AUTOBAUD 1
#else
#define LINKR_UART_AUTOBAUD 0
#endif

/**
 * Final state of one detection pass. The callback runs on the system
 * workqueue after the pass has stopped, so a command handler can use it to
 * publish an asynchronous Management Service event.
 */
enum linkr_uart_autobaud_result {
	/** A confirmed different rate was programmed into the port. */
	LINKR_UART_AUTOBAUD_APPLIED,
	/** The line already matched the configured rate; the port was not moved. */
	LINKR_UART_AUTOBAUD_UNCHANGED,
	/** No measurable capture arrived before the inactivity timeout. */
	LINKR_UART_AUTOBAUD_TIMEOUT,
	/** The pass was cancelled with linkr_uart_autobaud_stop(). */
	LINKR_UART_AUTOBAUD_STOPPED,
	/** uart_configure() rejected the confirmed rate. */
	LINKR_UART_AUTOBAUD_FAILED,
};

/** Reported once per pass; old_baud is always the rate before the pass. */
typedef void (*linkr_uart_autobaud_callback_t)(
	enum linkr_uart_autobaud_result result, uint32_t old_baud,
	uint32_t new_baud);

#if LINKR_UART_AUTOBAUD

/*
 * Provided by src/main.c, which owns the port's configuration. Called from the
 * system workqueue only — never from the UART interrupt.
 */
uint32_t linkr_uart_config_current(void);
/* Frame length including start, parity and stop, in half-bit units. */
uint32_t linkr_uart_config_frame_half_bits(void);
int linkr_uart_config_reconfigure(uint32_t baudrate);

/**
 * Prepare the follower without starting a pass. Must be called once, after
 * the port has been configured. The detector and the RMT receiver stay idle
 * until linkr_uart_autobaud_request() is called.
 *
 * @param reg_addr MMIO base of the bridge UART, as DT_REG_ADDR().
 */
void linkr_uart_autobaud_init(uintptr_t reg_addr);

/** Install the completion callback (optional). */
void linkr_uart_autobaud_set_callback(linkr_uart_autobaud_callback_t callback);

/**
 * Start one detection pass. Safe to call from an ISR (the GPIO trigger does).
 *
 * @return 0 when the pass was accepted, -EALREADY when one is already queued
 *         or running.
 */
int linkr_uart_autobaud_request(void);

/**
 * Cancel the current pass. The callback, when installed, reports STOPPED.
 *
 * @return 0 when a pass was running or queued, -EALREADY when idle.
 */
int linkr_uart_autobaud_stop(void);

/** True while a pass is queued or running. */
bool linkr_uart_autobaud_running(void);

/** Inactivity timeout used by a pass, in milliseconds. */
uint32_t linkr_uart_autobaud_timeout_ms(void);

#else

static inline uint32_t linkr_uart_config_current(void)
{
	return 0;
}

static inline int linkr_uart_config_reconfigure(uint32_t baudrate)
{
	(void)baudrate;

	return 0;
}

static inline void linkr_uart_autobaud_init(uintptr_t reg_addr)
{
	(void)reg_addr;
}

static inline void linkr_uart_autobaud_set_callback(
	linkr_uart_autobaud_callback_t callback)
{
	(void)callback;
}

static inline int linkr_uart_autobaud_request(void)
{
	return -ENOTSUP;
}

static inline int linkr_uart_autobaud_stop(void)
{
	return -ENOTSUP;
}

static inline bool linkr_uart_autobaud_running(void)
{
	return false;
}

static inline uint32_t linkr_uart_autobaud_timeout_ms(void)
{
	return 0;
}

#endif /* LINKR_UART_AUTOBAUD */

#endif /* LINKR_UART_AUTOBAUD_H_ */
