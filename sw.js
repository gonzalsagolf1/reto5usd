// Recibe las notificaciones aunque la web esté cerrada. El contenido llega cifrado
// de punta a punta desde la app de la PC: solo este teléfono lo puede leer.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d;
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'Reto 5 USD', {
      body: d.body || '',
      tag: d.tag || undefined,
      icon: 'apple-touch-icon.png',
      data: { url: d.url || './' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of list) {
        if ('focus' in c) {
          await c.focus();
          c.postMessage({ type: 'refresh' });
          return;
        }
      }
      await self.clients.openWindow(e.notification.data?.url || './');
    })(),
  );
});
