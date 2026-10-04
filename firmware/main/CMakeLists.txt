idf_component_register(
  SRCS "app.cpp" "board_waveshare.cpp" "display.cpp" "raster.cpp"
    "text.cpp" "net.cpp" "portal.cpp" "ota.cpp" "audio.cpp" "voice.cpp" "settings.cpp"
  INCLUDE_DIRS "."
  PRIV_REQUIRES esp_driver_i2c esp_driver_spi esp_driver_gpio esp_driver_ledc esp_driver_i2s esp_lcd esp_wifi
    esp_netif esp_event nvs_flash esp_http_client esp_http_server json esp_timer app_update esp_app_format)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-missing-field-initializers)
