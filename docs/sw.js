self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : { title: "ShiftShare", body: "シフトが更新されました" };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./apple-touch-icon.png",
      badge: "./apple-touch-icon.png",
    })
  );
});

// Chrome の PWA インストール要件を満たすための fetch ハンドラ（ネットワーク素通し）
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => new Response("", { status: 504 })));
});
