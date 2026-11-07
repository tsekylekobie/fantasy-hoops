// Service worker for injury alerts (Web Push). Registered by the user menu's
// "Injury alerts" toggle (src/components/PushToggle.tsx). The payload is a
// PushMessage from src/lib/push/injuryAlerts.ts: { title, body, tag, url }.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || "Fantasy Hoops", {
      body: msg.body || "",
      tag: msg.tag,
      renotify: Boolean(msg.tag),
      data: { url: msg.url || "/my-team" },
    }),
  );
});

// Tapping it focuses an open tab of the app (moved to the page) or opens one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/my-team", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((tabs) => {
      for (const tab of tabs) {
        if (new URL(tab.url).origin === self.location.origin && "focus" in tab) {
          return tab
            .focus()
            .then((t) => t.navigate(url))
            .catch(() => self.clients.openWindow(url));
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
