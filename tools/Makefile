# Makefile for the C version of the Linkr BLE terminal.
# This builds a Linux-only binary using BlueZ D-Bus (libdbus).
# The Python terminal (linkr_ble_terminal.py) remains the preferred
# cross-platform tool; this C implementation is provided as a reference.

CC         ?= gcc
PKG_CONFIG ?= pkg-config
SYSROOT    ?=
CFLAGS     ?= -O2 -Wall -Wextra -std=c11 -D_GNU_SOURCE
DBUS_CFLAGS ?=
DBUS_LIBS   ?=

ifneq ($(SYSROOT),)
    DBUS_CFLAGS ?= -I$(SYSROOT)/usr/include/dbus-1.0 \
                   -I$(SYSROOT)/usr/lib/dbus-1.0/include
    DBUS_LIBS   ?= -L$(SYSROOT)/usr/lib -ldbus-1
endif

# Allow pkg-config to locate dbus if available.
ifeq ($(SYSROOT),)
ifneq ($(shell $(PKG_CONFIG) --exists dbus-1 && echo yes),)
    DBUS_CFLAGS += $(shell $(PKG_CONFIG) --cflags dbus-1)
    DBUS_LIBS   += $(shell $(PKG_CONFIG) --libs dbus-1)
endif
endif

TARGET  := linkr_ble_terminal_c
SRC     := linkr_ble_terminal.c
ifeq ($(strip $(DBUS_LIBS)),)
    DBUS_LIBS := -ldbus-1
endif
CFLAGS  += $(DBUS_CFLAGS)
LDLIBS  := $(DBUS_LIBS) -lpthread

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

clean:
	rm -f $(TARGET)
