self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : { title: "ShiftShare", body: "シフトが更新されました" };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.png",
    })
  );
});
