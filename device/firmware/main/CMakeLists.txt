file(GLOB_RECURSE SRC_FILES "*.c" "*.h")
idf_component_register(SRCS ${SRC_FILES} INCLUDE_DIRS "." EMBED_TXTFILES "misc/index.html" "misc/isrgrootx1.pem" REQUIRES esp_http_server esp_https_ota esp_https_server nvs_flash esp_wifi esp_timer)
