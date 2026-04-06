#!/bin/bash
# Runs at Jackett container startup (via /custom-cont-init.d/).
# Ensures external access is enabled so the UI is reachable from the LAN.
CONFIG="/config/Jackett/ServerConfig.json"
if [ -f "$CONFIG" ]; then
    sed -i 's/"AllowExternal": false/"AllowExternal": true/g' "$CONFIG"
    sed -i 's/"AllowExternal":false/"AllowExternal":true/g' "$CONFIG"
fi
