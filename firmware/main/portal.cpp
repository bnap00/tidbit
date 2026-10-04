#include "portal.h"

#include <esp_http_server.h>
#include <esp_log.h>
#include <esp_mac.h>
#include <esp_netif.h>
#include <esp_system.h>
#include <esp_wifi.h>
#include <lwip/sockets.h>
#include <string.h>
#include <string>

#include "app.h"

static const char* TAG = "portal";
static Config current;
static std::string networks;  // <option> list from a scan

static std::string html_escape(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '<') o += "&lt;";
    else if (c == '>') o += "&gt;";
    else if (c == '&') o += "&amp;";
    else if (c == '"') o += "&quot;";
    else o += c;
  }
  return o;
}

static std::string url_decode(const std::string& s) {
  std::string o;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '+') o += ' ';
    else if (s[i] == '%' && i + 2 < s.size()) {
      o += (char)strtol(s.substr(i + 1, 2).c_str(), nullptr, 16);
      i += 2;
    } else o += s[i];
  }
  return o;
}

static std::string form_field(const std::string& body, const char* name) {
  std::string key = std::string(name) + "=";
  size_t at = 0;
  while ((at = body.find(key, at)) != std::string::npos) {
    if (at == 0 || body[at - 1] == '&') {
      size_t end = body.find('&', at);
      return url_decode(body.substr(at + key.size(), end == std::string::npos ? end : end - at - key.size()));
    }
    at += key.size();
  }
  return "";
}

static esp_err_t page(httpd_req_t* req) {
  std::string html =
      "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>Tidbit setup</title><style>body{font:17px system-ui;margin:24px auto;max-width:420px;"
      "padding:0 16px;background:#14141c;color:#eee}input,select,button{font:inherit;width:100%;"
      "box-sizing:border-box;padding:10px;margin:6px 0 16px;border-radius:10px;border:1px solid #555;"
      "background:#22222c;color:#eee}button{background:#7c6cf0;border:0;font-weight:600}"
      "small{color:#aaa}</style><h2>Set up your pal</h2><form method=post action=/save>"
      "<label>Wi-Fi network<input name=ssid list=nets required value=\"" +
      html_escape(current.ssid) + "\"></label><datalist id=nets>" + networks +
      "</datalist><label>Wi-Fi password<input name=pass type=password value=\"" +
      html_escape(current.password) +
      "\"></label><label>Tidbit server<input name=server required placeholder='192.168.1.20:5174' "
      "value=\"" +
      html_escape(current.server) +
      "\"></label><small>The computer running <code>pnpm dev</code>, on the same network, with "
      "PAL_WEB_HOST=0.0.0.0. The pal can't use Tailscale addresses.</small><p>"
      "<button>Save and restart</button></form>";
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, html.data(), html.size());
}

static esp_err_t save(httpd_req_t* req) {
  std::string body(std::min<size_t>(req->content_len, 1024), '\0');
  int got = 0;
  while (got < (int)body.size()) {
    int n = httpd_req_recv(req, body.data() + got, body.size() - got);
    if (n <= 0) return ESP_FAIL;
    got += n;
  }
  Config c;
  c.ssid = form_field(body, "ssid");
  c.password = form_field(body, "pass");
  c.server = form_field(body, "server");
  // A different server means a different owner: pair again.
  c.token = c.server == current.server ? current.token : "";
  if (c.ssid.empty() || c.server.empty()) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing fields");
  config_save(c);
  const char* done =
      "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<body style='font:17px system-ui;background:#14141c;color:#eee;padding:24px'>"
      "<h2>Saved</h2>Your pal is restarting and will join your Wi-Fi.";
  httpd_resp_send(req, done, strlen(done));
  set_mode(Mode::Setup, "Saved. Restarting…");
  vTaskDelay(pdMS_TO_TICKS(1500));
  esp_restart();
}

/** Phones probe a known URL to find captive portals; send them to the form. */
static esp_err_t redirect(httpd_req_t* req, httpd_err_code_t) {
  httpd_resp_set_status(req, "302 Found");
  httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
  return httpd_resp_send(req, nullptr, 0);
}

/** Answer every DNS question with our own address. */
static void dns_task(void*) {
  int sock = socket(AF_INET, SOCK_DGRAM, 0);
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(53);
  bind(sock, (sockaddr*)&addr, sizeof addr);
  uint8_t buf[512];
  for (;;) {
    sockaddr_in from;
    socklen_t flen = sizeof from;
    int n = recvfrom(sock, buf, sizeof buf - 16, 0, (sockaddr*)&from, &flen);
    if (n < 12) continue;
    buf[2] = 0x81;  // response, recursion desired
    buf[3] = 0x80;  // recursion available
    buf[6] = 0, buf[7] = 1;  // one answer
    buf[8] = buf[9] = buf[10] = buf[11] = 0;
    const uint8_t answer[] = {0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 168, 4, 1};
    memcpy(buf + n, answer, sizeof answer);
    sendto(sock, buf, n + sizeof answer, 0, (sockaddr*)&from, flen);
  }
}

void portal_run(const Config& cfg) {
  current = cfg;
  esp_netif_create_default_wifi_ap();
  esp_netif_create_default_wifi_sta();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  char ssid[32];
  snprintf(ssid, sizeof ssid, "tidbit-%02X%02X", mac[4], mac[5]);
  wifi_config_t ap = {};
  strlcpy((char*)ap.ap.ssid, ssid, sizeof ap.ap.ssid);
  ap.ap.ssid_len = strlen(ssid);
  ap.ap.channel = 1;
  ap.ap.max_connection = 4;
  ap.ap.authmode = WIFI_AUTH_OPEN;
  ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
  ESP_ERROR_CHECK(esp_wifi_start());

  // Offer the networks in range as suggestions.
  wifi_scan_config_t scan = {};
  if (esp_wifi_scan_start(&scan, true) == ESP_OK) {
    uint16_t n = 20;
    wifi_ap_record_t recs[20];
    esp_wifi_scan_get_ap_records(&n, recs);
    for (int i = 0; i < n; i++)
      if (recs[i].ssid[0]) networks += "<option value=\"" + html_escape((char*)recs[i].ssid) + "\">";
  }

  {
    Lock l;
    shared.setupSsid = ssid;
  }
  set_mode(Mode::Setup, "");
  ESP_LOGI(TAG, "setup network %s", ssid);

  httpd_handle_t server = nullptr;
  httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
  hc.stack_size = 8192;
  ESP_ERROR_CHECK(httpd_start(&server, &hc));
  httpd_uri_t get = {.uri = "/", .method = HTTP_GET, .handler = page, .user_ctx = nullptr};
  httpd_uri_t post = {.uri = "/save", .method = HTTP_POST, .handler = save, .user_ctx = nullptr};
  httpd_register_uri_handler(server, &get);
  httpd_register_uri_handler(server, &post);
  httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, redirect);
  xTaskCreate(dns_task, "dns", 4096, nullptr, 5, nullptr);
  for (;;) vTaskDelay(portMAX_DELAY);
}
