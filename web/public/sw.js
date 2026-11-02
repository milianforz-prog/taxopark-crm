// Service worker нужен, чтобы сайт можно было установить как приложение.
// Данные не кешируем: CRM всегда показывает свежие цифры из базы.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
