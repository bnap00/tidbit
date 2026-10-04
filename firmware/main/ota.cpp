#include "ota.h"

#include <esp_app_desc.h>
#include <esp_heap_caps.h>
#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <mdns.h>
#include <sdkconfig.h>
#include <stdio.h>
#include <string.h>
#include <string>

#include "app.h"
#include "board.h"
#include "display.h"
#include "voice.h"

static const char* TAG = "ota";

/** Compare without stopping at the first difference. */
static bool same(const char* a, const char* b) {
  size_t la = strlen(a), lb = strlen(b);
  unsigned diff = la ^ lb;
  for (size_t i = 0; i < la; i++) diff |= (unsigned)(a[i] ^ b[i % (lb ? lb : 1)]);
  return diff == 0;
}

static esp_err_t info(httpd_req_t* req) {
  const esp_app_desc_t* app = esp_app_get_description();
  const esp_partition_t* running = esp_ota_get_running_partition();
  char sha[17];
  esp_app_get_elf_sha256(sha, sizeof sha);
  std::string json = std::string("{\"board\":\"") + board().name + "\",\"version\":\"" +
                     app->version + "\",\"build\":\"" + sha + "\",\"slot\":\"" +
                     running->label + "\"";
  // The IMU, to check its axes against the screen (see board_motion).
  Motion m = board_motion();
  if (m.ok) {
    char buf[96];
    snprintf(buf, sizeof buf, ",\"accel\":[%.2f,%.2f,%.2f],\"gyro\":[%.0f,%.0f,%.0f]", m.ax, m.ay,
             m.az, m.gx, m.gy, m.gz);
    json += buf;
  }
  // Health: memory, uptime, and whether frames are arriving and being drawn.
  uint32_t got, drawn;
  {
    Lock l;
    got = shared.frameVersion;
    drawn = shared.framesDrawn;
  }
  char health[200];
  snprintf(health, sizeof health,
           ",\"uptime\":%lld,\"frames\":{\"got\":%lu,\"drawn\":%lu},\"internal\":{\"free\":%u,\"min\":%u,\"block\":%u}",
           esp_timer_get_time() / 1000000, (unsigned long)got, (unsigned long)drawn,
           (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
           (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
  json += health;
  snprintf(health, sizeof health, ",\"screen\":{\"stage\":%d,\"loops\":%lu,\"display\":%d,\"done\":%lu,\"task\":%d}", screen_stage,
           (unsigned long)screen_loops, display_stage, (unsigned long)display_done,
           screen_task_handle ? (int)eTaskGetState(screen_task_handle) : -1);
  json += health;
  json += std::string(",\"voice\":") + (voice_ready() ? "true" : "false") + "}";
  httpd_resp_set_type(req, "application/json");
  return httpd_resp_send(req, json.data(), json.size());
}

static esp_err_t update(httpd_req_t* req) {
  char pass[96] = {};
  if (httpd_req_get_hdr_value_str(req, "X-OTA-Password", pass, sizeof pass) != ESP_OK ||
      !same(pass, CONFIG_PAL_OTA_PASSWORD))
    return httpd_resp_send_err(req, HTTPD_401_UNAUTHORIZED, "wrong password");
  const esp_partition_t* slot = esp_ota_get_next_update_partition(nullptr);
  if (!slot || req->content_len == 0 || req->content_len > slot->size)
    return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad size");

  esp_ota_handle_t ota;
  if (esp_ota_begin(slot, req->content_len, &ota) != ESP_OK)
    return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "can't start");
  ESP_LOGI(TAG, "receiving %u bytes into %s", (unsigned)req->content_len, slot->label);
  set_mode(Mode::Updating, "Updating… 0%");

  static char buf[4096];
  size_t got = 0;
  int shown = 0;
  while (got < req->content_len) {
    int n = httpd_req_recv(req, buf, sizeof buf);
    if (n == HTTPD_SOCK_ERR_TIMEOUT) continue;
    if (n <= 0 || esp_ota_write(ota, buf, n) != ESP_OK) {
      esp_ota_abort(ota);
      set_mode(Mode::Linking, "Update failed.");
      return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "write failed");
    }
    got += n;
    int pct = (int)(got * 100 / req->content_len);
    if (pct >= shown + 5) {
      shown = pct;
      set_mode(Mode::Updating, "Updating… " + std::to_string(pct) + "%");
    }
  }
  // esp_ota_end checks the image (and its SHA-256) before it can boot.
  if (esp_ota_end(ota) != ESP_OK || esp_ota_set_boot_partition(slot) != ESP_OK) {
    set_mode(Mode::Linking, "Update failed: bad image.");
    return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "invalid image");
  }
  httpd_resp_sendstr(req, "ok, restarting\n");
  set_mode(Mode::Updating, "Updated. Restarting…");
  ESP_LOGI(TAG, "update written; restarting");
  vTaskDelay(pdMS_TO_TICKS(500));
  esp_restart();
}

void ota_start() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char host[24];
  snprintf(host, sizeof host, "tidbit-%02x%02x", mac[4], mac[5]);
  if (mdns_init() == ESP_OK) {
    mdns_hostname_set(host);
    mdns_instance_name_set(board().name);
    mdns_service_add(nullptr, "_tidbit", "_tcp", 80, nullptr, 0);
  }
  if (!strlen(CONFIG_PAL_OTA_PASSWORD)) {
    ESP_LOGW(TAG, "no PAL_OTA_PASSWORD: updates over Wi-Fi are off");
    return;
  }
  httpd_handle_t server = nullptr;
  httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
  hc.stack_size = 8192;
  hc.recv_wait_timeout = 10;
  if (httpd_start(&server, &hc) != ESP_OK) return;
  httpd_uri_t get = {.uri = "/info", .method = HTTP_GET, .handler = info, .user_ctx = nullptr};
  httpd_uri_t post = {.uri = "/ota", .method = HTTP_POST, .handler = update, .user_ctx = nullptr};
  httpd_register_uri_handler(server, &get);
  httpd_register_uri_handler(server, &post);
  ESP_LOGI(TAG, "updates at http://%s.local/ota (version %s)", host,
           esp_app_get_description()->version);
}

void ota_confirm_later() {
  esp_ota_img_states_t state;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) != ESP_OK ||
      state != ESP_OTA_IMG_PENDING_VERIFY)
    return;
  static esp_timer_handle_t timer;
  esp_timer_create_args_t args = {};
  args.callback = [](void*) {
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "this build is good; rollback cancelled");
  };
  args.name = "ota_ok";
  esp_timer_create(&args, &timer);
  esp_timer_start_once(timer, 30'000'000);
}
