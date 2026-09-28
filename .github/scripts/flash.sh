#!/bin/bash

set -e

echo "----------------------------------------"
echo "Select device type:"
echo "1) Monolith (Original)"
echo "2) Monolith Mini"
echo "----------------------------------------"
read -p "Input selection (1 or 2): " choice

if [ "$choice" = "1" ]; then
    TARGET="monolith"
    echo "Monolith (Original) selected."
elif [ "$choice" = "2" ]; then
    TARGET="monolith-mini"
    echo "Monolith Mini selected."
else
    echo "Wrong input. Exiting."
    exit 1
fi

cd "firmware/$TARGET" || exit 1

echo "Installing esptool..."
python -m pip install esptool

echo "Flashing firmware..."
esptool --chip esp32s3 -b 460800 --before default-reset --after hard-reset write-flash "@flash_args"

echo "Done."
