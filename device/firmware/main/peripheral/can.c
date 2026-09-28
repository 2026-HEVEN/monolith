#include "main.h"

#include "driver/twai.h"

#define CAN_ALERT_ERROR                                                                                        \
  (TWAI_ALERT_ERR_ACTIVE | TWAI_ALERT_RECOVERY_IN_PROGRESS | TWAI_ALERT_ARB_LOST | TWAI_ALERT_ABOVE_ERR_WARN | \
    TWAI_ALERT_BUS_ERROR | TWAI_ALERT_TX_FAILED | TWAI_ALERT_RX_QUEUE_FULL | TWAI_ALERT_ERR_PASS |             \
    TWAI_ALERT_BUS_OFF | TWAI_ALERT_RX_FIFO_OVERRUN)

#define CAN_ALERT_ENABLED (CAN_ALERT_ERROR)

static inline twai_timing_config_t select_baud(uint8_t can_bps) {
  switch (can_bps) {
    case CAN_BPS_1K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_1KBITS();
    case CAN_BPS_5K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_5KBITS();
    case CAN_BPS_10K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_10KBITS();
    case CAN_BPS_12_5K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_12_5KBITS();
    case CAN_BPS_16K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_16KBITS();
    case CAN_BPS_20K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_20KBITS();
    case CAN_BPS_25K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_25KBITS();
    case CAN_BPS_50K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_50KBITS();
    case CAN_BPS_100K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_100KBITS();
    case CAN_BPS_125K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_125KBITS();
    case CAN_BPS_250K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_250KBITS();
    case CAN_BPS_500K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_500KBITS();
    case CAN_BPS_800K:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_800KBITS();
    case CAN_BPS_1M:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_1MBITS();
    default:
      return (twai_timing_config_t)TWAI_TIMING_CONFIG_500KBITS();
  }
}

/***** CAN telemetry hash table *****/
#define HASH_SIZE 1024

typedef struct {
  uint32_t id;
  TickType_t last;
} id_entry_t;

static id_entry_t id_table[HASH_SIZE];

static inline uint32_t hash(uint32_t x) {
  x ^= x >> 16;
  x *= 0x7feb352d;
  x ^= x >> 15;
  x *= 0x846ca68b;
  x ^= x >> 16;
  return x;
}

static inline TickType_t *hash_table_lookup(uint32_t id) {
  uint32_t idx = hash(id) & (HASH_SIZE - 1);

  for (uint32_t i = 0; i < HASH_SIZE; i++) {
    id_entry_t *entry = &id_table[idx];

    if (entry->id == id) {
      return &entry->last;
    } else if (entry->id == 0) {
      entry->id   = id;
      return &entry->last;
    }

    idx = (idx + 1) & (HASH_SIZE - 1);
  }

  return NULL;
}

/*******************************************************************************
 * CAN traffic monitor / transmitter task
 ******************************************************************************/
void task_can(void *pvParameters) {
  twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(GPIO_NUM_7, GPIO_NUM_6, TWAI_MODE_NORMAL);
  g_config.rx_queue_len          = 1024;
  g_config.alerts_enabled        = CAN_ALERT_ENABLED;
  twai_timing_config_t t_config  = select_baud(storage.can.bps);
  twai_filter_config_t f_config  = {
     .single_filter   = true,
     .acceptance_code = storage.can.filter,
     .acceptance_mask = storage.can.mask,
  };

  if (twai_driver_install(&g_config, &t_config, &f_config) != ESP_OK || twai_start() != ESP_OK) {
    ERROR_SYSLOG(&init, CAN, "driver init failure", "CAN_INIT_FAIL");
  }

  if (IS_OK(&init, CAN)) {
    CLEAR_ALL(&logbuf.run, CAN);
    SYSLOG("CAN_RDY");
  } else {
    COPY_STATE(&logbuf.run, &init, CAN);
  }

  const TickType_t interval = pdMS_TO_TICKS(storage.device.intv);
  uint32_t prev_alerts      = 0;

  while (true) {
    // check CAN alerts
    uint32_t alerts = 0;
    twai_read_alerts(&alerts, 0);

    if (alerts) {
      if (alerts != prev_alerts) {
        char buf[sizeof(system_event_t)];
        snprintf(buf, sizeof(buf), "CANALT:%lX", alerts);
        SYSLOG(buf);

        if (alerts & CAN_ALERT_ERROR) {
          SET_ERROR(&logbuf.run, CAN);
        } else {
          CLEAR_ERROR(&logbuf.run, CAN);
        }
      }

      prev_alerts = alerts;
    } else if (prev_alerts) {
      CLEAR_ERROR(&logbuf.run, CAN);
      prev_alerts = 0;
    }

    // transmit CAN messages
    twai_message_t msg;

    while (cantxqueue) {
      if (xQueueReceive(cantxqueue, &msg, pdMS_TO_TICKS(0)) != pdTRUE) {
        break;
      }

      if (twai_transmit(&msg, pdMS_TO_TICKS(0)) == ESP_OK) {
        char buf[sizeof(system_event_t)];
        snprintf(buf, sizeof(buf), "CANTX:%lX", msg.identifier);
        SYSLOG(buf);
      } else {
        ERROR_SYSLOG(&logbuf.run, CAN, "transmit failure", "CAN_TX_FAIL");
      }
    }

    // receive CAN messages
    while (true) {
      if (twai_receive(&msg, pdMS_TO_TICKS(0)) != ESP_OK) {
        break;
      }

      log_t log;
      log.payload.can.id       = msg.identifier;
      log.payload.can.extended = msg.extd;
      log.payload.can.remote   = msg.rtr;
      log.payload.can.len      = msg.data_length_code;
      memcpy(log.payload.can.data, msg.data, msg.data_length_code);
      LOG(LOG_TYPE_CAN, &log);

      // check hash table to send telemetry or not
      TickType_t now   = xTaskGetTickCount();
      TickType_t *last = hash_table_lookup(msg.identifier | (msg.extd << 31));

      if (last && now - *last >= interval && canlogqueue) {
        *last = now;
        xQueueSend(canlogqueue, &log, 0);
      }
    }

    vTaskDelay(1);  // 1 tick = 1ms at 1000Hz
  }
}
