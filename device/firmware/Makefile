IDF_PATH := $(HOME)/esp/esp-idf

ifneq (,$(filter mini,$(MAKECMDGOALS)))
	IDF_FLAGS := -DCMAKE_C_FLAGS="-DCONFIG_MONOLITH_MINI"
else
	IDF_FLAGS := -DCMAKE_C_FLAGS=""
endif

.PHONY: build run sim clean config dump mini

build:
	export IDF_PATH=$(IDF_PATH) && \
	export IDF_PATH_FORCE=1 && \
	. $(IDF_PATH)/export.sh && \
	idf.py build $(IDF_FLAGS)

run: build
	export IDF_PATH=$(IDF_PATH) && \
	export IDF_PATH_FORCE=1 && \
	. $(IDF_PATH)/export.sh && \
	idf.py -b 921600 flash monitor

clean:
	rm -rf build

config:
	export IDF_PATH=$(IDF_PATH) && \
	export IDF_PATH_FORCE=1 && \
	. $(IDF_PATH)/export.sh && \
	idf.py menuconfig

dump:
	export IDF_PATH=$(IDF_PATH) && \
	export IDF_PATH_FORCE=1 && \
	. $(IDF_PATH)/export.sh && \
	xtensa-esp32s3-elf-objdump -dS build/monolith.elf

