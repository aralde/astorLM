(function () {
  'use strict';

  var root = document.documentElement;
  var doc = document.querySelector('.doc');
  var sidebar = document.getElementById('sidebar');
  var scrim = document.getElementById('scrim');
  var menuBtn = document.getElementById('menuBtn');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ------------------------------- helpers -------------------------------- */
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  var COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  var OK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 12.5 5 5L20 6.5"/></svg>';

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        resolve();
      } catch (err) { reject(err); }
    });
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }

  /* ------------------------------- theme ---------------------------------- */
  var themeBtn = document.getElementById('themeBtn');
  var sun = document.getElementById('iconSun');
  var moon = document.getElementById('iconMoon');

  function isDark() {
    var attr = root.getAttribute('data-theme');
    if (attr) return attr === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function syncIcons() {
    var dark = isDark();
    sun.style.display = dark ? 'none' : '';
    moon.style.display = dark ? '' : 'none';
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  syncIcons();

  themeBtn.addEventListener('click', function () {
    var next = isDark() ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    store('astorlm-theme', next);
    syncIcons();
  });

  var media = window.matchMedia('(prefers-color-scheme: dark)');
  if (media.addEventListener) {
    media.addEventListener('change', function () { if (!root.getAttribute('data-theme')) syncIcons(); });
  }

  /* --------------------------- content enhancement ------------------------ */
  function langOf(text) {
    var t = text.trim();
    if (/^(pnpm|npm|yarn|bun|npx|curl|git|docker)\s/.test(t) || /^\$\s/.test(t)) return 'shell';
    if (/^[{[]/.test(t) && /"[a-z]+"\s*:/.test(t)) return 'json';
    return 'ts';
  }

  function enhanceCode() {
    Array.prototype.forEach.call(doc.querySelectorAll('pre'), function (pre) {
      var wrap = document.createElement('div');
      wrap.className = 'code-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      var bar = document.createElement('div');
      bar.className = 'code-bar';

      var lang = document.createElement('span');
      lang.className = 'code-lang';
      lang.textContent = langOf(pre.textContent || '');

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.setAttribute('aria-label', 'Copy code');
      btn.innerHTML = COPY_ICON + '<span>Copy</span>';
      btn.addEventListener('click', function () {
        copyText(pre.innerText).then(function () {
          btn.classList.add('done');
          btn.innerHTML = OK_ICON + '<span>Copied</span>';
          btn.setAttribute('aria-label', 'Copied');
          setTimeout(function () {
            btn.classList.remove('done');
            btn.innerHTML = COPY_ICON + '<span>Copy</span>';
            btn.setAttribute('aria-label', 'Copy code');
          }, 1600);
        }).catch(function () {});
      });

      bar.appendChild(lang);
      bar.appendChild(btn);
      wrap.insertBefore(bar, pre);
    });
  }

  function enhanceTables() {
    Array.prototype.forEach.call(doc.querySelectorAll('table'), function (table) {
      /* Let long import paths break after a slash instead of mid-word. */
      Array.prototype.forEach.call(table.querySelectorAll('td code'), function (code) {
        var walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(function (node) {
          if (!node.nodeValue || node.nodeValue.indexOf('/') === -1) return;
          var parts = node.nodeValue.split('/');
          var frag = document.createDocumentFragment();
          parts.forEach(function (part, i) {
            if (i > 0) frag.appendChild(document.createElement('wbr'));
            frag.appendChild(document.createTextNode(part));
            if (i < parts.length - 1) frag.appendChild(document.createTextNode('/'));
          });
          node.parentNode.replaceChild(frag, node);
        });
      });

      var wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  function enhanceHeadings() {
    Array.prototype.forEach.call(doc.querySelectorAll('h2, h3'), function (heading) {
      if (!heading.id) {
        var base = slug(heading.textContent) || 'section';
        var id = base;
        var n = 2;
        while (document.getElementById(id)) { id = base + '-' + n++; }
        heading.id = id;
      }
      var link = document.createElement('a');
      link.className = 'anchor';
      link.href = '#' + heading.id;
      link.textContent = '#';
      link.setAttribute('aria-label', 'Link to this section');
      heading.appendChild(link);
    });
  }

  function enhanceInstall() {
    var button = document.getElementById('installCopy');
    var cmd = document.getElementById('installCmd');
    if (!button || !cmd) return;
    button.addEventListener('click', function () {
      copyText(cmd.textContent).then(function () {
        button.classList.add('done');
        button.innerHTML = OK_ICON;
        button.setAttribute('aria-label', 'Copied');
        setTimeout(function () {
          button.classList.remove('done');
          button.innerHTML = COPY_ICON;
          button.setAttribute('aria-label', 'Copy install command');
        }, 1600);
      }).catch(function () {});
    });
  }

  enhanceHeadings();

  /* --------------------------- sidebar drawer ----------------------------- */
  function setNav(open) {
    sidebar.classList.toggle('open', open);
    scrim.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    document.body.style.overflow = open ? 'hidden' : '';
  }
  menuBtn.addEventListener('click', function () { setNav(!sidebar.classList.contains('open')); });
  scrim.addEventListener('click', function () { setNav(false); });
  sidebar.addEventListener('click', function (event) {
    if (event.target.closest('a')) setNav(false);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) setNav(false);
  });

  /* ------------------------------- scrollspy ------------------------------ */
  var navLinks = Array.prototype.slice.call(sidebar.querySelectorAll('a[href^="#"]'));
  var linkFor = {};
  navLinks.forEach(function (link) { linkFor[link.getAttribute('href').slice(1)] = link; });

  var sections = Array.prototype.slice.call(doc.querySelectorAll('h2[id]'))
    .filter(function (heading) { return linkFor[heading.id]; });

  var current = null;
  function setActive(id) {
    if (id === current) return;
    current = id;
    navLinks.forEach(function (link) {
      link.classList.remove('active');
      link.removeAttribute('aria-current');
    });
    var link = linkFor[id];
    if (!link) return;
    link.classList.add('active');
    link.setAttribute('aria-current', 'true');
    var top = link.offsetTop;
    var bottom = top + link.offsetHeight;
    if (top < sidebar.scrollTop || bottom > sidebar.scrollTop + sidebar.clientHeight) {
      sidebar.scrollTop = top - sidebar.clientHeight / 2;
    }
  }

  function updateSpy() {
    var line = window.innerHeight * 0.3;
    var active = null;
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= line) active = sections[i].id;
    }
    if (active) {
      setActive(active);
    } else {
      current = null;
      navLinks.forEach(function (link) {
        link.classList.remove('active');
        link.removeAttribute('aria-current');
      });
    }
  }

  /* --------------------------- progress + top ----------------------------- */
  var bar = document.getElementById('progress');
  var backtop = document.getElementById('backtop');
  backtop.addEventListener('click', scrollToTop);

  function paint() {
    var height = document.documentElement.scrollHeight - window.innerHeight;
    var y = window.scrollY || window.pageYOffset || 0;
    bar.style.width = (height > 0 ? Math.min(100, (y / height) * 100) : 0) + '%';
    backtop.classList.toggle('show', y > 900);
    updateSpy();
  }

  /* Time-based throttle: rAF is throttled to zero in background tabs and some
     webviews, and a pending-guard would wedge scrolling for good. */
  var lastPaint = 0;
  var queued = null;
  function onScroll() {
    var now = Date.now();
    if (now - lastPaint >= 16) {
      lastPaint = now;
      if (queued) { clearTimeout(queued); queued = null; }
      paint();
    } else if (!queued) {
      queued = setTimeout(function () { queued = null; lastPaint = Date.now(); paint(); }, 16);
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll);
  window.addEventListener('hashchange', onScroll);
  window.addEventListener('load', onScroll);
  paint();

  /* -------------------------------- search -------------------------------- */
  var overlay = document.getElementById('overlay');
  var input = document.getElementById('searchInput');
  var results = document.getElementById('results');
  var closeBtn = document.getElementById('searchClose');

  var index = [];
  (function buildIndex() {
    var headings = Array.prototype.slice.call(doc.querySelectorAll('h2[id], h3[id]'));
    headings.forEach(function (heading) {
      var level = heading.tagName === 'H2' ? 2 : 3;
      var parts = [];
      var node = heading.nextElementSibling;
      while (node && !(node.tagName === 'H2' || (level === 3 && node.tagName === 'H3'))) {
        parts.push(node.innerText || node.textContent || '');
        node = node.nextElementSibling;
      }
      var crumb = '';
      if (level === 3) {
        var parent = heading.previousElementSibling;
        while (parent && parent.tagName !== 'H2') parent = parent.previousElementSibling;
        if (parent) crumb = parent.textContent.replace(/#$/, '').trim();
      }
      var title = heading.textContent.replace(/#$/, '').trim();
      index.push({
        id: heading.id,
        title: title,
        crumb: crumb,
        level: level,
        body: parts.join(' ').replace(/\s+/g, ' ').trim(),
        hay: (title + ' ' + crumb + ' ' + parts.join(' ')).toLowerCase()
      });
    });
  })();

  /* Build the search index before the code panes gain their labels and copy
     buttons, so those never leak into the indexed text. */
  enhanceCode();
  enhanceTables();
  enhanceInstall();

  function esc(value) {
    return value.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function mark(text, query) {
    var at = text.toLowerCase().indexOf(query);
    if (at < 0) return esc(text.slice(0, 150));
    var start = Math.max(0, at - 55);
    var head = (start > 0 ? '…' : '') + text.slice(start, at);
    var hit = text.slice(at, at + query.length);
    var tail = text.slice(at + query.length, at + query.length + 95);
    return esc(head) + '<mark>' + esc(hit) + '</mark>' + esc(tail);
  }

  var matches = [];
  var selected = 0;

  function render(query) {
    if (!query) {
      results.innerHTML = '<div class="empty">Type to search ' + index.length + ' sections.</div>';
      matches = [];
      return;
    }
    matches = index.map(function (item) {
      var pos = item.hay.indexOf(query);
      if (pos < 0) return null;
      var score = 0;
      var title = item.title.toLowerCase();
      if (title === query) score += 1000;
      else if (title.indexOf(query) === 0) score += 600;
      else if (title.indexOf(query) >= 0) score += 400;
      if (item.level === 2) score += 40;
      score -= Math.min(pos, 300) / 10;
      return { item: item, score: score };
    }).filter(Boolean).sort(function (a, b) { return b.score - a.score; }).slice(0, 12).map(function (m) { return m.item; });

    if (!matches.length) {
      results.innerHTML = '<div class="empty">No results for “' + esc(query) + '”.</div>';
      return;
    }
    selected = 0;
    results.innerHTML = matches.map(function (item, i) {
      return '<a class="res' + (i === 0 ? ' sel' : '') + '" href="#' + item.id + '" data-i="' + i + '">' +
        '<span class="t">' + esc(item.title) +
        (item.crumb ? '<span class="crumb">' + esc(item.crumb) + '</span>' : '') + '</span>' +
        '<span class="s">' + mark(item.body || item.title, query) + '</span></a>';
    }).join('');
  }

  function highlight() {
    Array.prototype.forEach.call(results.querySelectorAll('.res'), function (el, i) {
      el.classList.toggle('sel', i === selected);
      if (i === selected && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function openSearch() {
    if (sidebar.classList.contains('open')) setNav(false);
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    input.value = '';
    render('');
    input.focus();
  }
  function closeSearch() {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
    document.getElementById('searchBtn').focus();
  }

  /* keep Tab inside the dialog while it is open */
  overlay.addEventListener('keydown', function (event) {
    if (event.key !== 'Tab') return;
    var focusable = overlay.querySelectorAll('input, button, a[href]');
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  function go(i) {
    var item = matches[i];
    if (!item) return;
    closeSearch();
    location.hash = '#' + item.id;
  }

  document.getElementById('searchBtn').addEventListener('click', openSearch);
  closeBtn.addEventListener('click', closeSearch);
  overlay.addEventListener('click', function (event) { if (event.target === overlay) closeSearch(); });
  input.addEventListener('input', function () { render(input.value.trim().toLowerCase()); });

  results.addEventListener('click', function (event) {
    var link = event.target.closest('.res');
    if (!link) return;
    event.preventDefault();
    go(parseInt(link.getAttribute('data-i'), 10));
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (matches.length) { selected = (selected + 1) % matches.length; highlight(); }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length) { selected = (selected - 1 + matches.length) % matches.length; highlight(); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(selected);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  });

  document.addEventListener('keydown', function (event) {
    var key = (event.key || '').toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'k') {
      event.preventDefault();
      overlay.classList.contains('open') ? closeSearch() : openSearch();
      return;
    }
    if (overlay.classList.contains('open')) { if (event.key === 'Escape') closeSearch(); return; }
    var tag = (event.target && event.target.tagName) || '';
    if (key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      event.preventDefault();
      openSearch();
    }
  });

  if (!/Mac|iPhone|iPad/.test(navigator.platform || '')) {
    var hint = document.querySelector('.kbd-hint kbd');
    if (hint) hint.textContent = 'Ctrl K';
  }

  /* Deep links: content enhancement (code bars, table wrappers) and webfont
     swaps change the document height after the browser's initial hash jump,
     so the target can end up thousands of pixels off. Re-align once the
     layout has settled. */
  (function alignHash() {
    var id = location.hash.slice(1);
    if (!id) return;
    var target = document.getElementById(id);
    if (!target) return;

    function align() {
      var offset = target.getBoundingClientRect().top;
      if (Math.abs(offset - 80) < 60) return;
      var previous = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      window.scrollTo(0, window.scrollY + offset - 80);
      root.style.scrollBehavior = previous;
    }

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(align);
    setTimeout(align, 150);
    window.addEventListener('load', align);
  })();
})();
