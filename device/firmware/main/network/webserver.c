#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "main.h"

#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_wifi.h"

/* read size for streaming SD files out over HTTP. lives on the heap, so it
 * does not compete with the httpd task stack. */
#define SD_STREAM_CHUNK 8192

extern const uint8_t index_html_start[] asm("_binary_index_html_start");
extern const uint8_t index_html_end[] asm("_binary_index_html_end");

static esp_err_t html(httpd_req_t *req) {
  httpd_resp_send(req, (const char *)index_html_start, index_html_end - index_html_start);
  return ESP_OK;
}

static esp_err_t reboot(httpd_req_t *req) {
  httpd_resp_sendstr(req, "rebooting...");
  esp_restart();
  return ESP_OK;
}

// should return the value stored in NVS
static esp_err_t getconf(httpd_req_t *req) {
  char ssid[32];
  char passwd[32];
  char server[64];
  char name[32];
  char key[32];

  size_t len = sizeof(ssid);
  nvs_get_str(nvs, "ssid", ssid, &len);

  len = sizeof(passwd);
  nvs_get_str(nvs, "passwd", passwd, &len);

  len = sizeof(server);
  nvs_get_str(nvs, "server", server, &len);

  len = sizeof(name);
  nvs_get_str(nvs, "name", name, &len);

  len = sizeof(key);
  nvs_get_str(nvs, "key", key, &len);

  char res[288];
  snprintf(res, sizeof(res),
    "{\"id\":\"%s\", \"ssid\":\"%s\", \"passwd\":\"%s\", \"server\":\"%s\", \"name\":\"%s\", \"key\":\"%s\"}",
    storage.wifi.macaddr, ssid, passwd, server, name, key);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_send(req, res, strlen(res));
  return ESP_OK;
}

static esp_err_t setconf(httpd_req_t *req) {
  char buf[256];
  size_t len = httpd_req_recv(req, buf, sizeof(buf) - 1);

  if (len <= 0) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "REQ_RECV_FAIL");
    return ESP_FAIL;
  }

  buf[len]    = '\0';
  cJSON *json = cJSON_Parse(buf);

  if (!json) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "INVALID_JSON");
    return ESP_FAIL;
  }

  esp_err_t ret = ESP_OK;
  cJSON *item   = cJSON_GetObjectItem(json, "ssid");

  if (cJSON_IsString(item) && item->valuestring) {
    nvs_set_str(nvs, "ssid", item->valuestring);
  } else {
    ret = ESP_ERR_INVALID_ARG;
  }

  item = cJSON_GetObjectItem(json, "passwd");

  if (cJSON_IsString(item) && item->valuestring) {
    nvs_set_str(nvs, "passwd", item->valuestring);
  } else {
    ret = ESP_ERR_INVALID_ARG;
  }

  item = cJSON_GetObjectItem(json, "server");

  if (cJSON_IsString(item) && item->valuestring) {
    nvs_set_str(nvs, "server", item->valuestring);
  } else {
    ret = ESP_ERR_INVALID_ARG;
  }

  item = cJSON_GetObjectItem(json, "name");

  if (cJSON_IsString(item) && item->valuestring) {
    nvs_set_str(nvs, "name", item->valuestring);
  } else {
    ret = ESP_ERR_INVALID_ARG;
  }

  item = cJSON_GetObjectItem(json, "key");

  if (cJSON_IsString(item) && item->valuestring) {
    nvs_set_str(nvs, "key", item->valuestring);
  } else {
    ret = ESP_ERR_INVALID_ARG;
  }

  if (ret != ESP_OK) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "BAD_FIELD");
    cJSON_Delete(json);
    return ret;
  }

  // only update NVS and do not update memory; new values will be used on next boot
  if (nvs_commit(nvs) != ESP_OK) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "NVS_COMMIT_FAIL");
    ERROR_SYSLOG(&logbuf.run, NVS, "commit failure: network", "WEB_NVS_FAIL");
    return ESP_FAIL;
  }

  cJSON_Delete(json);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_sendstr(req, "{\"status\":\"OK\"}");
  return ESP_OK;
}

/* GET /sd/<file> - stream a log file straight off the SD card.
 * unlike the MQTT download path this holds nothing in RAM on either side:
 * the browser writes to disk as bytes arrive, and Range lets it resume. */
static esp_err_t sdfile(httpd_req_t *req) {
  const char *uri = req->uri + __builtin_strlen("/sd/");

  // req->uri still carries any query string; the file name ends before it
  const char *query = strchr(uri, '?');
  size_t len        = query ? (size_t)(query - uri) : strlen(uri);

  char name[48];

  if (len == 0 || len >= sizeof(name)) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "BAD_PATH");
    return ESP_FAIL;
  }

  memcpy(name, uri, len);
  name[len] = '\0';

  // names only: no subdirectories, no escaping /sdcard
  if (strchr(name, '/') || strstr(name, "..")) {
    httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "BAD_PATH");
    return ESP_FAIL;
  }

  char path[64];
  snprintf(path, sizeof(path), "/sdcard/%s", name);

  struct stat st;

  if (stat(path, &st) != 0) {
    httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "NO_SUCH_FILE");
    return ESP_FAIL;
  }

  /* httpd_resp_set_hdr() stores the pointer rather than copying, so every
   * header buffer must outlive the response. keep them at function scope. */
  char disposition[112];
  char content_range[64];
  char range[64];

  long start = 0;
  long end   = (long)st.st_size - 1;
  bool partial = false;

  // RFC 7233 single byte range: "bytes=<start>-" or "bytes=<start>-<end>"
  if (httpd_req_get_hdr_value_str(req, "Range", range, sizeof(range)) == ESP_OK) {
    long from;
    long to;
    int matched = sscanf(range, "bytes=%ld-%ld", &from, &to);

    if (matched >= 1 && from >= 0 && from < (long)st.st_size) {
      start   = from;
      partial = true;

      if (matched == 2 && to >= from && to < (long)st.st_size) {
        end = to;
      }
    } else {
      snprintf(content_range, sizeof(content_range), "bytes */%ld", (long)st.st_size);
      httpd_resp_set_status(req, "416 Range Not Satisfiable");
      httpd_resp_set_hdr(req, "Content-Range", content_range);
      httpd_resp_send(req, NULL, 0);
      return ESP_OK;
    }
  }

  FILE *fp = fopen(path, "rb");

  if (fp == NULL) {
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OPEN_FAIL");
    return ESP_FAIL;
  }

  if (fseek(fp, start, SEEK_SET) != 0) {
    fclose(fp);
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "SEEK_FAIL");
    return ESP_FAIL;
  }

  char *buf = malloc(SD_STREAM_CHUNK);

  if (buf == NULL) {
    fclose(fp);
    httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "MALLOC_FAIL");
    return ESP_FAIL;
  }

  snprintf(disposition, sizeof(disposition), "attachment; filename=\"%s\"", name);

  httpd_resp_set_type(req, "application/octet-stream");
  httpd_resp_set_hdr(req, "Content-Disposition", disposition);
  httpd_resp_set_hdr(req, "Accept-Ranges", "bytes");

  if (partial) {
    snprintf(content_range, sizeof(content_range), "bytes %ld-%ld/%ld", start, end, (long)st.st_size);
    httpd_resp_set_status(req, "206 Partial Content");
    httpd_resp_set_hdr(req, "Content-Range", content_range);
  }

  long remaining = end - start + 1;
  esp_err_t ret  = ESP_OK;

  while (remaining > 0) {
    size_t want = remaining < SD_STREAM_CHUNK ? (size_t)remaining : SD_STREAM_CHUNK;
    size_t got  = fread(buf, 1, want, fp);

    if (got == 0) {
      break;
    }

    // a failed chunk means the client hung up; stop rather than keep reading
    if (httpd_resp_send_chunk(req, buf, got) != ESP_OK) {
      ret = ESP_FAIL;
      break;
    }

    remaining -= got;
  }

  free(buf);
  fclose(fp);

  if (ret == ESP_OK) {
    httpd_resp_send_chunk(req, NULL, 0);
  }

  return ret;
}

static httpd_handle_t start_httpd(void) {
  httpd_handle_t server   = NULL;
  httpd_config_t config   = HTTPD_DEFAULT_CONFIG();
  config.server_port      = 80;
  config.lru_purge_enable = true;
  config.stack_size       = 8192;
  config.uri_match_fn     = httpd_uri_match_wildcard;  // required by /sd/*

  httpd_uri_t root      = { .uri = "/", .method = HTTP_GET, .handler = html, .user_ctx = NULL };
  httpd_uri_t restart   = { .uri = "/reboot", .method = HTTP_GET, .handler = reboot, .user_ctx = NULL };
  httpd_uri_t getconfig = { .uri = "/config", .method = HTTP_GET, .handler = getconf, .user_ctx = NULL };
  httpd_uri_t setconfig = { .uri = "/config", .method = HTTP_POST, .handler = setconf, .user_ctx = NULL };
  httpd_uri_t getfile   = { .uri = "/sd/*", .method = HTTP_GET, .handler = sdfile, .user_ctx = NULL };

  if (httpd_start(&server, &config) != ESP_OK) {
    ERROR_SYSLOG(&init, WIFI, "HTTP server init failure", "WEBSERVER_FAIL");
    return NULL;
  }

  httpd_register_uri_handler(server, &root);
  httpd_register_uri_handler(server, &restart);
  httpd_register_uri_handler(server, &getconfig);
  httpd_register_uri_handler(server, &setconfig);
  httpd_register_uri_handler(server, &getfile);

  return server;
}

/* STA mode: Wi-Fi is already up and owned by network_init(), so only the
 * HTTP server is started here. */
void webserver_sta(void) {
  start_httpd();
}

void webserver(void) {
  esp_netif_create_default_wifi_ap();

  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();

  if (esp_wifi_init(&cfg) != ESP_OK) {
    ERROR_SYSLOG(&init, WIFI, "init failure", "WIFI_INIT_FAIL");
    return;
  }

  wifi_config_t wifi = {
    .ap = {
      .password = "monolith",
      .max_connection = 4,
      .authmode = WIFI_AUTH_WPA2_PSK,
    },
  };

  snprintf((char *)wifi.ap.ssid, sizeof(wifi.ap.ssid), "Monolith v2 %02X%02X%02X", storage.wifi.mac[3],
    storage.wifi.mac[4], storage.wifi.mac[5]);

  if (esp_wifi_set_mode(WIFI_MODE_AP) != ESP_OK || esp_wifi_set_config(WIFI_IF_AP, &wifi) != ESP_OK) {
    ERROR_SYSLOG(&init, WIFI, "AP config failure", "AP_CFG_FAIL");
    return;
  }

  if (esp_wifi_start() != ESP_OK) {
    ERROR_SYSLOG(&init, WIFI, "AP start failure", "AP_START_FAIL");
    return;
  }

  start_httpd();
}
