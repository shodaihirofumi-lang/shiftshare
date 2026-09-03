self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : { title: "ShiftShare", body: "シフトが更新されました" };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./apple-touch-icon.png",
      badge: "./apple-touch-icon.png",
      data: { url: data.url || "./" },
    })
  );
});

// 通知タップで対象URL（アプリ or moomoo）を開く
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cls) => {
      // 外部URL(moomoo等)は新規で開く。アプリ内(相対/同一オリジン)は既存タブを再利用
      const isExternal = /^https?:\/\//.test(url) && !url.includes(self.location.host);
      if (!isExternal) {
        for (const c of cls) {
          if ("focus" in c) { c.navigate && c.navigate(url); return c.focus(); }
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Chrome の PWA インストール要件を満たすための fetch ハンドラ（ネットワーク素通し）
self.addEventListener("fetch", (e) => {
  e.respondWith(fetch(e.request).catch(() => new Response("", { status: 504 })));
});
