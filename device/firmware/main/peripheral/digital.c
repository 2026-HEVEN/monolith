#include "main.h"

#include "driver/gpio.h"

static void digital_isr(void *arg) {
  logbuf.digital.payload.digital.din1 = gpio_get_level(GPIO_NUM_11);
  logbuf.digital.payload.digital.din2 = gpio_get_level(GPIO_NUM_12);
  logbuf.digital.payload.digital.din3 = gpio_get_level(GPIO_NUM_13);
  logbuf.digital.payload.digital.din4 = gpio_get_level(GPIO_NUM_14);
  LOG_FROM_ISR(LOG_TYPE_DIGITAL, &logbuf.digital);
}

/*******************************************************************************
 * Digital input interrupt monitor task
 ******************************************************************************/
void task_digital(void *pvParameters) {
  gpio_config_t gpio;

  gpio.pin_bit_mask = (1ULL << GPIO_NUM_11) | (1ULL << GPIO_NUM_12) | (1ULL << GPIO_NUM_13) | (1ULL << GPIO_NUM_14);
  gpio.mode         = GPIO_MODE_INPUT;
  gpio.intr_type    = GPIO_INTR_ANYEDGE;
  gpio.pull_up_en   = GPIO_PULLUP_DISABLE;
  gpio.pull_down_en = GPIO_PULLDOWN_ENABLE;

  if (gpio_config(&gpio) != ESP_OK) {
    ERROR_SYSLOG(&init, DIGITAL, "GPIO init failure", "DGT_INIT_FAIL");
  }

  // record initial state
  logbuf.digital.payload.digital.din1 = gpio_get_level(GPIO_NUM_11);
  logbuf.digital.payload.digital.din2 = gpio_get_level(GPIO_NUM_12);
  logbuf.digital.payload.digital.din3 = gpio_get_level(GPIO_NUM_13);
  logbuf.digital.payload.digital.din4 = gpio_get_level(GPIO_NUM_14);
  LOG(LOG_TYPE_DIGITAL, &logbuf.digital);

  esp_err_t ret = gpio_isr_handler_add(GPIO_NUM_11, digital_isr, NULL);
  ret |= gpio_isr_handler_add(GPIO_NUM_12, digital_isr, NULL);
  ret |= gpio_isr_handler_add(GPIO_NUM_13, digital_isr, NULL);
  ret |= gpio_isr_handler_add(GPIO_NUM_14, digital_isr, NULL);

  if (ret != ESP_OK) {
    ERROR_SYSLOG(&init, DIGITAL, "GPIO isr install failure", "DGT_ISR_FAIL");
  }

  if (IS_OK(&init, DIGITAL)) {
    CLEAR_ALL(&logbuf.run, DIGITAL);
    SYSLOG("DGT_RDY");
  } else {
    COPY_STATE(&logbuf.run, &init, DIGITAL);
  }

  vTaskDelete(NULL);
}
