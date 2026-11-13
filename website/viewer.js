/**
 * The header, for someone who is already signed in.
 *
 * The pages are generated once and served to everyone, so their "Log in" and "Get
 * started" are the right answer for a stranger. Someone arriving with a session cookie
 * gets one background question - is that still them? - and if it is, the two links
 * become "Dashboard" and "Go to dashboard".
 *
 * The existing nodes are renamed rather than replaced by a bar of its own, so nothing
 * moves and a slow or failed answer simply leaves the marketing header showing. Both
 * links already point at /app, which is the dashboard: the swap only changes the words.
 *
 * Loaded by every page that has the marketing header, which is why it is a file of its
 * own rather than part of the homepage's app.js.
 */
(function () {
  var right = document.querySelector(".header-right");
  if (!right || !window.fetch) return;
  var login = right.querySelector('a.nav-link[href="/app"]');
  var cta = right.querySelector('a.btn[href="/app"]');
  if (!login || !cta) return;
  fetch("/api/v1/viewer", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (viewer) {
      if (!viewer || !viewer.signedIn) return;
      login.textContent = "Dashboard";
      cta.textContent = "Go to dashboard";
    })
    .catch(function () { /* offline, or a host without the endpoint: keep the default */ });
})();
