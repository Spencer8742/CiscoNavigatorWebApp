/*
 * Service worker.
 *
 * Exists for push notifications and nothing else. It is registered only off
 * RoomOS (see panel/src/net/push.ts), because a wall panel has no use for one,
 * and it deliberately has no `fetch` handler: the caching policy in
 * server/src/http/static.ts — a revalidated shell, immutable hashed assets —
 * is what makes a deploy reach every panel on its next load, and a worker
 * answering from its own cache would quietly hold old builds in place.
 *
 * Plain JavaScript in public/, so it is served at /sw.js unhashed and
 * `no-cache`: the browser checks it for changes on every launch.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * Every push shows a notification. iOS revokes the subscription of a web app
 * that receives pushes without showing anything, so there is no silent path.
 * The payload is the PushMessage the backend built (shared/protocol.ts).
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : '' };
  }

  const title = typeof data.title === 'string' && data.title ? data.title : 'Home';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag;
    // A replacement should still be noticed, not swapped in silently.
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

/*
 * A tap brings the panel forward: an open window if there is one, otherwise a
 * new one at the notification's path. Same-origin only — the backend refuses
 * anything else, and this checks again rather than trusting it.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let target;
  try {
    target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  } catch {
    target = new URL('/', self.location.origin);
  }
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          // The panel does its own routing (it never navigates by URL), so
          // it is told where to go rather than reloaded there.
          client.postMessage({ t: 'open', url: target.href });
          return client.focus();
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
