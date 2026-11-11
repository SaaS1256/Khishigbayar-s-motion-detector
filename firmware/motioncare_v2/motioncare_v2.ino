/*
 * =====================================================================
 *  MotionCare — ESP32-C3 SuperMini firmware (нэг файл, нэмэлт сан ХЭРЭГГҮЙ)
 * =====================================================================
 *  Төхөөрөмж : ESP32-C3 SuperMini / ESP32-S3-Zero + MPU9250 + OLED SSD1306 128x64 (I2C)
 *  Холболт   : SDA = GPIO6, SCL = GPIO7  (OLED 0x3C, MPU9250 0x68 )
 *
 *  ХЭРХЭН UPLOAD ХИЙХ ВЭ:
 *   1. Arduino IDE → Boards Manager → "esp32 by Espressif Systems" суулгана.
 *   2. Tools → Board → "ESP32C3 Dev Module"  (ESP32-S3-Zero бол "ESP32S3 Dev Module")
 *      Tools → USB CDC On Boot → "Enabled"   (Serial Monitor-д хэрэгтэй)
 *   3. Доорх "ТОХИРГОО" хэсэгт Wi-Fi нэр, нууц үг, компьютерийн IP-г бичнэ.
 *   4. Upload. Serial Monitor (115200) дээр явцыг харна.
 * =====================================================================
 */

// ============================== ТОХИРГОО ==============================
#define WIFI_SSID      "sknnn"       // Wi-Fi нэр (зөвхөн 2.4 GHz)
#define WIFI_PASSWORD  "negees88"
// Сервер ажиллуулах компьютерүүд: нэр + ".local" (IP солигдсон ч олно). IP бичиж ч болно: "10.37.229.53"
// Windows-ийн нэрийг cmd дээр `hostname` гэж бичиж олно.
// Deploy хийсэн (интернэт) сервер: "https://<таны-app>.vercel.app" гэж бүтэн хаягаар нэмнэ.
#define SERVER_HOSTS   "Gankhulugs-MacBook-Air.local", "WINDOWS-NAME.local", "https://YOUR-APP.vercel.app"
#define SERVER_PORT    3000
#define DEVICE_KEY     "dev-secret-key"       // .env.local доторх DEVICE_API_KEY
#define DEVICE_ID      "esp32S3-01"
#define OLED_ROTATE_180  1                    // 1 = PCB дээр OLED доошоо харсан (180°), 0 = энгийн
#define SERIAL_DATA      1                    // 1 = "DATA,..." мөрийг Serial руу 50 Hz (ML өгөгдөл цуглуулах), 0 = унтраах
// =====================================================================

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ESPmDNS.h>
#define MDNS_NAME "motioncare"

static const int      PIN_SDA       = 6;
static const int      PIN_SCL       = 7;
static const uint32_t SAMPLE_HZ     = 50;    // мэдрэгч унших давтамж — 50 Hz-ийг ЗӨВХӨН энд тогтооно
static const uint32_t SEND_EVERY_MS = 100;
static const uint32_t SEND_EVERY_CLOUD_MS = 500;   // интернэт (https) сервер байвал — Vercel/Redis-ийн хязгаар хэмнэнэ
static const uint16_t WS_PORT       = 81;
static const uint16_t MAX_PER_POST  = 50;
static const uint16_t RING_SIZE     = 256;   // сүлжээ тасарсан үеийн буфер (~5 сек)
static const uint8_t  MPU_ADDR      = 0x68;
static const uint8_t  OLED_ADDR     = 0x3C;

static const int WS_MAX = 3;
struct WsClient { WiFiClient c; bool open; uint32_t since; String req; };

// Хэмжилтийн бүтэц — функцүүдээс ӨМНӨ тодорхойлох ёстой (Arduino prototype дүрэм)
struct Sample {
  uint32_t t;          // millis()
  float ax, ay, az;    // g
  float gx, gy, gz;    // °/s
};

// Функцийн урьдчилсан зарлалт (Arduino IDE-ийн автомат prototype-оос хамааралгүй болгоно)
static bool i2cWrite(uint8_t addr, uint8_t reg, uint8_t val);
static bool i2cRead(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t len);
static void fbClear();
static void fbPixel(int x, int y, bool on);
static void fbFill(int x, int y, int w, int h, bool on);
static uint32_t utf8Next(const uint8_t*& p);
static const uint16_t* glyphFor(uint32_t cp);
static int fbText(int x, int y, const char* s, int scale = 1, bool on = true);
static void oledCmd(uint8_t c);
static bool oledInit();
static void oledFlush();
static bool mpuInit();
static bool mpuRead(Sample& s);
static void sensorTask(void*);
static uint16_t takeSamples(Sample* out, uint16_t maxN);
static void putBack(const Sample* in, uint16_t n);
static void drawScreen();
static void parseResponse(const String& r);
static void ensureWifi();
static void hostCopy(char* dst, size_t cap, const char* src, size_t n);
static bool isHttps(int k);
static bool placeholder(int k);
static bool resolveServer(int k);
static bool postTo(int k, const String& body);
static void sendBatch();
static void netTask(void*);
static void sha1digest(const uint8_t* msg, size_t len, uint8_t out[20]);
static String b64enc(const uint8_t* d, size_t n);
static void wsSendText(WsClient& k, const char* p, size_t n);
static void wsService();
static void serialService();

SemaphoreHandle_t i2cMutex;

static bool i2cWrite(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool i2cRead(uint8_t addr, uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

// SSD1306 128x64 драйвер (нэмэлт сан хэрэггүй). 6x10 пикселийн фонт.
static const uint16_t FONT6x10[95][6] = {
  {0x000,0x000,0x000,0x000,0x000,0x000},
  {0x000,0x0BC,0x0BC,0x000,0x000,0x000},
  {0x000,0x01C,0x000,0x01C,0x000,0x000},
  {0x048,0x1FE,0x048,0x1FE,0x048,0x000},
  {0x0CC,0x0DE,0x19B,0x0FA,0x076,0x000},
  {0x04E,0x02A,0x0FE,0x0A8,0x0E4,0x000},
  {0x0E8,0x0BC,0x0F4,0x0E4,0x0A0,0x000},
  {0x000,0x008,0x006,0x002,0x000,0x000},
  {0x000,0x078,0x0FC,0x102,0x000,0x000},
  {0x000,0x102,0x0FC,0x078,0x000,0x000},
  {0x014,0x00C,0x00E,0x014,0x000,0x000},
  {0x010,0x010,0x07C,0x010,0x010,0x000},
  {0x000,0x200,0x180,0x080,0x000,0x000},
  {0x010,0x010,0x010,0x010,0x010,0x000},
  {0x000,0x080,0x080,0x000,0x000,0x000},
  {0x000,0x180,0x060,0x018,0x006,0x000},
  {0x07C,0x0FE,0x082,0x0FE,0x07C,0x000},
  {0x084,0x084,0x0FE,0x0FE,0x080,0x080},
  {0x0C4,0x0E6,0x0B2,0x0DE,0x0CC,0x000},
  {0x044,0x0D6,0x092,0x0FE,0x06C,0x000},
  {0x030,0x038,0x024,0x0FE,0x0FE,0x020},
  {0x0DE,0x09E,0x08A,0x0FA,0x072,0x000},
  {0x07C,0x0FE,0x092,0x0F6,0x064,0x000},
  {0x006,0x0C6,0x0F2,0x03E,0x00E,0x000},
  {0x06C,0x0FE,0x092,0x0FE,0x06C,0x000},
  {0x04C,0x0DE,0x092,0x0FE,0x07C,0x000},
  {0x000,0x090,0x090,0x000,0x000,0x000},
  {0x200,0x190,0x090,0x000,0x000,0x000},
  {0x010,0x038,0x06C,0x044,0x000,0x000},
  {0x028,0x028,0x028,0x028,0x000,0x000},
  {0x000,0x044,0x06C,0x038,0x010,0x000},
  {0x008,0x0A4,0x0B4,0x01C,0x008,0x000},
  {0x0FC,0x186,0x132,0x14A,0x07C,0x040},
  {0x0E4,0x0FC,0x02C,0x0FC,0x0E0,0x080},
  {0x0FC,0x0FC,0x094,0x0FC,0x068,0x000},
  {0x078,0x0FC,0x084,0x0CC,0x04C,0x000},
  {0x0FC,0x0FC,0x084,0x0FC,0x078,0x000},
  {0x0FC,0x0FC,0x094,0x0D4,0x0C4,0x000},
  {0x0FC,0x0FC,0x094,0x014,0x004,0x000},
  {0x078,0x0FC,0x0A4,0x0EC,0x0E8,0x000},
  {0x0FC,0x0FC,0x010,0x0FC,0x0FC,0x084},
  {0x084,0x0FC,0x0FC,0x084,0x000,0x000},
  {0x0E0,0x084,0x0FC,0x07C,0x004,0x000},
  {0x0FC,0x0FC,0x0B0,0x06C,0x0C4,0x080},
  {0x0FC,0x0FC,0x084,0x0C0,0x0C0,0x000},
  {0x0FC,0x038,0x0E0,0x038,0x0FC,0x000},
  {0x0FC,0x0FC,0x018,0x064,0x0FC,0x004},
  {0x078,0x0FC,0x084,0x0FC,0x078,0x000},
  {0x0FC,0x0FC,0x0A4,0x03C,0x018,0x000},
  {0x078,0x0FC,0x084,0x1FC,0x178,0x000},
  {0x0FC,0x0FC,0x0A4,0x07C,0x0D8,0x080},
  {0x0D8,0x09C,0x0B4,0x0F4,0x06C,0x000},
  {0x084,0x0FC,0x0FC,0x084,0x00C,0x000},
  {0x07C,0x0FC,0x080,0x0FC,0x07C,0x004},
  {0x00C,0x07C,0x0E0,0x07C,0x00C,0x004},
  {0x03C,0x0E0,0x07C,0x0E0,0x03C,0x004},
  {0x084,0x0CC,0x078,0x078,0x0CC,0x084},
  {0x00C,0x09C,0x0F0,0x0F0,0x09C,0x00C},
  {0x0CC,0x0EC,0x0B4,0x0DC,0x0CC,0x000},
  {0x000,0x1FE,0x1FE,0x102,0x000,0x000},
  {0x006,0x018,0x060,0x180,0x000,0x000},
  {0x000,0x102,0x1FE,0x1FE,0x000,0x000},
  {0x008,0x00C,0x006,0x00C,0x008,0x000},
  {0x200,0x200,0x200,0x200,0x200,0x200},
  {0x000,0x002,0x006,0x008,0x000,0x000},
  {0x0D0,0x0F8,0x0A8,0x0F8,0x0F0,0x080},
  {0x0FE,0x0FE,0x088,0x0F8,0x070,0x000},
  {0x070,0x0F8,0x088,0x0D8,0x050,0x000},
  {0x070,0x0F8,0x08A,0x0FE,0x0FE,0x080},
  {0x070,0x0F8,0x0A8,0x0B8,0x0B0,0x000},
  {0x088,0x0FC,0x0FE,0x08A,0x08A,0x000},
  {0x270,0x2F8,0x288,0x3F0,0x1F8,0x008},
  {0x0FE,0x0FE,0x008,0x0F8,0x0F0,0x000},
  {0x088,0x088,0x0FA,0x0FA,0x080,0x080},
  {0x208,0x208,0x3FA,0x1FA,0x000,0x000},
  {0x0FE,0x0FE,0x070,0x0D8,0x088,0x080},
  {0x082,0x082,0x0FE,0x0FE,0x080,0x080},
  {0x0F8,0x018,0x0F8,0x018,0x0F0,0x000},
  {0x0F8,0x0F0,0x008,0x0F8,0x0F0,0x000},
  {0x070,0x0F8,0x088,0x0F8,0x070,0x000},
  {0x3F8,0x3F8,0x288,0x0F8,0x070,0x000},
  {0x070,0x0F8,0x288,0x3F0,0x3F8,0x208},
  {0x088,0x0F8,0x0F0,0x098,0x008,0x018},
  {0x090,0x0B8,0x0B8,0x0E8,0x0E8,0x040},
  {0x008,0x07E,0x0FE,0x088,0x0C8,0x040},
  {0x078,0x0F8,0x080,0x0F8,0x0F8,0x080},
  {0x018,0x078,0x0E0,0x078,0x018,0x000},
  {0x038,0x0E0,0x078,0x0E0,0x078,0x008},
  {0x088,0x0D8,0x078,0x0F0,0x0D8,0x088},
  {0x238,0x3F8,0x180,0x0F8,0x038,0x008},
  {0x0D8,0x0E8,0x0B8,0x0D8,0x0C8,0x000},
  {0x000,0x010,0x0FC,0x1EE,0x102,0x000},
  {0x000,0x000,0x1FC,0x000,0x000,0x000},
  {0x102,0x1EE,0x0FC,0x010,0x000,0x000},
  {0x010,0x008,0x018,0x010,0x008,0x000},
};

// Монгол кирилл: U+0410..U+044F (А..я), дараа нь Ё ё Ө ө Ү ү
static const uint16_t CYR6x10[70][6] = {
  {0x0F8,0x0FC,0x024,0x0FC,0x0F8,0x000},
  {0x0FC,0x0FC,0x094,0x0F4,0x064,0x000},
  {0x0FC,0x0FC,0x094,0x0FC,0x068,0x000},
  {0x0FC,0x0FC,0x084,0x004,0x004,0x000},
  {0x1C0,0x0F8,0x0BC,0x084,0x0FC,0x180},
  {0x0FC,0x0FC,0x094,0x0D4,0x0C4,0x000},
  {0x0CC,0x030,0x0FC,0x0FC,0x030,0x0CC},
  {0x048,0x0CC,0x094,0x0FC,0x068,0x000},
  {0x0FC,0x0FC,0x060,0x018,0x0FC,0x000},
  {0x0FC,0x0FD,0x061,0x019,0x0FC,0x000},
  {0x0FC,0x0FC,0x0B0,0x06C,0x0C4,0x080},
  {0x0C0,0x0F8,0x03C,0x004,0x0FC,0x000},
  {0x0FC,0x038,0x0E0,0x038,0x0FC,0x000},
  {0x0FC,0x0FC,0x010,0x0FC,0x0FC,0x000},
  {0x078,0x0FC,0x084,0x0FC,0x078,0x000},
  {0x0FC,0x0FC,0x004,0x0FC,0x0FC,0x000},
  {0x0FC,0x0FC,0x0A4,0x03C,0x018,0x000},
  {0x078,0x0FC,0x084,0x0CC,0x04C,0x000},
  {0x00C,0x084,0x0FC,0x0FC,0x084,0x00C},
  {0x09C,0x0BC,0x0A0,0x0FC,0x07C,0x000},
  {0x078,0x048,0x0FC,0x0FC,0x048,0x078},
  {0x084,0x0CC,0x078,0x078,0x0CC,0x084},
  {0x0FC,0x0FC,0x080,0x0FC,0x0FC,0x180},
  {0x01C,0x03C,0x020,0x0FC,0x0FC,0x000},
  {0x0FC,0x080,0x0FC,0x080,0x0FC,0x000},
  {0x0FC,0x080,0x0FC,0x080,0x0FC,0x180},
  {0x004,0x0FC,0x0FC,0x090,0x0F0,0x060},
  {0x0FC,0x0FC,0x090,0x0F0,0x000,0x0FC},
  {0x0FC,0x0FC,0x090,0x0F0,0x060,0x000},
  {0x04C,0x0CC,0x094,0x0FC,0x078,0x000},
  {0x0FC,0x010,0x078,0x084,0x084,0x078},
  {0x0D8,0x0FC,0x024,0x0FC,0x0FC,0x000},
  {0x0D0,0x0F8,0x0A8,0x0F8,0x0F0,0x080},
  {0x078,0x0FC,0x094,0x0F6,0x062,0x000},
  {0x0F8,0x0F8,0x0A8,0x0F8,0x050,0x000},
  {0x0F8,0x0F8,0x088,0x008,0x008,0x000},
  {0x1C0,0x0F0,0x0B8,0x088,0x0F8,0x180},
  {0x070,0x0F8,0x0A8,0x0B8,0x0B0,0x000},
  {0x0D8,0x020,0x0F8,0x0F8,0x020,0x0D8},
  {0x088,0x0A8,0x0A8,0x0F8,0x050,0x000},
  {0x0F8,0x0F8,0x040,0x030,0x0F8,0x000},
  {0x0F8,0x0FA,0x042,0x032,0x0F8,0x000},
  {0x0F8,0x0F8,0x070,0x0D8,0x088,0x080},
  {0x0C0,0x0F0,0x038,0x008,0x0F8,0x000},
  {0x0F8,0x030,0x0E0,0x030,0x0F8,0x000},
  {0x0F8,0x0F8,0x020,0x0F8,0x0F8,0x000},
  {0x070,0x0F8,0x088,0x0F8,0x070,0x000},
  {0x0F8,0x0F8,0x008,0x0F8,0x0F8,0x000},
  {0x3F8,0x3F8,0x288,0x0F8,0x070,0x000},
  {0x070,0x0F8,0x088,0x0D8,0x050,0x000},
  {0x018,0x088,0x0F8,0x0F8,0x088,0x018},
  {0x238,0x3F8,0x180,0x0F8,0x038,0x008},
  {0x0F8,0x088,0x1FC,0x1FC,0x088,0x0F8},
  {0x088,0x0D8,0x078,0x0F0,0x0D8,0x088},
  {0x0F8,0x0F8,0x080,0x0F8,0x0F8,0x180},
  {0x018,0x038,0x020,0x0F8,0x0F8,0x000},
  {0x0F8,0x080,0x0F8,0x080,0x0F8,0x000},
  {0x0F8,0x080,0x0F8,0x080,0x0F8,0x180},
  {0x008,0x0F8,0x0F8,0x090,0x0F0,0x060},
  {0x0F8,0x0F8,0x090,0x0F0,0x000,0x0F8},
  {0x0F8,0x0F8,0x090,0x0F0,0x060,0x000},
  {0x088,0x0A8,0x0A8,0x0F8,0x070,0x000},
  {0x0F8,0x020,0x070,0x088,0x088,0x070},
  {0x0D0,0x0F8,0x028,0x0F8,0x0F8,0x000},
  {0x0FC,0x0FD,0x094,0x0D5,0x0C4,0x000},
  {0x070,0x0FA,0x0A8,0x0BA,0x0B0,0x000},
  {0x078,0x0FC,0x094,0x0FC,0x078,0x000},
  {0x070,0x0F8,0x0A8,0x0F8,0x070,0x000},
  {0x00C,0x09C,0x0F0,0x0F0,0x09C,0x00C},
  {0x018,0x038,0x1E0,0x1E0,0x038,0x018},
};

static uint8_t fb[128 * 64 / 8];

static void fbClear() { memset(fb, 0, sizeof(fb)); }

static void fbPixel(int x, int y, bool on) {
  if (x < 0 || x >= 128 || y < 0 || y >= 64) return;
  if (on) fb[x + (y >> 3) * 128] |= (1 << (y & 7));
  else    fb[x + (y >> 3) * 128] &= ~(1 << (y & 7));
}

static void fbFill(int x, int y, int w, int h, bool on) {
  for (int j = y; j < y + h; j++)
    for (int i = x; i < x + w; i++) fbPixel(i, j, on);
}

static uint32_t utf8Next(const uint8_t*& p) {
  uint32_t c = *p++;
  if (c < 0x80) return c;
  int n = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
  if (!n) return '?';
  c &= 0x3F >> n;
  while (n--) {
    if ((*p & 0xC0) != 0x80) return '?';
    c = (c << 6) | (*p++ & 0x3F);
  }
  return c;
}

static const uint16_t* glyphFor(uint32_t cp) {
  if (cp >= 32 && cp <= 126) return FONT6x10[cp - 32];
  if (cp >= 0x410 && cp <= 0x44F) return CYR6x10[cp - 0x410];
  switch (cp) {
    case 0x401: return CYR6x10[64];
    case 0x451: return CYR6x10[65];
    case 0x4E8: return CYR6x10[66];
    case 0x4E9: return CYR6x10[67];
    case 0x4AE: return CYR6x10[68];
    case 0x4AF: return CYR6x10[69];
  }
  return FONT6x10['?' - 32];
}

// UTF-8 текст зурах (латин + монгол кирилл). scale = 1 (6x10) эсвэл 2 (12x20). Буцаах утга: дараагийн x
static int fbText(int x, int y, const char* s, int scale, bool on) {
  const uint8_t* p = (const uint8_t*)s;
  while (*p) {
    const uint16_t* g = glyphFor(utf8Next(p));
    for (int col = 0; col < 6; col++)
      for (int row = 0; row < 10; row++)
        if (g[col] & (1 << row)) fbFill(x + col * scale, y + row * scale, scale, scale, on);
    x += 6 * scale;
  }
  return x;
}

static void oledCmd(uint8_t c) {
  Wire.beginTransmission(OLED_ADDR);
  Wire.write(0x00);
  Wire.write(c);
  Wire.endTransmission();
}

static bool oledInit() {
  Wire.beginTransmission(OLED_ADDR);
  if (Wire.endTransmission() != 0) return false;
  const uint8_t seq[] = {
    0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00,
    (uint8_t)(OLED_ROTATE_180 ? 0xA0 : 0xA1),
    (uint8_t)(OLED_ROTATE_180 ? 0xC0 : 0xC8 ),
    0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0x2E, 0xAF
  };
  for (uint8_t c : seq) oledCmd(c);
  return true;
}

// I2C-г бүтэн 1 КБ (~25 мс) турш эзэлбэл MPU-ийн уншилт хоцорч хэмжилт алдагддаг.
// Иймд 16 байт тутамд mutex-ийг суллана → sensorTask хамгийн ихдээ ~0.5 мс хүлээнэ.
// mutex-ийг энэ функц өөрөө авдаг — дуудахдаа гаднаас нь битгий ав (deadlock болно).
static void oledFlush() {
  if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
  oledCmd(0x21); oledCmd(0); oledCmd(127);
  oledCmd(0x22); oledCmd(0); oledCmd(7);
  xSemaphoreGive(i2cMutex);
  for (size_t i = 0; i < sizeof(fb); i += 16) {
    if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
    Wire.beginTransmission(OLED_ADDR);
    Wire.write(0x40);
    Wire.write(fb + i, 16);
    Wire.endTransmission();
    xSemaphoreGive(i2cMutex);
  }
}

static const float ACCEL_LSB_PER_G  = 8192.0f;  // ±4 g
static const float GYRO_LSB_PER_DPS = 65.5f;    // ±500 °/s

static bool mpuInit() {
  uint8_t who = 0;
  if (!i2cRead(MPU_ADDR, 0x75, &who, 1)) {
    Serial.println("[MPU] I2C хариу алга — SDA=6, SCL=7 холболтоо шалга");
    return false;
  }
  // 0x71 = MPU9250, 0x73 = MPU9255, 0x70 = MPU6500, 0x68 = MPU6050
  Serial.printf("[MPU] WHO_AM_I = 0x%02X\n", who);
  i2cWrite(MPU_ADDR, 0x6B, 0x80);   // reset
  delay(100);
  i2cWrite(MPU_ADDR, 0x6B, 0x01);   // PLL цаг
  i2cWrite(MPU_ADDR, 0x6C, 0x00);   // бүх тэнхлэг идэвхтэй
  delay(10);
  i2cWrite(MPU_ADDR, 0x1A, 0x03);   // gyro шүүлтүүр 41 Hz
  // SMPLRT_DIV = 0 → MPU дотроо 1 kHz-ээр хэмжинэ. 50 Hz-ийг sensorTask (SAMPLE_HZ) тогтооно.
  i2cWrite(MPU_ADDR, 0x19, 0);
  i2cWrite(MPU_ADDR, 0x1B, 0x08 );   // gyro ±500 °/s
  i2cWrite(MPU_ADDR, 0x1C, 0x08 );   // accel ±4 g
  i2cWrite(MPU_ADDR, 0x1D, 0x03);   // accel шүүлтүүр 41 Hz
  return true;
}

static bool mpuRead(Sample& s) {
  uint8_t b[14];
  if (!i2cRead(MPU_ADDR, 0x3B, b, 14)) return false;
  s.ax = (int16_t)(b[0] << 8 | b[1]) / ACCEL_LSB_PER_G;
  s.ay = (int16_t)(b[2] << 8 | b[3]) / ACCEL_LSB_PER_G;
  s.az = (int16_t)(b[4] << 8 | b[5]) / ACCEL_LSB_PER_G;
  s.gx = (int16_t)(b[8] << 8 | b[9]) / GYRO_LSB_PER_DPS;
  s.gy = (int16_t)(b[10] << 8 | b[11]) / GYRO_LSB_PER_DPS;
  s.gz = (int16_t)(b[12] << 8 | b[13]) / GYRO_LSB_PER_DPS;
  return true;
}

static Sample ring[RING_SIZE];
static volatile uint16_t ringHead = 0, ringCount = 0;
static volatile uint32_t droppedSamples = 0;
static portMUX_TYPE ringMux = portMUX_INITIALIZER_UNLOCKED;
static bool mpuOk = false, oledOk = false;
static Sample latest = {};
static volatile uint32_t sampleCounter = 0;
static const uint16_t WS_RING = 64;
static Sample wsRing[WS_RING];
static volatile uint16_t wsHead = 0, wsCount = 0;
// Serial (CSV цуглуулалт) руу илгээх тусдаа буфер (~2.5 сек)
static const uint16_t SER_RING = 128;
static Sample serRing[SER_RING];
static volatile uint16_t serHead = 0, serCount = 0;
static volatile uint32_t serDropped = 0;

// 50 Hz-ээр тогтмол уншиж буферт хийнэ (тусдаа task). Энд Serial руу ЮУ Ч бичихгүй —
// Serial гацвал (компьютер уншихгүй үед) энэ task хоцорч 50 Hz алдагдана.
static void sensorTask(void*) {
  TickType_t last = xTaskGetTickCount();
  const TickType_t period = pdMS_TO_TICKS(1000 / SAMPLE_HZ);
  while (true) {
    vTaskDelayUntil(&last, period);
    // Нэг циклээс илүү хоцорсон бол алдсан циклүүдийг дараалан нөхөж уншихгүй:
    // vTaskDelayUntil тэгвэл хүлээлтгүй дахин дахин буцаж, ижил утгыг 1 мс зайтай олон удаа өгдөг.
    TickType_t nowTick = xTaskGetTickCount();
    if ((TickType_t)(nowTick - last) >= period) last = nowTick;
    if (!mpuOk) continue;
    Sample s;
    s.t = millis();
    bool ok = false;
    if (xSemaphoreTake(i2cMutex, pdMS_TO_TICKS(40)) == pdTRUE) {
      ok = mpuRead(s);
      xSemaphoreGive(i2cMutex);
    }
    if (!ok) continue;
    portENTER_CRITICAL(&ringMux);
    latest = s;
    sampleCounter++;
    wsRing[wsHead] = s;
    wsHead = (wsHead + 1) % WS_RING;
    if (wsCount < WS_RING) wsCount++;
    ring[ringHead] = s;
    ringHead = (ringHead + 1) % RING_SIZE;
    if (ringCount < RING_SIZE) ringCount++;
    else droppedSamples++;
    if (SERIAL_DATA) {
      serRing[serHead] = s;
      serHead = (serHead + 1) % SER_RING;
      if (serCount < SER_RING) serCount++;
      else serDropped++;
    }
    portEXIT_CRITICAL(&ringMux);
  }
}

// USB буфер дүүрсэн (компьютер уншихгүй) үед хүлээхгүй, дараагийн удаа дахин оролдоно.
// Тоонуудын нарийвчлал /api/ingest-ийнхтэй ижил → сургалт ба inference ижил өгөгдөл харна.
static void serialService() {
  if (!SERIAL_DATA) return;
  char line[100];
  for (int guard = 0; guard < SER_RING; guard++) {
    Sample s;
    portENTER_CRITICAL(&ringMux);
    bool have = serCount > 0;
    if (have) s = serRing[(serHead + SER_RING - serCount) % SER_RING];
    portEXIT_CRITICAL(&ringMux);
    if (!have) return;
    int n = snprintf(line, sizeof(line), "DATA,%lu,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f\n",
                     (unsigned long)s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
    if (n <= 0 || Serial.availableForWrite() < n) return;
    Serial.write((const uint8_t*)line, n);
    portENTER_CRITICAL(&ringMux);
    if (serCount > 0) serCount--;
    portEXIT_CRITICAL(&ringMux);
  }
}

static uint16_t takeSamples(Sample* out, uint16_t maxN) {
  portENTER_CRITICAL(&ringMux);
  uint16_t n = ringCount < maxN ? ringCount : maxN;
  uint16_t tail = (ringHead + RING_SIZE - ringCount) % RING_SIZE;
  for (uint16_t i = 0; i < n; i++) out[i] = ring[(tail + i) % RING_SIZE];
  ringCount -= n;
  portEXIT_CRITICAL(&ringMux);
  return n;
}

static void putBack(const Sample* in, uint16_t n) {
  portENTER_CRITICAL(&ringMux);
  uint16_t space = RING_SIZE - ringCount;
  uint16_t k = n < space ? n : space;
  uint16_t tail = (ringHead + RING_SIZE - ringCount) % RING_SIZE;
  for (uint16_t i = 0; i < k; i++) {
    tail = (tail + RING_SIZE - 1) % RING_SIZE;
    ring[tail] = in[n - 1 - i];
  }
  ringCount += k;
  portEXIT_CRITICAL(&ringMux);
}

static char     lastLabel[32] = "---";
static int      lastConfidence = 0;
static bool     lastAlert = false;
static uint32_t lastOkResponse = 0;
static uint32_t postFailures = 0;
static portMUX_TYPE labelMux = portMUX_INITIALIZER_UNLOCKED;

static void drawScreen() {
  if (!oledOk) return;
  static uint32_t lastCount = 0, lastT = 0;
  static int hz = 0;
  char line[32];

  Sample s;
  portENTER_CRITICAL(&ringMux);
  s = latest;
  uint32_t cnt = sampleCounter;
  portEXIT_CRITICAL(&ringMux);
  uint32_t now = millis();
  if (now - lastT >= 1000) {
    hz = (int)((cnt - lastCount) * 1000UL / (now - lastT));
    lastCount = cnt; lastT = now;
  }

  fbClear();
  if (lastAlert) {
    fbFill(0, 0, 128, 64, true);
    fbText(22, 10, "АНХААР!", 2, false);
    fbText(25, 38, "УНАЛТ ИЛЭРЛЭЭ", 1, false);
    oledFlush();                         // mutex-ийг oledFlush өөрөө хэсэгчлэн авна
    return;
  }

  bool live = WiFi.status() == WL_CONNECTED && millis() - lastOkResponse < 3000;
  portENTER_CRITICAL(&labelMux);
  snprintf(line, sizeof(line), "%s %d%%", lastLabel, lastConfidence);
  portEXIT_CRITICAL(&labelMux);
  fbText(0, 0, live ? line : (WiFi.status() == WL_CONNECTED ? "сервер --" : "WiFi..."));
  fbText(live ? 104 : 92, 0, live ? "ШУУД" : "САЛСАН");
  fbFill(0, 11, 128, 1, true);

  if (!mpuOk) {
    fbText(0, 20, "MPU9250 алдаа");
    fbText(0, 34, "Шалга: SDA=6 SCL=7");
  } else {
    snprintf(line, sizeof(line), "Ax%+5.2f Gx%+6.1f", s.ax, s.gx); fbText(0, 14, line);
    snprintf(line, sizeof(line), "Ay%+5.2f Gy%+6.1f", s.ay, s.gy); fbText(0, 26, line);
    snprintf(line, sizeof(line), "Az%+5.2f Gz%+6.1f", s.az, s.gz); fbText(0, 38, line);
    float mag = sqrtf(s.ax * s.ax + s.ay * s.ay + s.az * s.az);
    snprintf(line, sizeof(line), "|a| %.2fg   %dГц", mag, hz);     fbText(0, 52, line);
  }
  oledFlush();                           // mutex-ийг oledFlush өөрөө хэсэгчлэн авна
}

// Хариу: {"ok":true,"activity":"walking","label":"Алхах","confidence":0.94,"alert":false}
static void parseResponse(const String& r) {
  char label[32] = "";
  int conf = -1;
  int i = r.indexOf("\"label\":" "\"");
  if (i >= 0) {
    i += 9;
    int j = r.indexOf('"', i);
    if (j > i) r.substring(i, j).toCharArray(label, sizeof(label));
  }
  i = r.indexOf("\"confidence\":");
  if (i >= 0) conf = (int)lroundf(r.substring(i + 13).toFloat() * 100.0f);
  bool alert = r.indexOf("\"alert\":true") >= 0;
  portENTER_CRITICAL(&labelMux);
  if (label[0]) memcpy(lastLabel, label, sizeof(lastLabel));
  if (conf >= 0) lastConfidence = conf;
  lastAlert = alert;
  portEXIT_CRITICAL(&labelMux);
}

static void ensureWifi() {
  static uint32_t lastTry = 0;
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastTry < 5000) return;
  lastTry = millis();
  Serial.println("[WiFi] холбогдож байна...");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// SERVER_HOSTS дахь хаяг бүр IP, ".local" (mDNS нэр) эсвэл DNS нэр байж болно.
// Асаалттай байгаа БҮХ сервер рүү ижил өгөгдлийг илгээнэ. Унтарсан серверийг 20 сек тутам л шалгана,
// тиймээс нэг компьютер унтраастай байсан ч нөгөө нь саатахгүй.
static const char* const SERVER_LIST[] = { SERVER_HOSTS };
static const int SERVER_N = sizeof(SERVER_LIST) / sizeof(SERVER_LIST[0]);
static const uint32_t RETRY_OFFLINE_MS = 20000;
struct SrvSlot {
  char ip[48];          // олдсон IP ("" = олдоогүй)
  uint8_t fails;
  uint32_t nextTry;
  WiFiClient tcp;
  WiFiClientSecure tls;
  HTTPClient http;
};
static SrvSlot servers[SERVER_N];

static void hostCopy(char* dst, size_t cap, const char* src, size_t n) {
  if (n >= cap) n = cap - 1;
  memcpy(dst, src, n);
  dst[n] = 0;
}

static bool isHttps(int k) { return strncmp(SERVER_LIST[k], "https://", 8 ) == 0; }
static bool placeholder(int k) { return strstr(SERVER_LIST[k], "YOUR-APP") || strstr(SERVER_LIST[k], "WINDOWS-NAME"); }

static bool resolveServer(int k) {
  const char* host = SERVER_LIST[k];
  SrvSlot& sv = servers[k];
  IPAddress ip;
  if (ip.fromString(host)) {
    hostCopy(sv.ip, sizeof(sv.ip), host, strlen(host));
    return true;
  }
  size_t len = strlen(host);
  if (len > 6 && strcasecmp(host + len - 6, ".local") == 0) {
    static bool mdnsOk = false;
    if (!mdnsOk) mdnsOk = MDNS.begin(MDNS_NAME);
    char name[64];
    hostCopy(name, sizeof(name), host, len - 6);
    ip = MDNS.queryHost(name, 1000);
  } else if (!WiFi.hostByName(host, ip)) {
    ip = IPAddress(0, 0, 0, 0);
  }
  String txt = ip.toString();
  if (txt == "0.0.0.0" || txt.length() == 0) {
    Serial.printf("[mDNS] %s олдсонгүй (компьютер унтраастай эсвэл өөр Wi-Fi-д байна)\n", host);
    return false;
  }
  hostCopy(sv.ip, sizeof(sv.ip), txt.c_str(), txt.length());
  Serial.printf("[mDNS] %s -> %s\n", host, sv.ip);
  return true;
}

static bool postTo(int k, const String& body) {
  SrvSlot& sv = servers[k];
  uint32_t now = millis();
  if (placeholder(k)) return false;
  if (sv.nextTry && (int32_t)(now - sv.nextTry) < 0) return false;

  String url;
  if (isHttps(k)) {
    // Интернэт сервер (Vercel): нэрээр нь (SNI) TLS-ээр холбогдоно. Гэрчилгээ шалгахгүй (setInsecure).
    url = SERVER_LIST[k];
    while (url.endsWith("/")) url.remove(url.length() - 1);
    url += "/api/ingest";
    static bool tlsInit[8] = {};
    if (k < 8 && !tlsInit[k]) { sv.tls.setInsecure(); tlsInit[k] = true; }
    sv.http.begin(sv.tls, url);
    sv.http.setConnectTimeout(5000);
    sv.http.setTimeout(5000);
  } else {
    if (!sv.ip[0] && !resolveServer(k)) { sv.nextTry = millis() + RETRY_OFFLINE_MS; return false; }
    url = String("http://") + sv.ip + ":" + String(SERVER_PORT) + "/api/ingest";
    sv.http.begin(sv.tcp, url);
    sv.http.setConnectTimeout(600);
    sv.http.setTimeout(1500);
  }
  sv.http.setReuse(true);
  sv.http.addHeader("Content-Type", "application/json");
  sv.http.addHeader("x-device-key", DEVICE_KEY);
  int code = sv.http.POST(body);
  bool ok = code == 200;
  if (ok) {
    if (sv.fails || sv.nextTry) Serial.printf("[HTTP] %s (%s) холбогдлоо\n", SERVER_LIST[k], sv.ip);
    sv.fails = 0;
    sv.nextTry = 0;
    parseResponse(sv.http.getString());
  } else if (code < 0) {
    Serial.printf("[HTTP] %s (%s) хариу алга: %s\n", SERVER_LIST[k], sv.ip, HTTPClient::errorToString(code).c_str());
    if (++sv.fails >= (isHttps(k) ? 3 : 2)) {
      sv.ip[0] = 0;
      sv.fails = 0;
      sv.nextTry = millis() + (isHttps(k) ? 5000 : RETRY_OFFLINE_MS);
    }
  } else if (code == 401) {
    Serial.printf("[HTTP] %s: 401 — DEVICE_KEY нь .env.local-ийн DEVICE_API_KEY-тэй таарахгүй\n", SERVER_LIST[k]);
  } else {
    Serial.printf("[HTTP] %s: серверийн алдаа %d\n", SERVER_LIST[k], code);
  }
  sv.http.end();
  return ok;
}

static Sample batch[MAX_PER_POST];

static void sendBatch() {
  if (WiFi.status() != WL_CONNECTED) return;
  uint16_t n = takeSamples(batch, MAX_PER_POST);
  if (n == 0) return;

  String body;
  body.reserve(120 + n * 85);
  body += "{\"deviceId\":" "\"" DEVICE_ID "\",\"rssi\":";
  body += String((int)WiFi.RSSI());
  body += ",\"ip\":" "\"";
  body += WiFi.localIP().toString();
  body += "\"";
  body += ",\"samples\":[";
  char buf[120];
  for (uint16_t i = 0; i < n; i++) {
    const Sample& s = batch[i];
    snprintf(buf, sizeof(buf), "%s{\"t\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f}",
             i ? "," : "", (unsigned long)s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
    body += buf;
  }
  body += "]}";

  bool any = false;
  for (int k = 0; k < SERVER_N; k++) any |= postTo(k, body);
  if (any) {
    lastOkResponse = millis();
    postFailures = 0;
  } else {
    postFailures++;
    putBack(batch, n);   // аль ч сервер аваагүй → өгөгдлийг алдахгүй, дараа дахин илгээнэ
  }
}

// HTTP хүсэлт 50–500 мс блоклодог тул тусдаа task-д ажиллуулна → OLED болон веб саатахгүй
static void netTask(void*) {
  uint32_t last = 0;
  bool cloud = false;
  for (int k = 0; k < SERVER_N; k++) cloud |= isHttps(k) && !placeholder(k);
  const uint32_t every = cloud ? SEND_EVERY_CLOUD_MS : SEND_EVERY_MS;
  while (true) {
    uint32_t now = millis();
    if (now - last >= every) { last = now; sendBatch(); }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

// Хөтөч ws://<ESP32 IP>:81 руу шууд холбогдож, хэмжилт бүрийг (50 Hz) хоцролтгүй авна.
static void sha1digest(const uint8_t* msg, size_t len, uint8_t out[20]) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  size_t total = (len + 72) / 64 * 64;
  uint8_t blk[64];
  for (size_t off = 0; off < total; off += 64) {
    for (int i = 0; i < 64; i++) {
      size_t k = off + i;
      if (k < len) blk[i] = msg[k];
      else if (k == len) blk[i] = 0x80;
      else if (k + 8 >= total) blk[i] = (uint8_t)(((uint64_t)len << 3) >> ((total - 1 - k) << 3));
      else blk[i] = 0;
    }
    uint32_t w[80];
    for (int i = 0; i < 16; i++) w[i] = (uint32_t)blk[i * 4] << 24 | (uint32_t)blk[i * 4 + 1] << 16 | (uint32_t)blk[i * 4 + 2] << 8 | blk[i * 4 + 3];
    for (int i = 16; i < 80; i++) { uint32_t x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = x << 1 | x >> 31; }
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20)      { f = (b & c) | (~b & d);          k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d;                   k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else             { f = b ^ c ^ d;                   k = 0xCA62C1D6; }
      uint32_t t = (a << 5 | a >> 27) + f + e + k + w[i];
      e = d; d = c; c = b << 30 | b >> 2; b = a; a = t;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
  for (int i = 0; i < 20; i++) out[i] = (uint8_t)(h[i / 4] >> (24 - 8 * (i % 4)));
}

static String b64enc(const uint8_t* d, size_t n) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  String o;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)d[i] << 16 | (i + 1 < n ? (uint32_t)d[i + 1] << 8 : 0) | (i + 2 < n ? d[i + 2] : 0);
    o += T[v >> 18 & 63];
    o += T[v >> 12 & 63];
    o += i + 1 < n ? T[v >> 6 & 63] : '=';
    o += i + 2 < n ? T[v & 63] : '=';
  }
  return o;
}

static WiFiServer wsServer(WS_PORT);
static WsClient wsc[WS_MAX];

static void wsSendText(WsClient& k, const char* p, size_t n) {
  uint8_t hdr[4];
  size_t h = 0;
  hdr[h++] = 0x81;                                   // FIN + text
  if (n < 126) hdr[h++] = (uint8_t)n;
  else { hdr[h++] = 126; hdr[h++] = (uint8_t)(n >> 8 & 0xFF); hdr[h++] = (uint8_t)n; }
  if (k.c.write(hdr, h) != h || k.c.write((const uint8_t*)p, n) != n) { k.c.stop(); k.open = false; }
}

static void wsService() {
  static bool started = false;
  if (WiFi.status() != WL_CONNECTED) return;
  if (!started) { wsServer.begin(); wsServer.setNoDelay(true); started = true; }

  WiFiClient nc = wsServer.available();
  if (nc) {
    int slot = -1;
    for (int i = 0; i < WS_MAX; i++) if (!wsc[i].c.connected()) { slot = i; break; }
    if (slot < 0) nc.stop();
    else { wsc[slot].c = nc; wsc[slot].c.setNoDelay(true); wsc[slot].open = false; wsc[slot].since = millis(); wsc[slot].req = ""; }
  }

  for (int i = 0; i < WS_MAX; i++) {
    WsClient& k = wsc[i];
    if (!k.c.connected()) { k.open = false; continue; }
    if (!k.open) {
      while (k.c.available() && k.req.length() < 1024) k.req += (char)k.c.read();
      int end = k.req.indexOf("\r\n\r\n");
      if (end < 0) { if (millis() - k.since > 2000) k.c.stop(); continue; }
      int p = k.req.indexOf("Sec-WebSocket-Key" ":");
      if (p < 0) { k.c.stop(); continue; }
      p += 18;
      int q = k.req.indexOf('\r', p);
      String key = k.req.substring(p, q);
      key.trim();
      key += "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
      uint8_t dig[20];
      sha1digest((const uint8_t*)key.c_str(), key.length(), dig);
      String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept" ": ";
      resp += b64enc(dig, 20);
      resp += "\r\n\r\n";
      k.c.print(resp);
      k.open = true;
      k.req = "";
      Serial.printf("[WS] веб холбогдлоо (%s)\n", k.c.remoteIP().toString().c_str());
    } else {
      while (k.c.available()) {
        int b = k.c.read();
        if ((b & 0x0F) == 0x08 && (b & 0x80)) { k.c.stop(); k.open = false; break; }
      }
    }
  }

  Sample out[WS_RING];
  uint16_t n;
  portENTER_CRITICAL(&ringMux);
  n = wsCount;
  uint16_t tail = (wsHead + WS_RING - wsCount) % WS_RING;
  for (uint16_t i = 0; i < n; i++) out[i] = wsRing[(tail + i) % WS_RING];
  wsCount = 0;
  portEXIT_CRITICAL(&ringMux);
  if (n == 0) return;
  bool any = false;
  for (int i = 0; i < WS_MAX; i++) any |= wsc[i].open;
  if (!any) return;
  if (n > 10) { memmove(out, out + (n - 10), 10 * sizeof(Sample)); n = 10; }
  char buf[1024];
  size_t len = 0;
  buf[len++] = '[';
  for (uint16_t i = 0; i < n; i++) {
    const Sample& s = out[i];
    len += snprintf(buf + len, sizeof(buf) - len, "%s{\"t\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f}",
                    i ? "," : "", (unsigned long)s.t, s.ax, s.ay, s.az, s.gx, s.gy, s.gz);
    if (len > sizeof(buf) - 120) break;
  }
  buf[len++] = ']';
  for (int i = 0; i < WS_MAX; i++) if (wsc[i].open) wsSendText(wsc[i], buf, len);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== MotionCare ESP32-S3 (v2, 50 Hz) ===");

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  i2cMutex = xSemaphoreCreateMutex();

  oledOk = oledInit();
  if (oledOk) {
    fbClear();
    fbText(4, 18, "MotionCare", 2);
    fbText(22, 46, "эхэлж байна...", 1);
    oledFlush();
  } else {
    Serial.println("[OLED] олдсонгүй (0x3C) — холболтоо шалга");
  }

  mpuOk = mpuInit();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] \"%s\" руу холбогдож байна...\n", WIFI_SSID);

  xTaskCreate(sensorTask, "sensor", 4096, nullptr, 5, nullptr);
  xTaskCreate(netTask, "net", 8192, nullptr, 2, nullptr);
}

void loop() {
  static uint32_t lastDraw = 0, lastLog = 0;
  static bool wasConnected = false;

  ensureWifi();
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) {
    Serial.printf("[WiFi] холбогдлоо: IP %s → сервер http://%s:%d, веб шууд ws://%s:%u (эсвэл ws://" MDNS_NAME ".local:%u)\n",
                  WiFi.localIP().toString().c_str(), SERVER_LIST[0], SERVER_PORT,
                  WiFi.localIP().toString().c_str(), (unsigned)WS_PORT, (unsigned)WS_PORT);
  }
  wasConnected = connected;

  uint32_t now = millis();
  serialService();
  wsService();
  if (now - lastDraw >= 100) { lastDraw = now; drawScreen(); }
  if (now - lastLog >= 5000) {
    lastLog = now;
    Serial.printf("[STAT] buffer=%u dropped=%lu serialDropped=%lu label=%s %d%% fails=%lu\n",
                  (unsigned)ringCount, (unsigned long)droppedSamples, (unsigned long)serDropped,
                  lastLabel, lastConfidence, (unsigned long)postFailures);
  }
  serialService();
  delay(2);
}
