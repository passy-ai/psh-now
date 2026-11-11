/*
 * Draws every `[data-notch]` panel on the page and runs the story in it.
 *
 * A panel opens, lists the queue, shows one request with its three decisions, types a
 * comment and sends it, then moves on. Hovering or clicking takes over, and the story
 * resumes when the pointer leaves. `window.PSH_NOTCH_EXAMPLES` overrides the queue, so a
 * page can tell the story in its own words: [[title, channel, age], ...].
 */
    (function () {
      // A page can tell the story in its own words: [[title, channel, age], ...].
      var EXAMPLES = window.PSH_NOTCH_EXAMPLES || [
        ["Approve the vendor invoice for 12,400 EUR?", "Finance", "2m"],
        ["Deploy the payments service to production?", "Platform", "9m"],
        ["Refund the duplicate charge on order 8842?", "Support", "14m"],
        ["Send the proposal with the 10% discount?", "Sales", "1h"],
        ["Offer the candidate the senior band?", "People", "3h"],
        ["Publish the incident note for yesterday?", "Support", "5h"],
        ["Move the 40k transfer to Friday?", "Finance", "1d"]
      ];
      // The head is a fixed 32px; the rest is measured from whichever body is up, so
      // the panel never carries dead space under the last row and never clips one when
      // the rows wrap on a narrow desk.
      var HEAD = 32;
      var ICONS = {
        deny: '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
        answer: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        ok: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
        send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'
      };
      var svg = function (d) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
          'stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
      };

      var panels = Array.prototype.slice.call(document.querySelectorAll("[data-notch]"));
      if (!panels.length) return;
      var shown = 0;

      panels.forEach(function (panel) {
        panel.innerHTML =
          '<div class="notch">' +
            '<div class="notch-head"><span class="notch-dot"></span><span class="notch-count">4</span></div>' +
            '<div class="notch-body-list"></div>' +
            '<div class="notch-body-detail">' +
              '<div class="notch-title"></div><div class="notch-sub"></div>' +
              '<div class="notch-actions">' +
                '<div class="act deny">' + svg(ICONS.deny) + '<span class="k">&#8984;N</span></div>' +
                '<div class="act answer">' + svg(ICONS.answer) + '<span class="k">&#8984;J</span></div>' +
                '<div class="act ok">' + svg(ICONS.ok) + '<span class="k">&#8984;L</span></div>' +
              '</div>' +
              '<div class="notch-comment">' +
                '<input class="notch-field" type="text" placeholder="Add a comment…" aria-label="Add a comment" />' +
                '<div class="notch-send" aria-hidden="true">' + svg(ICONS.send) + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        panel.__shape = panel.querySelector(".notch");
        panel.__title = panel.querySelector(".notch-title");
        panel.__sub = panel.querySelector(".notch-sub");
        panel.__list = panel.querySelector(".notch-body-list");
        panel.__detail = panel.querySelector(".notch-body-detail");
        panel.__field = panel.querySelector(".notch-field");
      });

      // Exactly two rows tall, whatever the row height works out to at this width.
      // Run again on every show, not just on paint: at first paint the rows are measured
      // against the fallback font, so the ceiling would be a few pixels short.
      function capList(panel) {
        var rows = panel.__list.querySelectorAll(".notch-row");
        if (rows.length > 2) {
          panel.__list.style.maxHeight = (rows[0].offsetHeight + rows[1].offsetHeight) + "px";
        }
      }

      function paint(index) {
        var item = EXAMPLES[index % EXAMPLES.length];
        panels.forEach(function (panel) {
          panel.__title.textContent = item[0];
          panel.__sub.textContent = item[1] + " needs an answer before the run continues.";
          // The list is fixed: row i is always EXAMPLES[i], so picking one twice in a
          // row lands on the same request rather than shifting under the pointer.
          panel.__list.innerHTML = EXAMPLES.slice(0, 4).map(function (row, i) {
            return '<div class="notch-row" data-i="' + i + '"><span class="led"></span><span>' + EXAMPLES[i][0] +
              '</span><span class="age">' + EXAMPLES[i][2] + '</span></div>';
          }).join("");
          capList(panel);
        });
      }

      function show(state, fieldOpen) {
        panels.forEach(function (panel) {
          var open = state === "detail" && fieldOpen === true;
          panel.className = "notch-demo" + (state === "idle" ? "" : " is-" + state) +
            (state === "detail" ? " is-busy" : "") + (open ? " is-field" : "");
          if (state === "list") capList(panel);
          // Measured after the class swap: .is-detail hides the list body and .is-field
          // adds the comment row, so this is the height of the body that is actually up.
          // offsetHeight, not getBoundingClientRect: the panel is scaled, and a rect
          // would hand back scaled pixels to an unscaled height and clip the last row.
          var body = state === "list" ? panel.__list : state === "detail" ? panel.__detail : null;
          panel.__shape.style.height = (HEAD + (body ? body.offsetHeight : 0)) + "px";
        });
      }

      // One story, on a loop, slow enough to follow: a request lands, the comment field
      // opens, a line is typed and sent, and the notch moves on to the next request. Each
      // step carries its own hold, so the rhythm is readable here instead of being hidden
      // in a counter. Hovering or clicking still takes over, and the story resumes on exit.
      var COMMENT = "Go ahead, this one is fine";
      var STORY = [
        ["idle", 600], ["list", 1100], ["detail", 1200], ["field", 300],
        ["type", 0], ["send", 750], ["next", 1600], ["list", 800]
      ];
      var at = 0;
      var timer = null;
      var typer = null;

      function stop() {
        clearTimeout(timer);
        clearInterval(typer);
        timer = null;
        typer = null;
        panels.forEach(function (panel) { panel.classList.remove("is-sending"); });
      }

      // The typed line arrives a character at a time, the way it does when a person writes
      // it: a comment that appears whole reads as a screenshot, not as a thing being sent.
      function typeComment() {
        var i = 0;
        panels.forEach(function (panel) { if (panel.__field) panel.__field.value = ""; });
        typer = setInterval(function () {
          i += 1;
          panels.forEach(function (panel) {
            if (panel.__field) panel.__field.value = COMMENT.slice(0, i);
          });
          if (i >= COMMENT.length) {
            clearInterval(typer);
            typer = null;
            timer = setTimeout(tick, 500);
          }
        }, 45);
      }

      function tick() {
        var step = STORY[at % STORY.length];
        var phase = step[0];
        at += 1;
        if (phase === "idle") {
          show("idle");
        } else if (phase === "list") {
          paint(shown);
          show("list");
        } else if (phase === "detail") {
          show("detail");
        } else if (phase === "field") {
          show("detail", true);
        } else if (phase === "type") {
          show("detail", true);
          typeComment();
          return;
        } else if (phase === "send") {
          panels.forEach(function (panel) { panel.classList.add("is-sending"); });
        } else if (phase === "next") {
          // The send has landed, so the field closes and the next request takes its place.
          panels.forEach(function (panel) {
            panel.classList.remove("is-sending");
            if (panel.__field) panel.__field.value = "";
          });
          shown += 1;
          paint(shown);
          show("detail");
        }
        timer = setTimeout(tick, step[1]);
      }

      // Capture runs the same story at its own pace instead of racing a screenshot loop.
      window.__pshDemo = {
        reset: function () { stop(); shown = 0; at = 0; paint(0); show("idle"); },
        start: function () { stop(); shown = 0; at = 0; paint(0); tick(); },
        pause: stop,
        comment: COMMENT
      };

      panels.forEach(function (panel) {
        // Coming in stops the demo on the list, so the pointer picks from there rather
        // than being dropped onto whatever was opened last.
        panel.addEventListener("mouseenter", function () {
          stop();
          paint(shown);
          show("list");
        });
        panel.addEventListener("mouseleave", function () {
          if (panel.__field && document.activeElement === panel.__field) return;
          // Leaving closes the open request: the list is what you come back to.
          if (panel.classList.contains("is-detail")) { paint(shown); show("list"); }
          if (!timer) { at = 1; tick(); }
        });
        panel.addEventListener("click", function (event) {
          var act = event.target.closest(".act");
          if (act) {
            act.classList.add("pressed");
            setTimeout(function () { act.classList.remove("pressed"); }, 200);
            // The comment tile opens the field in place and toggles it shut again.
            if (act.classList.contains("answer")) {
              show("detail", !panel.classList.contains("is-field"));
              return;
            }
            // The other two settle this request, so fall back to the list rather
            // than leaving the notch parked on it: that is where the next is picked.
            stop();
            show("list");
            return;
          }
          var row = event.target.closest(".notch-row");
          if (row) {
            // Rows map straight onto the queue, so the request opened is the one named.
            shown = Number(row.getAttribute("data-i"));
            stop();
            paint(shown);
            show("detail");
            return;
          }
          if (event.target.closest(".notch-field")) return;
          stop();
          paint(shown);
          show(panel.className.indexOf("is-detail") >= 0 ? "list" : "detail");
        });
        if (panel.__field) {
          panel.__field.addEventListener("focus", function () {
            stop();
            show("detail", true);
          });
        }
      });

      // The card in "how it works" is the same notch, held open. Its comment tile used to
      // look clickable and do nothing: it reveals the field now, and Enter or the send
      // button closes it and clears it.
      document.querySelectorAll(".notch-static").forEach(function (card) {
        var field = card.querySelector(".notch-field");
        var answer = card.querySelector(".act.answer");
        var send = card.querySelector(".notch-send");
        function closeField() {
          card.classList.remove("is-field");
          if (field) field.value = "";
        }
        function toggleField() {
          if (card.classList.contains("is-field")) { closeField(); return; }
          card.classList.add("is-field");
          if (field) field.focus();
        }
        if (answer) {
          answer.addEventListener("click", toggleField);
          answer.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleField(); }
          });
        }
        if (send) send.addEventListener("click", closeField);
        if (field) {
          field.addEventListener("keydown", function (event) { if (event.key === "Enter") closeField(); });
          // Clicking away from an empty field puts the card back the way it was.
          field.addEventListener("blur", function () { if (!field.value.trim()) closeField(); });
        }
      });

      paint(0);
      // ?capture=1 holds the first frame so a recorder can start the story itself.
      if (/[?&]capture=1/.test(location.search)) show("idle");
      else tick();
    })();
