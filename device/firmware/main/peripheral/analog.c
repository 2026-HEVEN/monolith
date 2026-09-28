#include "main.h"

#include "driver/temperature_sensor.h"

#ifndef CONFIG_MONOLITH_MINI
#include "driver/i2c_master.h"

#define ADS1115_CONVERSION_REG_ADDR 0x00
#define ADS1115_CONFIG_REG_ADDR 0x01

#define MUX_AIN0 (0b100 << 4)
#define MUX_AIN1 (0b101 << 4)
#define MUX_AIN2 (0b110 << 4)
#define MUX_AIN3 (0b111 << 4)
#define ADS1115_OS (1 << 7)

#define ADS1115_CONFIG_H 0x03  // +-4.096V FSR, single-shot mode
#define ADS1115_CONFIG_L 0xE3  // 860SPS (1.16ms per conversion)
#define ADS1115_CONFIG(channel) (ADS1115_CONFIG_H | ADS1115_OS | channel)

#define VOLT(v) ((int)(((v) * 2048) >> 15))

static i2c_master_bus_handle_t i2c1;

esp_err_t adc_start(i2c_master_dev_handle_t adc, uint8_t ch) {
  uint8_t tx[3] = { ADS1115_CONFIG_REG_ADDR, ADS1115_CONFIG(ch), ADS1115_CONFIG_L };
  return i2c_master_transmit(adc, tx, sizeof(tx), I2C_TIMEOUT_MS);
}

esp_err_t adc_read(i2c_master_dev_handle_t adc, int16_t *v) {
  uint8_t tx_conv = ADS1115_CONVERSION_REG_ADDR;
  uint8_t rx[2]   = { 0 };
  esp_err_t ret = i2c_master_transmit_receive(adc, &tx_conv, sizeof(tx_conv), rx, sizeof(rx), I2C_TIMEOUT_MS);
  *v = ((int16_t)rx[0] << 8) | rx[1];
  return ret;
}

/*******************************************************************************
 * Analog channel and temperature sensor monitor task
 ******************************************************************************/
void task_analog(void *pvParameters) {
  // initialize temperature sensor
  temperature_sensor_handle_t sensor     = NULL;
  temperature_sensor_config_t sensor_cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(10, 80);

  if (temperature_sensor_install(&sensor_cfg, &sensor) != ESP_OK || temperature_sensor_enable(sensor) != ESP_OK) {
    ERROR_SYSLOG(&init, ANALOG, "temperature sensor init failure", "TMP_INIT_FAIL");
  }

  // initialize i2c bus and adc
  i2c_master_bus_config_t i2c_config = {
    .clk_source                   = I2C_CLK_SRC_DEFAULT,
    .i2c_port                     = I2C_NUM_1,
    .scl_io_num                   = GPIO_NUM_48,
    .sda_io_num                   = GPIO_NUM_47,
    .glitch_ignore_cnt            = 7,
    .flags.enable_internal_pullup = false,
  };

  if (i2c_new_master_bus(&i2c_config, &i2c1) != ESP_OK) {
    ERROR_SYSLOG(&init, ANALOG, "I2C init failure", "ANL_INIT_FAIL");
    vTaskDelete(NULL);
  }

  i2c_master_dev_handle_t adc1;
  i2c_device_config_t adc1_cfg = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address  = 0x48,
    .scl_speed_hz    = 400000,
  };

  i2c_master_dev_handle_t adc2;
  i2c_device_config_t adc2_cfg = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address  = 0x49,
    .scl_speed_hz    = 400000,
  };

  esp_err_t ret = i2c_master_bus_add_device(i2c1, &adc1_cfg, &adc1);
  ret |= i2c_master_bus_add_device(i2c1, &adc2_cfg, &adc2);

  if (ret != ESP_OK) {
    i2c_del_master_bus(i2c1);
    ERROR_SYSLOG(&init, ANALOG, "device init failure", "ANL_DEV_FAIL");
    vTaskDelete(NULL);
  }

  if (IS_OK(&init, ANALOG)) {
    CLEAR_ALL(&logbuf.run, ANALOG);
    SYSLOG("ANL_RDY");
  } else {
    COPY_STATE(&logbuf.run, &init, ANALOG);
  }

  TickType_t xLastWakeTime = xTaskGetTickCount();

  float temperature;
  log_t analog;

  while (true) {
    esp_err_t err = ESP_OK;

    // 3 paired cycles: adc1 + adc2 simultaneous conversion
    uint8_t  ch[]   = { MUX_AIN0, MUX_AIN1, MUX_AIN2 };
    int16_t *dst1[] = { &analog.payload.analog.ain1, &analog.payload.analog.ain2, &analog.payload.analog.ain3 };
    int16_t *dst2[] = { &analog.payload.analog.ain5, &analog.payload.analog.ain6, &analog.payload.analog.voltage };

    for (int i = 0; i < 3; i++) {
      int cnt = 0;
      esp_err_t ret;
      do {
        if (cnt) i2c_master_bus_reset(i2c1);
        ret  = adc_start(adc1, ch[i]);
        ret |= adc_start(adc2, ch[i]);
        esp_rom_delay_us(1400);
        ret |= adc_read(adc1, dst1[i]);
        ret |= adc_read(adc2, dst2[i]);
        cnt++;
      } while (ret != ESP_OK && cnt < 2);
      err |= ret;
    }

    // single cycle: adc1 AIN3
    {
      int cnt = 0;
      esp_err_t ret;
      do {
        if (cnt) i2c_master_bus_reset(i2c1);
        ret  = adc_start(adc1, MUX_AIN3);
        esp_rom_delay_us(1400);
        ret |= adc_read(adc1, &analog.payload.analog.ain4);
        cnt++;
      } while (ret != ESP_OK && cnt < 2);
      err |= ret;
    }

    err |= temperature_sensor_get_celsius(sensor, &temperature);

    if (err == ESP_OK) {
      analog.payload.analog.temperature = (int16_t)(temperature * 100);
      LOG(LOG_TYPE_ANALOG, &analog);
      memcpy(&logbuf.analog, &analog, sizeof(log_t));

      if (IS_ERROR(&logbuf.run, ANALOG)) {
        CLEAR_ERROR(&logbuf.run, ANALOG);
      }
    } else {
      ERROR_SYSLOG(&logbuf.run, ANALOG, "ADC read failure", "ADC_READ_FAIL");
    }

    xTaskDelayUntil(&xLastWakeTime, TASK_INTERVAL_ANALOG);
  }
}
#else
#include "esp_adc/adc_oneshot.h"

void task_analog(void *pvParameters) {
  // initialize temperature sensor
  temperature_sensor_handle_t sensor     = NULL;
  temperature_sensor_config_t sensor_cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(10, 80);

  if (temperature_sensor_install(&sensor_cfg, &sensor) != ESP_OK || temperature_sensor_enable(sensor) != ESP_OK) {
    ERROR_SYSLOG(&init, ANALOG, "temperature sensor init failure", "TMP_INIT_FAIL");
  }

  // initialize internal ADC
  adc_oneshot_unit_handle_t adc_handle;
  adc_oneshot_unit_init_cfg_t adc_config = {
    .unit_id = ADC_UNIT_1,
  };

  if (adc_oneshot_new_unit(&adc_config, &adc_handle) != ESP_OK) {
    ERROR_SYSLOG(&init, ANALOG, "init failure", "ANL_INIT_FAIL");
  }

  adc_oneshot_chan_cfg_t channel_config = {
    .atten    = ADC_ATTEN_DB_0,
    .bitwidth = ADC_BITWIDTH_DEFAULT,
  };

  if (adc_oneshot_config_channel(adc_handle, ADC_CHANNEL_7, &channel_config) != ESP_OK) {
    adc_oneshot_del_unit(adc_handle);
    ERROR_SYSLOG(&init, ANALOG, "channel config failure", "ANL_CH_CFG_FAIL");
  }

  adc_cali_handle_t cal_handle               = NULL;
  adc_cali_curve_fitting_config_t cal_config = {
    .unit_id  = ADC_UNIT_1,
    .chan     = ADC_CHANNEL_7,
    .atten    = ADC_ATTEN_DB_0,
    .bitwidth = ADC_BITWIDTH_DEFAULT,
  };

  if (adc_cali_create_scheme_curve_fitting(&cal_config, &cal_handle) != ESP_OK) {
    ERROR_SYSLOG(&init, ANALOG, "calibration failure", "ANL_CAL_FAIL");
  }

  if (IS_OK(&init, ANALOG)) {
    CLEAR_ALL(&logbuf.run, ANALOG);
    SYSLOG("ANL_RDY");
  } else {
    COPY_STATE(&logbuf.run, &init, ANALOG);
  }

  TickType_t xLastWakeTime = xTaskGetTickCount();

  int raw, mv;
  float temperature;
  log_t analog = {0};

  while (true) {
    esp_err_t err = temperature_sensor_get_celsius(sensor, &temperature);
    err |= adc_oneshot_read(adc_handle, ADC_CHANNEL_7, &raw);
    err |= adc_cali_raw_to_voltage(cal_handle, raw, &mv);

    if (err == ESP_OK) {
      analog.payload.analog.voltage = (int16_t)(mv * 8); // to match ADS1115 range (mV / 1000 * 32768 / 4.096)
      analog.payload.analog.temperature = (int16_t)(temperature * 100);
      LOG(LOG_TYPE_ANALOG, &analog);
      memcpy(&logbuf.analog, &analog, sizeof(log_t));

      if (IS_ERROR(&logbuf.run, ANALOG)) {
        CLEAR_ERROR(&logbuf.run, ANALOG);
      }
    } else {
      ERROR_SYSLOG(&logbuf.run, ANALOG, "read failure", "ANL_READ_FAIL");
    }

    xTaskDelayUntil(&xLastWakeTime, TASK_INTERVAL_ANALOG);
  }
}
#endif
