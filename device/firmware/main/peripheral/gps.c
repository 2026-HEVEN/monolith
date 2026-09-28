#include "main.h"

#include "driver/gpio.h"
#include "driver/uart.h"

QueueHandle_t uart_queue;

/* NMEA GPRMC message */
typedef struct {
  uint8_t *id;
  uint8_t *utc_time;
  uint8_t *status;
  uint8_t *lat;
  uint8_t *north;
  uint8_t *lon;
  uint8_t *east;
  uint8_t *speed;
  uint8_t *course;
  uint8_t *utc_date;
  uint8_t *others;
} nmea_gprmc_t;

#define FIND_AND_NUL(s, p, c) ((p) = (uint8_t *)strchr((char *)s, c), *(p) = '\0', ++(p), (p))

bool parse_nmea_gprmc(nmea_gprmc_t *gprmc, uint8_t *data) {
  gprmc->id       = data;
  gprmc->utc_time = FIND_AND_NUL(gprmc->id, gprmc->utc_time, ',');
  gprmc->status   = FIND_AND_NUL(gprmc->utc_time, gprmc->status, ',');

  if (*gprmc->status == 'A') {
    gprmc->lat      = FIND_AND_NUL(gprmc->status, gprmc->lat, ',');
    gprmc->north    = FIND_AND_NUL(gprmc->lat, gprmc->north, ',');
    gprmc->lon      = FIND_AND_NUL(gprmc->north, gprmc->lon, ',');
    gprmc->east     = FIND_AND_NUL(gprmc->lon, gprmc->east, ',');
    gprmc->speed    = FIND_AND_NUL(gprmc->east, gprmc->speed, ',');
    gprmc->course   = FIND_AND_NUL(gprmc->speed, gprmc->course, ',');
    gprmc->utc_date = FIND_AND_NUL(gprmc->course, gprmc->utc_date, ',');
    gprmc->others   = FIND_AND_NUL(gprmc->utc_date, gprmc->others, ',');

    return true;
  } else {
    return false;
  }
}

static const uint32_t GPS_BAUD_RATES[] = { 115200, 57600, 38400, 19200, 9600 };
#define GPS_BAUD_RATES_N (sizeof(GPS_BAUD_RATES) / sizeof(GPS_BAUD_RATES[0]))

void init_ublox(void) {
  uart_config_t uart_config = {
    .baud_rate = 9600,
    .data_bits = UART_DATA_8_BITS,
    .parity    = UART_PARITY_DISABLE,
    .stop_bits = UART_STOP_BITS_1,
    .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
  };

  if (uart_driver_install(UART_NUM_1, 2048, 256, 16, &uart_queue, 0) != ESP_OK ||
      uart_param_config(UART_NUM_1, &uart_config) != ESP_OK ||
      uart_set_pin(UART_NUM_1, GPIO_NUM_17, GPIO_NUM_18, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK ||
      uart_enable_pattern_det_baud_intr(UART_NUM_1, '\n', 1, 10, 0, 0) != ESP_OK) {
    ERROR_SYSLOG(&init, GPS, "UART driver init failure", "GPS_UART_FAIL");
  }

  // auto-detect baud rate: try each rate until valid NMEA data ('$') is received
  uint32_t bitrate = 9600;

  for (int i = 0; i < GPS_BAUD_RATES_N; i++) {
    uart_set_baudrate(UART_NUM_1, GPS_BAUD_RATES[i]);
    uart_flush_input(UART_NUM_1);
    uart_pattern_queue_reset(UART_NUM_1, 16);

    uint8_t peek[64];
    int len = uart_read_bytes(UART_NUM_1, peek, sizeof(peek), pdMS_TO_TICKS(1500));

    for (int j = 0; j < len; j++) {
      if (peek[j] == '$') {
        bitrate = GPS_BAUD_RATES[i];
        goto baud_found;
      }
    }
  }

baud_found:
  uart_set_baudrate(UART_NUM_1, bitrate);
  uart_flush_input(UART_NUM_1);
  uart_pattern_queue_reset(UART_NUM_1, 16);

  const uint8_t GPS_DISABLE_NMEA_GxGGA[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x24 };
  const uint8_t GPS_DISABLE_NMEA_GxGLL[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x01, 0x2B };
  const uint8_t GPS_DISABLE_NMEA_GxGSA[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x02, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x02, 0x32 };
  const uint8_t GPS_DISABLE_NMEA_GxGSV[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x03, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x03, 0x39 };
  const uint8_t GPS_DISABLE_NMEA_GxVTG[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x05, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x05, 0x47 };
  const uint8_t GPS_DISABLE_NMEA_GxZDA[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x08, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x07, 0x5B };
  const uint8_t GPS_DISABLE_NMEA_GxTXT[] = { 0xB5, 0x62, 0x06, 0x01, 0x08, 0x00, 0xF0, 0x41, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x40, 0xEA };

  const uint8_t GPS_PMS_FULL[]  = { 0xB5, 0x62, 0x06, 0x86, 0x00, 0x00, 0x8C, 0xAA };
  const uint8_t GPS_RATE_10HZ[] = { 0xB5, 0x62, 0x06, 0x08, 0x06, 0x00, 0x64, 0x00, 0x01, 0x00, 0x01, 0x00, 0x7A,
    0x12 };

  if (uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxGGA, sizeof(GPS_DISABLE_NMEA_GxGGA)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxGLL, sizeof(GPS_DISABLE_NMEA_GxGLL)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxGSA, sizeof(GPS_DISABLE_NMEA_GxGSA)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxGSV, sizeof(GPS_DISABLE_NMEA_GxGSV)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxVTG, sizeof(GPS_DISABLE_NMEA_GxVTG)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxZDA, sizeof(GPS_DISABLE_NMEA_GxZDA)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_DISABLE_NMEA_GxTXT, sizeof(GPS_DISABLE_NMEA_GxTXT)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_PMS_FULL, sizeof(GPS_PMS_FULL)) < 0 ||
      uart_write_bytes(UART_NUM_1, GPS_RATE_10HZ, sizeof(GPS_RATE_10HZ)) < 0) {
    ERROR_SYSLOG(&init, GPS, "module config failure", "GPS_CFG_FAIL");
  }

  uart_flush_input(UART_NUM_1);
}

/*******************************************************************************
 * Integer-only fixed-point NMEA field parser
 * Parses decimal string to integer scaled by 10^target_frac_digits.
 ******************************************************************************/
static uint32_t parse_nmea_fixed(const char *s, int target_frac_digits) {
  uint32_t integer = 0, frac = 0;
  int frac_digits = 0;

  while (*s >= '0' && *s <= '9') { integer = integer * 10 + (*s++ - '0'); }
  if (*s == '.') {
    s++;
    while (*s >= '0' && *s <= '9' && frac_digits < target_frac_digits + 1) {
      frac = frac * 10 + (*s++ - '0');
      frac_digits++;
    }
  }

  while (frac_digits < target_frac_digits) { frac *= 10; frac_digits++; }
  while (frac_digits > target_frac_digits) { frac = (frac + 5) / 10; frac_digits--; }

  uint32_t scale = 1;
  for (int i = 0; i < target_frac_digits; i++) scale *= 10;
  return integer * scale + frac;
}

/*******************************************************************************
 * GPS NMEA GPRMC message monitor task
 ******************************************************************************/
void task_gps(void *pvParameters) {
  switch (storage.gps.dev) {
    case GPS_DEV_UBLOX:
      init_ublox();
      break;

    default:
      ERROR_SYSLOG(&init, GPS, "unknown device", "GPS_DEV_UNKNOWN");
      break;
  }

  if (IS_OK(&init, GPS)) {
    CLEAR_ALL(&logbuf.run, GPS);
    SYSLOG("GPS_RDY");
  } else {
    COPY_STATE(&logbuf.run, &init, GPS);
  }

  log_t gps;
  uint8_t data[256];
  uart_event_t event;
  nmea_gprmc_t gprmc;
  uint8_t gps_state = 0;  // 0: unknown, 1: nmea ok, 2: comm error, 3: fatal

  while (true) {
    if (xQueueReceive(uart_queue, &event, pdMS_TO_TICKS(5000)) != pdTRUE) {
      if (gps_state != 3) {
        gps_state = 3;
        CLEAR_ERROR(&logbuf.run, GPS);
        SET_FATAL(&logbuf.run, GPS);
      }
      continue;
    }

    if (event.type != UART_PATTERN_DET) {
      continue;
    }

    int pos = uart_pattern_pop_pos(UART_NUM_1);

    if (pos < 0 || pos >= sizeof(data) || uart_read_bytes(UART_NUM_1, data, pos + 1, pdMS_TO_TICKS(0)) < 6) {
      uart_flush_input(UART_NUM_1);
      uart_pattern_queue_reset(UART_NUM_1, 16);
      continue;
    }

    if (data[0] == '$') {
      if (gps_state != 1) {
        gps_state = 1;
        CLEAR_ALL(&logbuf.run, GPS);
      }

      if (strncmp((char *)data, "$GNRMC", 6) == 0 || strncmp((char *)data, "$GPRMC", 6) == 0) {
        if (parse_nmea_gprmc(&gprmc, data)) {
          gps.payload.gps.latitude  = parse_nmea_fixed((char *)gprmc.lat, 5);
          gps.payload.gps.longitude = parse_nmea_fixed((char *)gprmc.lon, 5);
          gps.payload.gps.lat_dir   = *gprmc.north;
          gps.payload.gps.lon_dir   = *gprmc.east;
          uint32_t speed_x100       = parse_nmea_fixed((char *)gprmc.speed, 2);
          gps.payload.gps.speed     = (uint16_t)((speed_x100 * 1852 + 500) / 1000);
          gps.payload.gps.course    = (uint16_t)parse_nmea_fixed((char *)gprmc.course, 2);
          LOG(LOG_TYPE_GPS, &gps);
          memcpy(&logbuf.gps, &gps, sizeof(log_t));
        }
      }
    } else if (gps_state != 2) {
      gps_state = 2;
      CLEAR_FATAL(&logbuf.run, GPS);
      SET_ERROR(&logbuf.run, GPS);
    }

    uart_pattern_queue_reset(UART_NUM_1, 16);
  }
}
