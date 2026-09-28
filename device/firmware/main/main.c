#include <sys/time.h>
#include <time.h>

#include <stdbool.h>

#include "main.h"

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_mac.h"
#include "nvs_flash.h"

/***** global variables *****/
struct timeval boot;
nvs_handle_t nvs;
TaskHandle_t led;
QueueHandle_t logqueue;
QueueHandle_t syslogqueue;
QueueHandle_t canlogqueue;
QueueHandle_t cantxqueue;

nvs_storage_t storage;

state_t init = 0;

const char components[][8] = { "CORE", "NVS", "RTC", "SD", "WIFI", "MQTT", "CAN", "GPS", "ANALOG", "DIGITAL", "GYRO" };

/***** function prototypes *****/
void sdcard_init(void);
void mqtt_init(void);
bool network_init(void);
static void core_init(void);
static void nvs_init(void);
static void rtc_init(void);
static void peripheral_task_init(void);

void task_can(void *pvParameters);
void task_gps(void *pvParameters);
void task_analog(void *pvParameters);
void task_digital(void *pvParameters);
void task_gyroscope(void *pvParameters);
static void task_led(void *pvParameters);

static void reset_isr(void *arg);

/*******************************************************************************
 * main application entry point
 ******************************************************************************/
void app_main(void) {
  logbuf.run = ALL_ERROR_FATAL;
  /*** Core GPIO ***/
  core_init();

  /*** NVS ***/
  nvs_init();

  /*** RTC ***/
  rtc_init();

  /*** SDIO ***/
  sdcard_init();

  /*** peripherals ***/
  peripheral_task_init();

  /*** Wi-Fi ***/
  if (network_init()) {
    /*** MQTT ***/
    mqtt_init();
  }

  SYSLOG("INIT_DONE");
}

/*******************************************************************************
 * configuration reset button handler
 ******************************************************************************/
static void reset_isr(void *arg) {
  static int64_t press = 0;

  if (gpio_get_level(GPIO_NUM_21) == true) {
    press = esp_timer_get_time();
  } else if (esp_timer_get_time() - press > 3000000) {
    nvs_erase_all(nvs);
    nvs_commit(nvs);
    esp_restart();
  }
}

/*******************************************************************************
 * system status LED indicator
 ******************************************************************************/
static void task_led(void *pvParameters) {
  uint32_t led_state            = true;
  state_led_interval_t interval = STATE_OK;

  while (true) {
    if (logbuf.run & (COMPONENT_ALL << COMPONENT_MAX)) {
      interval = STATE_FATAL;
    } else if (logbuf.run & COMPONENT_ALL) {
      interval = STATE_ERROR;
    } else {
      interval = STATE_OK;
    }

    led_state = !led_state;
    gpio_set_level(GPIO_NUM_5, led_state);

    vTaskDelay(interval);
  }
}

/*******************************************************************************
 * init core GPIO and LED task
 ******************************************************************************/
static void core_init(void) {
  gpio_config_t gpio;

  /*** LED ***/
  gpio.pin_bit_mask = (1ULL << GPIO_NUM_5);
  gpio.mode         = GPIO_MODE_OUTPUT_OD;
  gpio.intr_type    = GPIO_INTR_DISABLE;
  gpio.pull_up_en   = GPIO_PULLUP_DISABLE;
  gpio.pull_down_en = GPIO_PULLDOWN_DISABLE;

  if (gpio_config(&gpio) != ESP_OK || xTaskCreate(task_led, "led", 2048, NULL, 5, &led) != pdPASS) {
    ERROR_LOG(&init, CORE, "LED config failure");
  }

  /*** RST ***/
  gpio.pin_bit_mask = (1ULL << GPIO_NUM_21);
  gpio.mode         = GPIO_MODE_INPUT;
  gpio.intr_type    = GPIO_INTR_ANYEDGE;
  gpio.pull_down_en = GPIO_PULLDOWN_ENABLE;

  esp_err_t ret = gpio_config(&gpio);
  ret |= gpio_install_isr_service(0);
  ret |= gpio_isr_handler_add(GPIO_NUM_21, reset_isr, NULL);

  if (ret != ESP_OK) {
    ERROR_LOG(&init, CORE, "RST config failure");
  }

  if (IS_OK(&init, CORE)) {
    CLEAR_ALL(&logbuf.run, CORE);
  } else {
    COPY_STATE(&logbuf.run, &init, CORE);
  }
}

/*******************************************************************************
 * init NVS and set default values
 ******************************************************************************/
static void nvs_init(void) {
  if (nvs_flash_init() != ESP_OK) {
    FATAL_LOG(&init, NVS, "NVS flash init failure");
    goto finish;
  }

  if (nvs_open("storage", NVS_READWRITE, &nvs) != ESP_OK) {
    FATAL_LOG(&init, NVS, "open failure");
    goto finish;
  }

  // set wifi default values
  esp_read_mac(storage.wifi.mac, ESP_MAC_WIFI_STA);
  snprintf(storage.wifi.macaddr, sizeof(storage.wifi.macaddr), "%02X:%02X:%02X:%02X:%02X:%02X", storage.wifi.mac[0],
    storage.wifi.mac[1], storage.wifi.mac[2], storage.wifi.mac[3], storage.wifi.mac[4], storage.wifi.mac[5]);

  size_t len = sizeof(storage.wifi.ssid);

  if (nvs_get_str(nvs, "ssid", storage.wifi.ssid, &len) != ESP_OK) {
    storage.wifi.ssid[0] = '\0';
    nvs_set_str(nvs, "ssid", "");
  }

  len = sizeof(storage.wifi.passwd);

  if (nvs_get_str(nvs, "passwd", storage.wifi.passwd, &len) != ESP_OK) {
    storage.wifi.passwd[0] = '\0';
    nvs_set_str(nvs, "passwd", "");
  }

  len = sizeof(storage.device.server);

  // set device configuration default values
  if (nvs_get_str(nvs, "server", storage.device.server, &len) != ESP_OK) {
    snprintf(storage.device.server, sizeof(storage.device.server), "v2.monolith.luftaquila.io");
    nvs_set_str(nvs, "server", storage.device.server);
  }

  len = sizeof(storage.device.name);

  if (nvs_get_str(nvs, "name", storage.device.name, &len) != ESP_OK) {
    snprintf(storage.device.name, sizeof(storage.device.name), "%02X%02X%02X%02X%02X%02X", storage.wifi.mac[0],
      storage.wifi.mac[1], storage.wifi.mac[2], storage.wifi.mac[3], storage.wifi.mac[4], storage.wifi.mac[5]);
    nvs_set_str(nvs, "name", storage.device.name);
  }

  len = sizeof(storage.device.key);

  if (nvs_get_str(nvs, "key", storage.device.key, &len) != ESP_OK) {
    snprintf(storage.device.key, sizeof(storage.device.key), "monolith");
    nvs_set_str(nvs, "key", storage.device.key);
  }

  len = sizeof(storage.device.key);

  // set device timezone default value
  if (nvs_get_str(nvs, "tz", storage.device.tz, &len) != ESP_OK) {
    snprintf(storage.device.tz, sizeof(storage.device.tz), "KST-9");
    nvs_set_str(nvs, "tz", storage.device.tz);
  }

  if (nvs_get_u32(nvs, "intv", &storage.device.intv) != ESP_OK) {
    nvs_set_u32(nvs, "intv", 500);
    storage.device.intv = 500;
  }

  // set peripheral enabled default values
  if (nvs_get_u8(nvs, "can_en", &storage.enabled.can) != ESP_OK) {
    nvs_set_u8(nvs, "can_en", true);
    storage.enabled.can = true;
  }

  if (nvs_get_u8(nvs, "gps_en", &storage.enabled.gps) != ESP_OK) {
    nvs_set_u8(nvs, "gps_en", true);
    storage.enabled.gps = true;
  }

  if (nvs_get_u8(nvs, "anl_en", &storage.enabled.analog) != ESP_OK) {
    nvs_set_u8(nvs, "anl_en", true);
    storage.enabled.analog = true;
  }

  if (nvs_get_u8(nvs, "dgt_en", &storage.enabled.digital) != ESP_OK) {
    nvs_set_u8(nvs, "dgt_en", true);
    storage.enabled.digital = true;
  }

  // set CAN default values
  if (nvs_get_u8(nvs, "can_bps", &storage.can.bps) != ESP_OK) {
    nvs_set_u8(nvs, "can_en", CAN_BPS_500K);
    storage.can.bps = CAN_BPS_500K;
  }

  if (nvs_get_u32(nvs, "can_filter", &storage.can.filter) != ESP_OK) {
    nvs_set_u32(nvs, "can_en", 0x00000000);
    storage.can.filter = 0x00000000;  // accept all
  }

  if (nvs_get_u32(nvs, "can_mask", &storage.can.mask) != ESP_OK) {
    nvs_set_u32(nvs, "can_en", 0xFFFFFFFF);
    storage.can.mask = 0xFFFFFFFF;  // accept all
  }

  // set GPS default values
  if (nvs_get_u8(nvs, "gps_dev", &storage.gps.dev) != ESP_OK) {
    nvs_set_u8(nvs, "gps_dev", GPS_DEV_UBLOX);
    storage.gps.dev = GPS_DEV_UBLOX;
  }

  // commit changes
  if (nvs_commit(nvs) != ESP_OK) {
    ERROR_SYSLOG(&logbuf.run, NVS, "commit failure", "NVS_COMMIT_FAIL");
  }

finish:
  if (IS_OK(&init, NVS)) {
    CLEAR_ALL(&logbuf.run, NVS);
  } else {
    COPY_STATE(&logbuf.run, &init, NVS);
  }
}

/*******************************************************************************
 * init RTC and set system time
 ******************************************************************************/
static void rtc_init(void) {
  // set timezone
  setenv("TZ", "UTC", 1);
  tzset();

  i2c_master_bus_handle_t i2c0;
  i2c_master_bus_config_t i2c_config = {
    .clk_source                   = I2C_CLK_SRC_DEFAULT,
    .i2c_port                     = I2C_NUM_0,
    .scl_io_num                   = GPIO_NUM_10,
    .sda_io_num                   = GPIO_NUM_9,
    .glitch_ignore_cnt            = 7,
    .flags.enable_internal_pullup = false,
  };

  if (i2c_new_master_bus(&i2c_config, &i2c0) != ESP_OK) {
    ERROR_LOG(&init, RTC, "I2C init failure");
    goto finish;
  }

  i2c_master_dev_handle_t rtc;
  i2c_device_config_t rtc_cfg = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address  = 0x51,
    .scl_speed_hz    = 100000,
  };

  if (i2c_master_bus_add_device(i2c0, &rtc_cfg, &rtc) != ESP_OK) {
    ERROR_LOG(&init, RTC, "device init failure");
    goto finish;
  }

  uint8_t tx[1] = { 0x02 };  // VL_seconds register address
  uint8_t rx[7] = { 0 };     // 0x02 VL_seconds to 0x08 Years register

  esp_err_t ret;
  int cnt = 0;

  do {
    ret = i2c_master_transmit_receive(rtc, tx, sizeof(tx), rx, sizeof(rx), I2C_TIMEOUT_MS);
    if (ret != ESP_OK) i2c_master_bus_reset(i2c0);
    cnt++;
  } while (ret != ESP_OK && cnt < 3);

  if (ret != ESP_OK) {
    i2c_master_bus_rm_device(rtc);
    FATAL_LOG(&init, RTC, "read time transfer failure");
    goto finish;
  }

  i2c_master_bus_rm_device(rtc);

  // rtc has valid time set
  if (rx[6] != 0x00) {
    struct tm tm = {
      .tm_sec  = BCD_TO_DEC(rx[0] & 0x7F),
      .tm_min  = BCD_TO_DEC(rx[1] & 0x7F),
      .tm_hour = BCD_TO_DEC(rx[2] & 0x3F),
      .tm_mday = BCD_TO_DEC(rx[3] & 0x3F),
      .tm_wday = BCD_TO_DEC(rx[4] & 0x07),
      .tm_mon  = BCD_TO_DEC(rx[5] & 0x1F) - 1,
      .tm_year = BCD_TO_DEC(rx[6]) + 100  // from 2000
    };

    time_t seconds = mktime(&tm);

    if (seconds == (time_t)-1) {
      ERROR_LOG(&init, RTC, "mktime failure");
      goto finish;
    }

    struct timeval tv = {
      .tv_sec  = seconds,
      .tv_usec = esp_timer_get_time() % 1000000,
    };

    settimeofday(&tv, NULL);
    INFO(RTC, "time set to %s", ctime(&tv.tv_sec));
  } else {
    ERROR_LOG(&init, RTC, "no valid time set");
    goto finish;
  }

finish:
  if (IS_OK(&init, RTC)) {
    CLEAR_ALL(&logbuf.run, RTC);
  } else {
    COPY_STATE(&logbuf.run, &init, RTC);
  }

  // read boot time
  gettimeofday(&boot, NULL);
}

/*******************************************************************************
 create peripheral recorder tasks
 ******************************************************************************/
static void peripheral_task_init(void) {
  /***** CAN *****/
  if (storage.enabled.can) {
    if (xTaskCreate(task_can, "can", 4096, NULL, 4, NULL) != pdPASS) {
      ERROR_SYSLOG(&init, CORE, "CAN task create failure", "CAN_TASK_FAIL");
    }
  } else {
    CLEAR_ALL(&logbuf.run, CAN);
  }

  /***** GPS *****/
  if (storage.enabled.gps) {
    if (xTaskCreate(task_gps, "gps", 4096, NULL, 5, NULL) != pdPASS) {
      ERROR_SYSLOG(&init, CORE, "GPS task create failure", "GPS_TASK_FAIL");
    }
  } else {
    CLEAR_ALL(&logbuf.run, GPS);
  }

  /***** ANALOG *****/
  if (storage.enabled.analog) {
    if (xTaskCreate(task_analog, "analog", 4096, NULL, 5, NULL) != pdPASS) {
      ERROR_SYSLOG(&init, CORE, "ANALOG task create failure", "ANL_TASK_FAIL");
    }
  } else {
    CLEAR_ALL(&logbuf.run, ANALOG);
  }

#ifndef CONFIG_MONOLITH_MINI
  /***** DIGITAL *****/
  if (storage.enabled.digital) {
    if (xTaskCreate(task_digital, "digital", 4096, NULL, 5, NULL) != pdPASS) {
      ERROR_SYSLOG(&init, CORE, "DIGITAL task create failure", "DGT_TASK_FAIL");
    }
  } else {
    CLEAR_ALL(&logbuf.run, DIGITAL);
  }
#else
  CLEAR_ALL(&logbuf.run, DIGITAL);
#endif

  /***** GYROSCOPE (always enabled) *****/
  if (xTaskCreate(task_gyroscope, "gyroscope", 4096, NULL, 5, NULL) != pdPASS) {
    ERROR_SYSLOG(&init, CORE, "GYROSCOPE task create failure", "GYR_TASK_FAIL");
  }
}
