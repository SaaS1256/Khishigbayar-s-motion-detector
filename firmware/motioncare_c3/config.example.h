// Энэ файлыг config.h нэрээр хуулж, өөрийн утгаа бичнэ. config.h нь git-д ордоггүй (.gitignore).
// motioncare_c3.ino нь config.h байвал эндээс уншина, байхгүй бол ino доторх жишээ утгыг ашиглана.
#define WIFI_SSID      "YOUR_WIFI_NAME"       // Wi-Fi нэр (зөвхөн 2.4 GHz)
#define WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"   // Wi-Fi нууц үг
#define SERVER_HOSTS   "192.168.1.20", "https://YOUR-APP.vercel.app"   // IP, .local нэр эсвэл https хаяг
