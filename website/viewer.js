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

/**
 * The menu button, for a bar that has room for none of the links.
 *
 * `@media (min-width: 780px)` is where six links and a brand fit, so below that the CSS
 * hides every `.nav-link` and the header keeps only the brand and the call to action.
 * On a phone that left no way to reach Docs, Agents or Teams from the bar at all, which
 * is what makes a header look broken. This adds the button and the panel.
 *
 * Built here rather than written into 21 pages: there is one header, and a menu that is
 * markup cannot be opened by CSS alone (`:focus-within` closes the moment you press a
 * key, and `:target` needs a link in the page). The button is hidden by CSS above 780px,
 * so a page whose script never runs simply has the header it has today.
 */
(function () {
  var nav = document.querySelector(".header-nav");
  var header = document.querySelector(".site-header");
  if (!nav || !header || !document.createElement) return;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nav-toggle";
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "navPanel");
  btn.setAttribute("aria-label", "Menu");
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/>' +
    '<path d="M4 17h16"/></svg>';

  // The panel repeats the bar's links. Cloned rather than typed out a second time, so a
  // page that adds a link to `.header-nav` cannot end up with a short mobile menu.
  var panel = document.createElement("div");
  panel.className = "nav-panel";
  panel.id = "navPanel";
  panel.hidden = true;
  for (var i = 0; i < nav.children.length; i++) {
    panel.appendChild(nav.children[i].cloneNode(true));
  }

  btn.addEventListener("click", function () {
    var open = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", open ? "false" : "true");
    panel.hidden = open;
  });
  // A tap outside, or Escape, closes it: a panel that traps you is worse than none.
  panel.addEventListener("click", function (event) {
    if (event.target.tagName === "A") { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !panel.hidden) {
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.focus();
    }
  });

  var right = header.querySelector(".header-right");
  if (right) right.insertBefore(btn, right.firstChild);
  else header.querySelector(".header-inner").appendChild(btn);
  header.appendChild(panel);
})();
