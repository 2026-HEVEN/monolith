#include <dirent.h>
#include <sys/stat.h>
#include <sys/time.h>

#include "main.h"

#include "driver/twai.h"
#include "esp_netif.h"

log_buf_t logbuf;
esp_mqtt_client_handle_t mqtt = NULL;

extern char logpath[64];
extern struct timeval boot;
extern const uint8_t isrgrootx1_pem_start[] asm("_binary_isrgrootx1_pem_start");

#define STREQL(str1, str2) (strcmp((str1), (str2)) == 0)

static void mqtt_handle_data(esp_mqtt_event_handle_t evt) {
  char topic[64];
  char pathbuf[64];

  snprintf(topic, sizeof(topic), "%.*s", evt->topic_len, evt->topic);

  char *dir[5]  = { 0 };  // name, cmd, type, key
  char *saveptr = NULL;
  int cnt       = 0;

  for (char *tok = strtok_r(topic, "/", &saveptr); tok && cnt < 4; tok = strtok_r(NULL, "/", &saveptr)) {
    dir[cnt++] = tok;
  }

  if (cnt < 2 || !STREQL(dir[0], storage.device.name) || evt->data_len == 0) {
    return;
  }

  // only update NVS and do not update memory; new values will be used on next boot
  if (STREQL(dir[1], "set")) {
    if (cnt < 4) {
      return;
    }

    if (STREQL(dir[2], "net")) {
      if (STREQL(dir[3], "ssid")) {
        char ssid[32];
        snprintf(ssid, sizeof(ssid), "%.*s", evt->data_len, evt->data);
        nvs_set_str(nvs, "ssid", ssid);
      } else if (STREQL(dir[3], "passwd")) {
        char passwd[32];
        snprintf(passwd, sizeof(passwd), "%.*s", evt->data_len, evt->data);
        nvs_set_str(nvs, "passwd", passwd);
      }
    }

    else if (STREQL(dir[2], "dev")) {
      if (STREQL(dir[3], "tz")) {
        char tz[40];
        snprintf(tz, sizeof(tz), "%.*s", evt->data_len, evt->data);
        nvs_set_str(nvs, "tz", tz);
      } else if (STREQL(dir[3], "intv")) {
        nvs_set_u32(nvs, "intv", *(uint32_t *)(evt->data));
      }
    }

    else if (STREQL(dir[2], "can")) {
      if (STREQL(dir[3], "en")) {
        nvs_set_u8(nvs, "can_en", evt->data[0] != 0);
      } else if (STREQL(dir[3], "bps")) {
        nvs_set_u8(nvs, "can_bps", evt->data[0]);
      } else if (STREQL(dir[3], "filter")) {
        nvs_set_u32(nvs, "can_filter", *(uint32_t *)(evt->data));
      } else if (STREQL(dir[3], "mask")) {
        nvs_set_u32(nvs, "can_mask", *(uint32_t *)(evt->data));
      }
    }

    else if (STREQL(dir[2], "gps")) {
      if (STREQL(dir[3], "en")) {
        nvs_set_u8(nvs, "gps_en", evt->data[0] != 0);
      } else if (STREQL(dir[3], "dev")) {
        nvs_set_u8(nvs, "gps_dev", evt->data[0]);
      }
    }

    else if (STREQL(dir[2], "anl")) {
      if (STREQL(dir[3], "en")) {
        nvs_set_u8(nvs, "anl_en", evt->data[0] != 0);
      }
    }

    else if (STREQL(dir[2], "dgt")) {
      if (STREQL(dir[3], "en")) {
        nvs_set_u8(nvs, "dgt_en", evt->data[0] != 0);
      }
    }

    else {
      return;
    }

    if (nvs_commit(nvs) != ESP_OK) {
      ERROR_SYSLOG(&logbuf.run, NVS, "commit failure", "MQTT_NVS_FAIL");
      return;
    }

    snprintf(topic, sizeof(topic), "%s/ack/set", storage.device.name);
    esp_mqtt_client_publish(mqtt, topic, "ok", __builtin_strlen("ok"), MQTT_QOS_2, false);
  }

  else if (STREQL(dir[1], "cmd")) {
    if (dir[2] == NULL) {
      return;
    }

    if (STREQL(dir[2], "cfg")) {  // get configuration
      snprintf(topic, sizeof(topic), "%s/d/cfg", storage.device.name);
      esp_mqtt_client_publish(mqtt, topic, (char *)&storage, sizeof(storage), MQTT_QOS_1, false);
    }

    else if (STREQL(dir[2], "rbt")) {  // restart
      esp_restart();
    }

    else if (STREQL(dir[2], "rst")) {  // reset all configurations
      nvs_erase_all(nvs);
      nvs_commit(nvs);
      esp_restart();
    }

    else if (STREQL(dir[2], "evt")) {  // user event
      log_t log;
      strncpy(log.payload.user_event.msg, evt->data, evt->data_len);

      if (evt->data_len < sizeof(log.payload.user_event.msg)) {
        log.payload.user_event.msg[evt->data_len] = '\0';
      }

      LOG(LOG_TYPE_USER_EVENT, &log);

      snprintf(topic, sizeof(topic), "%s/ack/evt", storage.device.name);
      esp_mqtt_client_publish(mqtt, topic, "ok", __builtin_strlen("ok"), MQTT_QOS_2, false);
    }

    else if (STREQL(dir[2], "can")) {  // transmit CAN message
      twai_message_t message = {
        .identifier       = atol(dir[3]),
        .extd             = false,
        .rtr              = false,
        .ss               = false,
        .self             = false,
        .dlc_non_comp     = false,
        .data_length_code = evt->data_len > 8 ? 8 : evt->data_len,
      };

      if (message.identifier == 0) {
        snprintf(topic, sizeof(topic), "%s/ack/can", storage.device.name);
        esp_mqtt_client_publish(mqtt, topic, "fail:invalid_id", __builtin_strlen("fail:invalid_id"), MQTT_QOS_2, false);
        return;
      } else if (message.identifier > 0x7FF) {
        message.extd = true;
      }

      memcpy(message.data, evt->data, message.data_length_code);
      xQueueSend(cantxqueue, &message, 0);
    }

    else if (STREQL(dir[2], "ls")) {  // list files
      DIR *d = opendir("/sdcard");

      if (d == NULL) {
        snprintf(topic, sizeof(topic), "%s/ack/ls", storage.device.name);
        esp_mqtt_client_publish(mqtt, topic, "fail:opendir", __builtin_strlen("fail:opendir"), MQTT_QOS_2, false);
        return;
      }

      struct stat st;
      struct dirent *entry;

      while ((entry = readdir(d)) != NULL) {
        if (entry->d_type != DT_REG || strcmp(entry->d_name, &logpath[__builtin_strlen("/sdcard/")]) == 0) {
          continue;
        }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
        snprintf(pathbuf, sizeof(pathbuf), "/sdcard/%s", entry->d_name);
#pragma GCC diagnostic pop

        if (stat(pathbuf, &st) == 0) {
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
          snprintf(topic, sizeof(topic), "%s/ack/ls/%s", storage.device.name, entry->d_name);
#pragma GCC diagnostic pop
          esp_mqtt_client_publish(mqtt, topic, (char *)&st.st_size, sizeof(st.st_size), MQTT_QOS_0, false);
        }
      }

      closedir(d);
      snprintf(topic, sizeof(topic), "%s/ack/ls", storage.device.name);
      esp_mqtt_client_publish(mqtt, topic, "ok", __builtin_strlen("ok"), MQTT_QOS_2, false);
    }

    else if (STREQL(dir[2], "del")) {  // delete file(s)
      if (cnt < 4) {
        return;
      }

      if (STREQL(dir[3], "all")) {  // delete all files
        DIR *d = opendir("/sdcard");

        if (d == NULL) {
          snprintf(topic, sizeof(topic), "%s/ack/del", storage.device.name);
          esp_mqtt_client_publish(mqtt, topic, "fail:opendir", __builtin_strlen("fail:opendir"), MQTT_QOS_2, false);
          return;
        }

        struct dirent *entry;

        while ((entry = readdir(d)) != NULL) {
          if (entry->d_type != DT_REG || strcmp(entry->d_name, &logpath[__builtin_strlen("/sdcard/")]) == 0) {
            continue;
          }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat-truncation"
          snprintf(pathbuf, sizeof(pathbuf), "/sdcard/%s", entry->d_name);
#pragma GCC diagnostic pop
          remove(pathbuf);
        }

        closedir(d);
      } else {
        snprintf(pathbuf, sizeof(pathbuf), "/sdcard/%s", dir[3]);
        remove(pathbuf);
      }

      snprintf(topic, sizeof(topic), "%s/ack/del", storage.device.name);
      esp_mqtt_client_publish(mqtt, topic, "ok", __builtin_strlen("ok"), MQTT_QOS_2, false);
    }

    else if (STREQL(dir[2], "get")) {  // download file
      if (cnt < 4) {
        return;
      }

      snprintf(pathbuf, sizeof(pathbuf), "/sdcard/%s", dir[3]);

      FILE *fp = fopen(pathbuf, "rb");

      if (fp == NULL) {
        snprintf(topic, sizeof(topic), "%s/ack/get", storage.device.name);
        esp_mqtt_client_publish(mqtt, topic, "fail:open", __builtin_strlen("fail:open"), MQTT_QOS_2, false);
        return;
      }

      struct stat st;

      if (stat(pathbuf, &st) != 0) {
        fclose(fp);
        snprintf(topic, sizeof(topic), "%s/ack/get", storage.device.name);
        esp_mqtt_client_publish(mqtt, topic, "fail:stat", __builtin_strlen("fail:stat"), MQTT_QOS_2, false);
        return;
      }

      int cnt    = 0;
      char *data = malloc(4096);

      if (data == NULL) {
        fclose(fp);
        snprintf(topic, sizeof(topic), "%s/ack/get", storage.device.name);
        esp_mqtt_client_publish(mqtt, topic, "fail:malloc", __builtin_strlen("fail:malloc"), MQTT_QOS_2, false);
        return;
      }

      while (true) {
        size_t read = fread(data, 1, 4096, fp);

        if (read == 0) {
          break;
        }

        snprintf(topic, sizeof(topic), "%s/ack/get/%d", storage.device.name, cnt++);
        esp_mqtt_client_publish(mqtt, topic, data, read, MQTT_QOS_0, false);
      }

      snprintf(topic, sizeof(topic), "%s/ack/get", storage.device.name);
      esp_mqtt_client_publish(mqtt, topic, (char *)&cnt, sizeof(cnt), MQTT_QOS_1, false);

      free(data);
      fclose(fp);
    }
  }
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
  esp_mqtt_event_handle_t event = event_data;

  INFO(MQTT, "evt %ld topic: %.*s data: %.*s", event_id, event->topic_len, event->topic, event->data_len, event->data);

  switch (event_id) {
    char buf[sizeof(system_event_t)];
    char topic[40];

    case MQTT_EVENT_CONNECTED:
      snprintf(topic, sizeof(topic), "%s/set/#", storage.device.name);
      esp_mqtt_client_subscribe(mqtt, topic, MQTT_QOS_2);

      snprintf(topic, sizeof(topic), "%s/cmd/#", storage.device.name);
      esp_mqtt_client_subscribe(mqtt, topic, MQTT_QOS_2);

      snprintf(topic, sizeof(topic), "%s/d/boot", storage.device.name);
      esp_mqtt_client_publish(mqtt, topic, (char *)&boot.tv_sec, sizeof(boot.tv_sec), MQTT_QOS_1, true);

      /* retained LAN address, so the web app can offer a direct HTTP download
       * of SD logs instead of pulling them chunk by chunk over MQTT. */
      {
        char addr[16]         = { 0 };
        esp_netif_t *netif    = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        esp_netif_ip_info_t ip;

        if (netif != NULL && esp_netif_get_ip_info(netif, &ip) == ESP_OK) {
          snprintf(addr, sizeof(addr), IPSTR, IP2STR(&ip.ip));
        }

        snprintf(topic, sizeof(topic), "%s/d/ip", storage.device.name);
        esp_mqtt_client_publish(mqtt, topic, addr, strlen(addr), MQTT_QOS_1, true);
      }

      CLEAR_ALL(&logbuf.run, MQTT);
      SYSLOG("MQTT_CONN");
      break;
    case MQTT_EVENT_DISCONNECTED:
      ERROR_SYSLOG(&logbuf.run, MQTT, "disconnected", "MQTT_DISCONN");
      break;
    case MQTT_EVENT_DATA:
      mqtt_handle_data(event);
      break;
    case MQTT_EVENT_ERROR:
      snprintf(buf, sizeof(buf), "MQTT_ERR:%d", event->error_handle->error_type);
      ERROR_SYSLOG(&logbuf.run, MQTT, buf, buf);
      break;
    default:
      break;
  }
}

static void mqtt_task(void *arg) {
  int ret;
  log_t syslog;
  log_t canlog;
  char topic[40];
  char syslog_topic[40];
  char canlog_topic[40];

  snprintf(topic, sizeof(topic), "%s/d", storage.device.name);
  snprintf(syslog_topic, sizeof(syslog_topic), "%s/d/sl", storage.device.name);
  snprintf(canlog_topic, sizeof(canlog_topic), "%s/d/can", storage.device.name);

  const TickType_t interval = pdMS_TO_TICKS(storage.device.intv);

  while (true) {
    if (mqtt != NULL && IS_OK(&logbuf.run, MQTT)) {
      logbuf.timestamp = (uint32_t)(esp_timer_get_time() / 1000);
      esp_mqtt_client_publish(mqtt, topic, (char *)&logbuf, sizeof(logbuf), MQTT_QOS_0, false);

      do {
        if ((ret = xQueueReceive(syslogqueue, &syslog, 0)) == pdTRUE) {
          esp_mqtt_client_publish(mqtt, syslog_topic, (char *)&syslog, sizeof(syslog), MQTT_QOS_0, false);
        }
      } while (ret);

      do {
        if ((ret = xQueueReceive(canlogqueue, &canlog, 0)) == pdTRUE) {
          esp_mqtt_client_publish(mqtt, canlog_topic, (char *)&canlog, sizeof(canlog), MQTT_QOS_0, false);
        }
      } while (ret);
    }

    vTaskDelay(interval);
  }
}

void mqtt_init(void) {
  char mqtt_url[80];
  snprintf(mqtt_url, sizeof(mqtt_url), "wss://%s:443", storage.device.server);

  char topic[40];
  snprintf(topic, sizeof(topic), "%s/d/boot", storage.device.name);

  esp_mqtt_client_config_t mqtt_cfg = {
    .broker.address.uri                  = mqtt_url,
    .broker.verification.certificate     = (const char *)isrgrootx1_pem_start,
    .credentials.username                = storage.device.name,
    .credentials.authentication.password = storage.device.key,
    .session.keepalive                   = 10,
    .session.last_will.topic             = topic,
    .session.last_will.msg               = "OFFLINE",
    .session.last_will.qos               = MQTT_QOS_1,
    .session.last_will.retain            = true,
    .buffer.size                         = 2048,
    .task.priority                       = 5,
  };

  mqtt = esp_mqtt_client_init(&mqtt_cfg);

  if (mqtt == NULL) {
    ERROR_SYSLOG(&init, MQTT, "client create failure", "MQTT_INIT_FAIL");
    goto finish;
  }

  esp_mqtt_client_register_event(mqtt, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);

  if (esp_mqtt_client_start(mqtt) != ESP_OK) {
    ERROR_SYSLOG(&init, MQTT, "client start failure", "MQTT_START_FAIL");
    esp_mqtt_client_destroy(mqtt);
    mqtt = NULL;
    goto finish;
  }

  // create mqtt publisher task
  if (xTaskCreate(mqtt_task, "mqtt", 4096, NULL, 5, NULL) != pdPASS) {
    ERROR_SYSLOG(&init, MQTT, "task create failure", "MQTT_TASK_FAIL");
    esp_mqtt_client_stop(mqtt);
    esp_mqtt_client_destroy(mqtt);
    mqtt = NULL;
    goto finish;
  }

finish:
  if (IS_OK(&init, MQTT)) {
    CLEAR_ALL(&logbuf.run, MQTT);
    SYSLOG("MQTT_RDY");
  } else {
    COPY_STATE(&logbuf.run, &init, MQTT);
  }
}
