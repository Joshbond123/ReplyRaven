self.addEventListener('push', (event) => {
  let message;
  try {
    message = event.data.json();
  } catch {
    message = { title: 'ReplyRaven', body: 'Open your workspace for an update.' };
  }
  const safeURL = (value) => {
    try {
      const url = new URL(value, self.registration.scope);
      return url.origin === new URL(self.registration.scope).origin
        ? url.href
        : new URL('notifications.html', self.registration.scope).href;
    } catch {
      return new URL('notifications.html', self.registration.scope).href;
    }
  };
  event.waitUntil(
    self.registration.showNotification(message.title || 'ReplyRaven', {
      body: message.body || '',
      icon: new URL('assets/raven.svg', self.registration.scope).href,
      badge: new URL('assets/raven.svg', self.registration.scope).href,
      tag: message.id || 'replyraven',
      data: { url: safeURL(message.url) },
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || new URL('notifications.html', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.registration.scope));
      if (existing) {
        await existing.navigate(url);
        return existing.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
