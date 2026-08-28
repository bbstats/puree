// Minimal service worker: makes the site installable; no offline caching
// (the app needs the network for its data anyway).
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* network as usual */ });
