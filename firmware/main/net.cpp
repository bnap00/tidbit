#include "net.h"

#include <cJSON.h>
#include <esp_event.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <esp_websocket_client.h>
#include <esp_wifi.h>
#include <freertos/event_groups.h>
#include <nvs.h>
#include <sdkconfig.h>
#include <string.h>
#include <algorithm>
#include <atomic>
#include <vector>

#include "app.h"
#include "board.h"
#include "ota.h"

static const char* TAG = "net";
static constexpr int FRAME_MAX = 8192;

// ---- Config ---------------------------------------------------------------------

static std::string nvs_str(nvs_handle_t h, const char* key) {
  size_t len = 0;
  if (nvs_get_str(h, key, nullptr, &len) != ESP_OK || len == 0) return "";
  std::string s(len, '\0');
  nvs_get_str(h, key, s.data(), &len);
  s.resize(len - 1);
  return s;
}

Config config_load() {
  Config c;
  nvs_handle_t h;
  if (nvs_open("pal", NVS_READONLY, &h) == ESP_OK) {
    c.ssid = nvs_str(h, "ssid");
    c.password = nvs_str(h, "pass");
    c.server = nvs_str(h, "server");
    c.token = nvs_str(h, "token");
    nvs_close(h);
  }
  if (c.ssid.empty()) {
    c.ssid = CONFIG_PAL_WIFI_SSID;
    c.password = CONFIG_PAL_WIFI_PASSWORD;
  }
  if (c.server.empty()) c.server = CONFIG_PAL_SERVER;
  return c;
}

void config_save(const Config& c) {
  nvs_handle_t h;
  ESP_ERROR_CHECK(nvs_open("pal", NVS_READWRITE, &h));
  nvs_set_str(h, "ssid", c.ssid.c_str());
  nvs_set_str(h, "pass", c.password.c_str());
  nvs_set_str(h, "server", c.server.c_str());
  nvs_set_str(h, "token", c.token.c_str());
  nvs_commit(h);
  nvs_close(h);
}

// ---- Wi-Fi ----------------------------------------------------------------------

static EventGroupHandle_t wifi_events;
static constexpr EventBits_t GOT_IP = BIT0;

static void on_wifi(void*, esp_event_base_t base, int32_t id, void*) {
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
  if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    xEventGroupClearBits(wifi_events, GOT_IP);
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_wifi_connect();
  }
  if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) xEventGroupSetBits(wifi_events, GOT_IP);
}

static void wifi_start(const Config& cfg) {
  wifi_events = xEventGroupCreate();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  // The settings come from NVS every boot; don't write them to flash on each reconnect.
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, nullptr);
  esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, nullptr);
  wifi_config_t wc = {};
  strlcpy((char*)wc.sta.ssid, cfg.ssid.c_str(), sizeof wc.sta.ssid);
  strlcpy((char*)wc.sta.password, cfg.password.c_str(), sizeof wc.sta.password);
  wc.sta.threshold.authmode = cfg.password.empty() ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK;
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
  ESP_ERROR_CHECK(esp_wifi_start());
  // Frames arrive continuously; modem sleep would add latency to every one.
  esp_wifi_set_ps(WIFI_PS_NONE);
}

static void wait_for_wifi(const Config& cfg) {
  set_mode(Mode::Joining, "Joining " + cfg.ssid + "…");
  int waited = 0;
  while (!(xEventGroupWaitBits(wifi_events, GOT_IP, false, true, pdMS_TO_TICKS(1000)) & GOT_IP)) {
    if (++waited == 20)
      set_mode(Mode::Joining, "Can't join " + cfg.ssid + " yet.\nHold " + board().button + " for 10 s to change Wi-Fi.");
  }
}

// ---- HTTP -----------------------------------------------------------------------

/** host:port, without a scheme or trailing slash. */
static std::string server_host(std::string s) {
  for (const char* p : {"http://", "ws://"})
    if (s.rfind(p, 0) == 0) s = s.substr(strlen(p));
  while (!s.empty() && s.back() == '/') s.pop_back();
  return s;
}

/** POST JSON; returns the HTTP status (or -1) and fills `out`. */
static int post_json(const std::string& url, const std::string& body, std::string& out) {
  esp_http_client_config_t cfg = {};
  cfg.url = url.c_str();
  cfg.method = HTTP_METHOD_POST;
  cfg.timeout_ms = 8000;
  esp_http_client_handle_t h = esp_http_client_init(&cfg);
  esp_http_client_set_header(h, "Content-Type", "application/json");
  int status = -1;
  out.clear();
  if (esp_http_client_open(h, body.size()) == ESP_OK &&
      esp_http_client_write(h, body.data(), body.size()) == (int)body.size() &&
      esp_http_client_fetch_headers(h) >= 0) {
    status = esp_http_client_get_status_code(h);
    char buf[256];
    int n;
    while ((n = esp_http_client_read(h, buf, sizeof buf)) > 0 && out.size() < 4096) out.append(buf, n);
  }
  esp_http_client_cleanup(h);
  return status;
}

static std::string json_str(cJSON* o, const char* key) {
  cJSON* v = cJSON_GetObjectItem(o, key);
  return cJSON_IsString(v) ? v->valuestring : "";
}

/** Show a code until the owner approves it in the browser; returns the device token. */
static std::string pair(const std::string& base) {
  std::string res;
  for (;;) {
    {
      Lock l;
      shared.pairCode.clear();
    }
    set_mode(Mode::Pairing, "Asking for a pairing code…");
    int status = post_json(base + "/api/device/pair/start",
                           std::string("{\"name\":\"") + "Desk pal" + "\"}", res);
    cJSON* j = status == 200 ? cJSON_Parse(res.c_str()) : nullptr;
    std::string code = j ? json_str(j, "code") : "", poll = j ? json_str(j, "pollToken") : "";
    cJSON_Delete(j);
    if (code.empty() || poll.empty()) {
      set_mode(Mode::Pairing, status < 0 ? "Can't reach the Tidbit server.\nIs it running on the LAN?"
                                         : "The server refused pairing (" + std::to_string(status) + ").");
      vTaskDelay(pdMS_TO_TICKS(5000));
      continue;
    }
    {
      Lock l;
      shared.pairCode = code.substr(0, 3) + " " + code.substr(3);
    }
    set_mode(Mode::Pairing, "In Tidbit, open Your devices\nand enter this code");
    std::string body = "{\"pollToken\":\"" + poll + "\"}";
    for (;;) {
      vTaskDelay(pdMS_TO_TICKS(2000));
      status = post_json(base + "/api/device/pair/poll", body, res);
      if (status == 404) break;  // expired: get a new code
      if (status != 200) continue;
      cJSON* p = cJSON_Parse(res.c_str());
      std::string state = p ? json_str(p, "status") : "", token = p ? json_str(p, "token") : "";
      cJSON_Delete(p);
      if (state == "paired" && !token.empty()) return token;
    }
  }
}

// ---- Stream ---------------------------------------------------------------------

static esp_websocket_client_handle_t ws;
static volatile bool unauthorized;
static std::vector<uint8_t> rx;
static int rx_op;
static std::string client_id, owner_token, http_base;

static void send_text(const std::string& s) {
  if (ws && esp_websocket_client_is_connected(ws))
    esp_websocket_client_send_text(ws, s.data(), s.size(), pdMS_TO_TICKS(100));
}

void net_touch(const char* kind) {
  send_text(std::string("{\"type\":\"touch\",\"kind\":\"") + kind + "\"}");
}

/** What the brain's stream was last told; a new stream starts awake. */
static std::atomic<bool> rest_told{false};

void net_rest(bool on) {
  if (on == rest_told || !ws || !esp_websocket_client_is_connected(ws)) return;
  rest_told = on;
  send_text(on ? "{\"type\":\"rest\",\"on\":true}" : "{\"type\":\"rest\",\"on\":false}");
}

void net_attend(bool down, float x, float y) {
  char buf[80];
  if (down) snprintf(buf, sizeof buf, "{\"type\":\"attend\",\"x\":%.2f,\"y\":%.2f}", x, y);
  else snprintf(buf, sizeof buf, "{\"type\":\"attend\",\"x\":null}");
  send_text(buf);
}

// ---- Voice ----------------------------------------------------------------------

static esp_http_client_handle_t open_post(const char* path, const char* type, int len, int timeout_ms) {
  std::string url = http_base + path;
  esp_http_client_config_t cfg = {};
  cfg.url = url.c_str();
  cfg.method = HTTP_METHOD_POST;
  cfg.timeout_ms = timeout_ms;
  cfg.buffer_size = 2048;
  esp_http_client_handle_t h = esp_http_client_init(&cfg);
  esp_http_client_set_header(h, "Content-Type", type);
  esp_http_client_set_header(h, "Authorization", ("Bearer " + owner_token).c_str());
  if (esp_http_client_open(h, len) != ESP_OK) {
    esp_http_client_cleanup(h);
    return nullptr;
  }
  return h;
}

int net_ask(const uint8_t* wav, size_t len, std::string& text, std::string& error) {
  text.clear();
  error.clear();
  if (http_base.empty() || owner_token.empty()) return -1;
  esp_http_client_handle_t h = open_post("/api/device/ask", "audio/wav", len, 90000);
  if (!h) return -1;
  for (size_t o = 0; o < len;) {
    int n = esp_http_client_write(h, (const char*)wav + o, std::min(len - o, (size_t)8192));
    if (n <= 0) {
      esp_http_client_cleanup(h);
      return -1;
    }
    o += n;
  }
  int status = -1;
  std::string body;
  if (esp_http_client_fetch_headers(h) >= 0) {
    status = esp_http_client_get_status_code(h);
    char buf[512];
    int n;
    while ((n = esp_http_client_read(h, buf, sizeof buf)) > 0 && body.size() < 32768) body.append(buf, n);
  }
  esp_http_client_cleanup(h);
  cJSON* j = cJSON_Parse(body.c_str());
  if (j) {
    text = json_str(j, "text");
    error = json_str(j, "error");
    cJSON_Delete(j);
  }
  return status;
}

bool net_speak(const std::string& text, void (*sink)(const uint8_t*, size_t)) {
  if (http_base.empty() || owner_token.empty()) return false;
  cJSON* o = cJSON_CreateObject();
  cJSON_AddStringToObject(o, "text", text.c_str());
  char* json = cJSON_PrintUnformatted(o);
  std::string body = json;
  cJSON_free(json);
  cJSON_Delete(o);
  esp_http_client_handle_t h = open_post("/api/device/speak", "application/json", body.size(), 60000);
  if (!h) return false;
  bool ok = esp_http_client_write(h, body.data(), body.size()) == (int)body.size() &&
            esp_http_client_fetch_headers(h) >= 0 && esp_http_client_get_status_code(h) == 200;
  if (ok) {
    static uint8_t buf[4096];
    int n;
    while ((n = esp_http_client_read(h, (char*)buf, sizeof buf)) > 0) sink(buf, n);
  } else {
    ESP_LOGW(TAG, "speak failed (%d)", esp_http_client_get_status_code(h));
  }
  esp_http_client_cleanup(h);
  return ok;
}

static void on_text(const char* data, int len) {
  cJSON* j = cJSON_ParseWithLength(data, len);
  if (!j) return;
  std::string type = json_str(j, "type");
  if (type == "stream") {
    cJSON* pal = cJSON_GetObjectItem(j, "palette");
    Lock l;
    for (int i = 0; i < 8 && i < cJSON_GetArraySize(pal); i++) {
      cJSON* c = cJSON_GetArrayItem(pal, i);
      for (int ch = 0; ch < 3; ch++) shared.palette[i][ch] = (uint8_t)cJSON_GetArrayItem(c, ch)->valueint;
    }
    shared.paletteVersion++;
    shared.online = true;
    if (shared.mode != Mode::Updating) {
      shared.mode = Mode::Pet;
      shared.status.clear();
    }
  } else if (type == "caption") {
    Lock l;
    shared.caption = json_str(j, "text");
    shared.captionCharMs = cJSON_GetObjectItem(j, "charMs") ? cJSON_GetObjectItem(j, "charMs")->valueint : 0;
    shared.captionStartUs = esp_timer_get_time();
  } else if (type == "thinking") {
    Lock l;
    shared.thinking = cJSON_IsTrue(cJSON_GetObjectItem(j, "on"));
  } else if (type == "error") {
    std::string code = json_str(j, "code");
    ESP_LOGW(TAG, "brain error %s: %s", code.c_str(), json_str(j, "message").c_str());
    if (code == "unauthorized") unauthorized = true;
  }
  cJSON_Delete(j);
}

static void on_frame(const uint8_t* data, int len) {
  if (len > FRAME_MAX) return;
  Lock l;
  memcpy(shared.frame, data, len);
  shared.frameLen = len;
  shared.frameVersion++;
}

static void on_ws(void*, esp_event_base_t, int32_t id, void* event) {
  auto* d = (esp_websocket_event_data_t*)event;
  switch (id) {
    case WEBSOCKET_EVENT_CONNECTED: {
      rest_told = false;
      ESP_LOGI(TAG, "stream open");
      const Board& b = board();
      std::string hello = "{\"type\":\"hello\",\"clientId\":\"" + client_id +
                          "\",\"ownerToken\":\"" + owner_token + "\",\"caps\":{\"w\":" +
                          std::to_string(b.screen.w) + ",\"h\":" + std::to_string(b.screen.h) +
                          ",\"colors\":65536,\"input\":[\"touch\",\"button\",\"imu\"],\"stream\":\"rig\",\"fps\":" +
                          std::to_string(CONFIG_PAL_FPS) + "}}";
      esp_websocket_client_send_text(ws, hello.data(), hello.size(), pdMS_TO_TICKS(1000));
      break;
    }
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED: {
      Lock l;
      shared.online = false;
      if (shared.mode == Mode::Pet) shared.status = "Reconnecting…";
      break;
    }
    case WEBSOCKET_EVENT_DATA: {
      if (d->op_code == 0x08 && d->data_len >= 2) {
        int code = (uint8_t)d->data_ptr[0] << 8 | (uint8_t)d->data_ptr[1];
        if (code == 4003) unauthorized = true;
        break;
      }
      if (d->op_code != 0x01 && d->op_code != 0x02 && d->op_code != 0x00) break;
      // Messages larger than the client's buffer arrive in pieces.
      if (d->payload_offset == 0) {
        rx.clear();
        rx_op = d->op_code;
      }
      if (rx.size() + d->data_len > FRAME_MAX) break;
      rx.insert(rx.end(), (const uint8_t*)d->data_ptr, (const uint8_t*)d->data_ptr + d->data_len);
      if (d->payload_offset + d->data_len < d->payload_len) break;
      if (rx_op == 0x01) on_text((const char*)rx.data(), rx.size());
      else if (rx_op == 0x02) on_frame(rx.data(), rx.size());
      rx.clear();
      break;
    }
    default:
      break;
  }
}

void net_run(Config cfg) {
  {
    Lock l;
    shared.frame = (uint8_t*)heap_caps_malloc(FRAME_MAX, MALLOC_CAP_SPIRAM);
  }
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char id[32];
  snprintf(id, sizeof id, "esp32-%02x%02x%02x", mac[3], mac[4], mac[5]);
  client_id = id;

  wifi_start(cfg);
  wait_for_wifi(cfg);
  ota_start();
  std::string host = server_host(cfg.server);
  std::string base = "http://" + host;
  http_base = base;

  for (;;) {
    if (cfg.token.empty()) {
      cfg.token = pair(base);
      config_save(cfg);
    }
    owner_token = cfg.token;
    unauthorized = false;
    set_mode(Mode::Linking, "Finding your pal…");
    std::string uri = "ws://" + host + "/ws";
    esp_websocket_client_config_t wc = {};
    wc.uri = uri.c_str();
    wc.buffer_size = 4096;
    wc.task_stack = 8192;
    wc.reconnect_timeout_ms = 3000;
    wc.network_timeout_ms = 10000;
    ws = esp_websocket_client_init(&wc);
    esp_websocket_register_events(ws, WEBSOCKET_EVENT_ANY, on_ws, nullptr);
    esp_websocket_client_start(ws);
    while (!unauthorized) vTaskDelay(pdMS_TO_TICKS(500));
    // The owner removed this device: forget the token and pair again.
    ESP_LOGW(TAG, "token refused; pairing again");
    esp_websocket_client_stop(ws);
    esp_websocket_client_destroy(ws);
    ws = nullptr;
    {
      Lock l;
      shared.online = false;
    }
    cfg.token.clear();
    config_save(cfg);
  }
}
