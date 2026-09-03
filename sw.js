/* Opvangwacht — service worker.
   Houdt de app zelf offline beschikbaar. Gegevens gaan nooit door deze cache:
   die halen we altijd rechtstreeks bij Apps Script, en wat niet vertrekt
   wacht in de wachtrij van de app zelf. */

var CACHE = "opvangwacht-v1";
var SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (namen) {
      return Promise.all(namen.map(function (n) { return n === CACHE ? null : caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;                       // schrijfacties nooit uit cache
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Apps Script, fonts, cdn: rechtstreeks

  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var kopie = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, kopie); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
