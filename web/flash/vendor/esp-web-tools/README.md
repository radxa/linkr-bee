# esp-web-tools

`esp-web-tools` 10.4.0, Apache-2.0, by ESPHome / Nabu Casa.
Source: https://github.com/esphome/esp-web-tools

Vendored under `web/flash/vendor/esp-web-tools/` so the flashing page works
without a CDN and without third-party scripts at runtime. Only `dist/web/` is
copied: `install-button.js` and the chunks it imports relatively. Upgrade by
replacing the directory with a newer `dist/web/` and keeping this note and
`LICENSE` in step.
