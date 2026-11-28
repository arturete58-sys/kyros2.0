import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import Lenis from 'lenis';
import createGlobe from 'cobe';

gsap.registerPlugin(ScrollTrigger, SplitText);

(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* Mobile navigation */
  const toggle = $('[data-nav-toggle]');
  const sheet = $('[data-nav-sheet]');
  if (toggle && sheet) {
    const close = () => { toggle.setAttribute('aria-expanded', 'false'); sheet.hidden = true; };
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      sheet.hidden = !open;
    });
    $$('a', sheet).forEach((a) => a.addEventListener('click', close));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.matchMedia('(min-width: 881px)').addEventListener('change', close);
  }

  /* Countries and the split demo */
  const REGIONS = [
    ['Latin America and the Caribbean', ['ar', 'br', 'co', 'mx', 'pa', 'sv', 'pr', 'bs', 'ky', 'bm']],
    ['North America', ['us', 'ca']],
    ['Europe', ['es', 'pt', 'fr', 'de', 'it', 'nl', 'gb', 'ie', 'ch', 'li', 'lu', 'mc', 'ad', 'mt', 'cy', 'ee', 'ua', 'tr', 'ge']],
    ['Middle East and Africa', ['ae', 'bh', 'ke', 'ng', 'za']],
    ['Asia and the Pacific', ['au', 'hk', 'id', 'in', 'jp', 'kr', 'mh', 'ph', 'pk', 'sg', 'th', 'vn']],
  ];
  const NAMES = { mx: 'Mexico', ae: 'United Arab Emirates', bs: 'The Bahamas', tr: 'Türkiye' };
  const PERIOD = { Month: 'monthly', Months2: 'every two months', Quarter: 'quarterly', Months4: 'four-monthly', Half: 'half-yearly', Year: 'yearly' };
  const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt0 = new Intl.NumberFormat('en-US');
  const nameOf = (c) => NAMES[c.id] || c.name.split(':')[0].trim();

  const countrySel = $('[data-split-country]');
  const presetSel = $('[data-split-preset]');
  const amount = $('[data-split-amount]');
  const amountOut = $('[data-split-amount-out]');
  let countries = [];

  function presetsOf(id) { return (countries.find((c) => c.id === id) || {}).presets || []; }

  function fillPresets() {
    const ps = presetsOf(countrySel.value);
    presetSel.replaceChildren(...ps.map((p, i) => new Option(p.label, String(i))));
  }

  function render(fromZero) {
    const c = countries.find((x) => x.id === countrySel.value);
    const p = c && c.presets[Number(presetSel.value) || 0];
    if (!p) return;
    const gross = Number(amount.value);
    const base = gross / (1 + p.vat / 10000);
    const vat = gross - base;
    const tax = p.b.reduce((s, b) => s + (base * b.bps) / 10000, 0);
    const you = Math.max(0, gross - vat - tax);
    amountOut.textContent = fmt0.format(gross);
    $('[data-split-total]').textContent = fmt.format(gross);
    tween($('[data-out="you"]'), you, fromZero);
    tween($('[data-out="vat"]'), vat, fromZero);
    tween($('[data-out="tax"]'), tax, fromZero);
    $('[data-row="vat"]').hidden = p.vat === 0;
    $('[data-row="tax"]').hidden = tax === 0;
    $('[data-out="vat-name"]').textContent = `${c.vat || 'VAT'} ${p.vat / 100}%`;
    const per = PERIOD[c.period];
    $('[data-out="vat-when"]').textContent = per ? `Locked until your ${per} return is due` : 'Locked until it is due';
    $('[data-out="tax-name"]').textContent = p.b.length === 1 ? p.b[0].n : 'Income tax';
    const segs = { you, vat, tax };
    const set = () => Object.entries(segs).forEach(([k, v]) => { $(`[data-seg="${k}"]`).style.flexBasis = `${((v / gross) * 100).toFixed(2)}%`; });
    if (fromZero && !reduce) {
      Object.keys(segs).forEach((k) => { const el = $(`[data-seg="${k}"]`); el.style.transition = 'none'; el.style.flexBasis = '0%'; });
      void $('[data-split-bar]').offsetWidth;
      Object.keys(segs).forEach((k) => { $(`[data-seg="${k}"]`).style.transition = ''; });
      requestAnimationFrame(set);
    } else set();
  }

  function tween(el, to, fromZero) {
    const from = fromZero ? 0 : Number(el.dataset.v || 0);
    el.dataset.v = String(to);
    if (reduce) { el.textContent = fmt.format(to); return; }
    const o = { v: from };
    gsap.killTweensOf(el);
    gsap.to(o, { v: to, duration: fromZero ? 0.9 : 0.35, ease: 'expo.out', overwrite: true, onUpdate: () => { el.textContent = fmt.format(o.v); } });
  }

  function chooseCountry(id, scroll) {
    if (!countries.some((c) => c.id === id)) return;
    countrySel.value = id;
    fillPresets();
    render(true);
    if (scroll) goTo('#split');
  }

  function buildRegions() {
    const host = $('[data-regions]');
    const byId = Object.fromEntries(countries.map((c) => [c.id, c]));
    host.replaceChildren(...REGIONS.map(([title, ids]) => {
      const sec = document.createElement('section');
      sec.className = 'region';
      const h = document.createElement('h3');
      h.textContent = title;
      const ul = document.createElement('ul');
      ids.filter((id) => byId[id]).sort((a, b) => nameOf(byId[a]).localeCompare(nameOf(byId[b]))).forEach((id) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.id = id;
        b.dataset.search = `${nameOf(byId[id])} ${byId[id].name} ${byId[id].cc}`.toLowerCase();
        b.setAttribute('aria-label', `${nameOf(byId[id])}: try a payment split`);
        const code = document.createElement('code');
        code.textContent = byId[id].cc;
        b.append(nameOf(byId[id]), code);
        b.addEventListener('click', () => chooseCountry(id, true));
        b.addEventListener('pointerenter', () => focusGlobe(id));
        b.addEventListener('focus', () => focusGlobe(id));
        li.append(b);
        ul.append(li);
      });
      sec.append(h, ul);
      return sec;
    }));
    const search = $('[data-country-search]');
    const empty = $('[data-country-empty]');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      $$('.region', host).forEach((r) => {
        let n = 0;
        $$('.chip', r).forEach((ch) => { const ok = !q || ch.dataset.search.includes(q); ch.parentElement.hidden = !ok; n += ok; });
        r.hidden = n === 0;
        shown += n;
      });
      empty.hidden = shown > 0;
    });
  }

  /* ---------- Public testnet counter (stats.json, updated daily from Stellar) ---------- */
  {
    const el = $('[data-stats]');
    // Shown once there is something worth showing.
    const MIN_VAULTS = 10;
    if (el) {
      fetch('stats.json', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (!s || !(s.vaults >= MIN_VAULTS)) return;
          const n = (x) => Number(x).toLocaleString('en-US');
          const b = (x) => Object.assign(document.createElement('b'), { textContent: n(x) });
          el.replaceChildren(b(s.vaults), ' vaults opened and ', b(s.payments), ' payments split on testnet so far, all checkable on Stellar.');
          el.hidden = false;
        })
        .catch(() => {});
    }
  }

  fetch('countries.json')
    .then((r) => r.json())
    .then((data) => {
      countries = data;
      const sorted = [...countries].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      countrySel.replaceChildren(...sorted.map((c) => new Option(nameOf(c), c.id)));
      countrySel.value = 'es';
      fillPresets();
      render(false);
      buildRegions();
      countrySel.addEventListener('change', () => { fillPresets(); render(true); });
      presetSel.addEventListener('change', () => render(true));
      amount.addEventListener('input', () => render(false));
      $('[data-split-replay]').addEventListener('click', () => render(true));
      const split = $('#split');
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) { render(true); io.disconnect(); } }, { threshold: 0.4 });
        io.observe(split);
      }
    })
    .catch(() => { $('.split-result').hidden = true; });

  /* Product tabs */
  const tabs = $$('[role="tab"]', $('[data-tabs]'));
  const img = $('[data-phone-img]');
  const panel = $('[data-panel]');
  const ALTS = {
    'screen-home': 'Kyros home screen: 6,482.35 USDC you can spend and 2,918.40 USDC set aside for taxes',
    'screen-assistant': 'The Kyros assistant answering whether the reserve is enough for 40,000 EUR a year',
    'screen-pay': 'Pay taxes screen with the next VAT and income tax deadlines',
    'screen-move': 'Change country screen: moving to Portugal, with the new split and what you will sign',
    'screen-shop': 'Sell online screen: one payment address per VAT rate',
  };
  function select(tab, focus) {
    tabs.forEach((t) => { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    panel.setAttribute('aria-labelledby', tab.id);
    if (focus) tab.focus();
    const src = `assets/img/${tab.dataset.screen}.webp`;
    if (img.getAttribute('src') === src) return;
    const swap = () => { img.src = src; img.alt = ALTS[tab.dataset.screen] || ''; };
    if (reduce) { swap(); return; }
    img.classList.add('is-swapping');
    const pre = new Image();
    pre.src = src;
    pre.decode().catch(() => {}).then(() => setTimeout(() => { swap(); img.classList.remove('is-swapping'); }, 160));
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t, false));
    t.addEventListener('keydown', (e) => {
      const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); select(tabs[(i + d + tabs.length) % tabs.length], true); }
      if (e.key === 'Home') { e.preventDefault(); select(tabs[0], true); }
      if (e.key === 'End') { e.preventDefault(); select(tabs[tabs.length - 1], true); }
    });
  });

  /* Hero: the Kyros mark drawn by particles */
  const canvas = $('[data-particles]');
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    const MARK = [
      'M620.5 344A272 272 0 1 1 76.5 344A272 272 0 1 1 620.5 344Z',
      'M166.9 141.5H348.5A204 204 0 1 1 144.5 344',
      'M111.52 210.5H348.5A134 134 0 1 1 214.5 344',
      'M85.53 274.5H299.4A127.6 127.6 0 0 1 412.02 461.99',
      'M76.5 343.5H262A100 100 0 0 1 355.94 477.79',
    ];
    let W = 0, H = 0, dpr = 1, parts = [], raf = 0, visible = true, t0 = 0;
    const pointer = { x: -9999, y: -9999 };

    function targets(count, cx, cy, size) {
      const s = size / 565;
      const off = document.createElement('canvas');
      const R = 360;
      off.width = R; off.height = R;
      const o = off.getContext('2d');
      o.translate(R / 2, R / 2);
      o.scale(R / 600, R / 600);
      o.translate(-348.5, -344);
      o.lineWidth = 16; o.lineCap = 'round'; o.strokeStyle = '#fff';
      MARK.forEach((d) => o.stroke(new Path2D(d)));
      const px = o.getImageData(0, 0, R, R).data;
      const pts = [];
      for (let y = 0; y < R; y += 2) for (let x = 0; x < R; x += 2) if (px[(y * R + x) * 4 + 3] > 128) pts.push([x, y]);
      const out = [];
      for (let i = 0; i < count; i++) {
        const p = pts[Math.floor(Math.random() * pts.length)];
        out.push([cx + ((p[0] - R / 2) * (600 / R)) * s, cy + ((p[1] - R / 2) * (600 / R)) * s]);
      }
      return out;
    }

    function setup() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wide = W > 900;
      const size = wide ? Math.min(H * 0.78, W * 0.42, Math.max(300, W - 760)) : Math.min(W * 0.62, 270);
      const cx = wide ? Math.min(W * 0.74, W - size / 2 - Math.max(24, W * 0.03)) : W * 0.5;
      const cy = wide ? H * 0.52 : 92 + size / 2;
      const count = wide ? Math.round(Math.min(2200, Math.max(1200, (W * H) / 650))) : 900;
      const tg = targets(count, cx, cy, size);
      parts = tg.map(([tx, ty]) => {
        const a = Math.random() * Math.PI * 2;
        const r = Math.max(W, H) * (0.3 + Math.random() * 0.6);
        const warm = Math.random() < 0.09;
        return {
          tx, ty,
          x: reduce ? tx : cx + Math.cos(a) * r,
          y: reduce ? ty : cy + Math.sin(a) * r,
          vx: 0, vy: 0,
          r: 0.6 + Math.random() * 1.1,
          a: 0.35 + Math.random() * 0.6,
          ph: Math.random() * Math.PI * 2,
          c: warm ? '224,169,74' : '226,233,243',
        };
      });
      t0 = performance.now();
      draw(t0);
    }

    function draw(now) {
      ctx.clearRect(0, 0, W, H);
      const t = (now - t0) / 1000;
      const k = Math.min(1, t / 2.4);
      const stiff = 0.012 + 0.05 * k;
      for (const p of parts) {
        if (!reduce) {
          const wob = 1.4;
          const gx = p.tx + Math.cos(t * 0.8 + p.ph) * wob;
          const gy = p.ty + Math.sin(t * 0.9 + p.ph) * wob;
          p.vx += (gx - p.x) * stiff;
          p.vy += (gy - p.y) * stiff;
          const dx = p.x - pointer.x, dy = p.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 9000) { const f = (9000 - d2) / 9000 * 2.2; const d = Math.sqrt(d2) || 1; p.vx += (dx / d) * f; p.vy += (dy / d) * f; }
          p.vx *= 0.86; p.vy *= 0.86;
          p.x += p.vx; p.y += p.vy;
        }
        ctx.fillStyle = `rgba(${p.c},${p.a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!reduce && visible) raf = requestAnimationFrame(draw);
    }

    const hero = canvas.parentElement;
    hero.addEventListener('pointermove', (e) => { const b = canvas.getBoundingClientRect(); pointer.x = e.clientX - b.left; pointer.y = e.clientY - b.top; });
    hero.addEventListener('pointerleave', () => { pointer.x = pointer.y = -9999; });
    let rt = 0;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { cancelAnimationFrame(raf); setup(); }, 150); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((es) => {
        visible = es[0].isIntersecting;
        cancelAnimationFrame(raf);
        if (visible && !reduce) raf = requestAnimationFrame(draw);
      }).observe(canvas);
    }
    document.addEventListener('visibilitychange', () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && visible && !reduce) raf = requestAnimationFrame(draw);
    });
    setup();
  }

  /* Smooth scrolling */
  let lenis = null;
  if (!reduce) {
    lenis = new Lenis({ autoRaf: false, lerp: 0.1, anchors: false });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  function goTo(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return;
    if (lenis) lenis.scrollTo(el, { offset: el.id === 'top' ? 0 : -88, duration: 1.2 });
    else el.scrollIntoView();
  }
  $$('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length < 2 || !document.querySelector(id)) return;
    e.preventDefault();
    goTo(id);
    history.replaceState(null, '', id === '#top' ? location.pathname : id);
  }));

  /* Entrances and scroll reveals: content is visible without them */
  if (!reduce) {
    const rise = { yPercent: 105, duration: 1.05, ease: 'expo.out', stagger: 0.07 };
    const heroTitle = SplitText.create('#hero-title', { type: 'lines', mask: 'lines' });
    gsap.timeline({ delay: 0.15 })
      .from(heroTitle.lines, rise)
      .from('.hero-lead, .hero .actions, .hero-facts > div, .hero-note', { y: 18, opacity: 0, duration: 0.9, ease: 'expo.out', stagger: 0.06 }, 0.35);

    $$('main section:not(.hero) h2').forEach((h) => {
      const split = SplitText.create(h, { type: 'lines', mask: 'lines' });
      gsap.from(split.lines, { ...rise, scrollTrigger: { trigger: h, start: 'top 86%', once: true } });
    });
    const groups = ['.steps li', '.who-list article', '.pillars li', '.faq-list details', '.tabs [role="tab"]', '.split-copy .field', '.footer-grid > *'];
    groups.forEach((sel) => {
      const items = $$(sel);
      if (!items.length) return;
      gsap.from(items, { y: 28, opacity: 0, duration: 0.9, ease: 'expo.out', stagger: 0.08, scrollTrigger: { trigger: items[0], start: 'top 88%', once: true } });
    });
    $$('.split-result, .phone, .flow, .globe-wrap').forEach((el) => gsap.from(el, { y: 40, opacity: 0, duration: 1.1, ease: 'expo.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true } }));
    gsap.to('.phone', { yPercent: -6, ease: 'none', scrollTrigger: { trigger: '.product', start: 'top bottom', end: 'bottom top', scrub: true } });
  }

  /* The globe: one marker per jurisdiction */
  const COORDS = {
    ad: [42.51, 1.52], ae: [24.45, 54.38], ar: [-34.6, -58.38], au: [-35.28, 149.13], bh: [26.23, 50.59], bm: [32.3, -64.78],
    br: [-15.79, -47.88], bs: [25.05, -77.35], ca: [45.42, -75.7], ch: [46.95, 7.45], co: [4.71, -74.07], cy: [35.19, 33.38],
    de: [52.52, 13.4], ee: [59.44, 24.75], es: [40.42, -3.7], fr: [48.86, 2.35], gb: [51.51, -0.13], ge: [41.72, 44.79],
    hk: [22.32, 114.17], id: [-6.21, 106.85], ie: [53.35, -6.26], in: [28.61, 77.21], it: [41.9, 12.5], jp: [35.68, 139.69],
    ke: [-1.29, 36.82], kr: [37.57, 126.98], ky: [19.29, -81.37], li: [47.14, 9.52], lu: [49.61, 6.13], mc: [43.74, 7.42],
    mh: [7.09, 171.38], mt: [35.9, 14.51], mx: [19.43, -99.13], ng: [9.08, 7.4], nl: [52.37, 4.9], pa: [8.98, -79.52],
    ph: [14.6, 120.98], pk: [33.68, 73.05], pr: [18.47, -66.11], pt: [38.72, -9.14], sg: [1.35, 103.82], sv: [13.69, -89.22],
    th: [13.76, 100.5], tr: [39.93, 32.86], ua: [50.45, 30.52], us: [38.91, -77.04], vn: [21.03, 105.85], za: [-25.75, 28.19],
  };
  const angles = ([lat, lng]) => [Math.PI - ((lng * Math.PI) / 180 - Math.PI / 2), (lat * Math.PI) / 180];
  const globeCanvas = $('[data-globe]');
  const globeLabel = $('[data-globe-label]');
  let globeState = null;
  function focusGlobe(id) {
    if (!globeState || !COORDS[id]) return;
    const [phi, theta] = angles(COORDS[id]);
    globeState.target = [phi, theta * 0.8];
    globeState.focus = id;
    const c = countries.find((x) => x.id === id);
    if (globeLabel && c) globeLabel.textContent = nameOf(c);
  }
  if (globeCanvas) {
    let globe = null, raf = 0, on = false;
    const st = (globeState = { phi: angles(COORDS.es)[0], theta: 0.3, target: null, focus: null, drag: null, vel: 0 });
    const markers = () => Object.entries(COORDS).map(([id, loc]) => ({ location: loc, size: id === st.focus ? 0.075 : 0.035, color: id === st.focus ? [0.88, 0.66, 0.29] : [0.18, 0.29, 0.42] }));
    let lastFocus = null;
    function start() {
      const size = globeCanvas.clientWidth;
      if (!size) return;
      globe = createGlobe(globeCanvas, {
        devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2), width: size * 2, height: size * 2,
        phi: st.phi, theta: st.theta, dark: 0, diffuse: 1.2, mapSamples: 16000, mapBrightness: 5, mapBaseBrightness: 0,
        baseColor: [0.96, 0.97, 0.98], markerColor: [0.18, 0.29, 0.42], glowColor: [0.93, 0.95, 0.98], markers: markers(),
        opacity: 0.95,
      });
    }
    function frame() {
      if (st.target) {
        let dp = st.target[0] - st.phi;
        dp = ((dp + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        st.phi += dp * 0.08;
        st.theta += (st.target[1] - st.theta) * 0.08;
      } else if (!st.drag && !reduce) {
        st.phi += 0.0025 + st.vel;
        st.vel *= 0.95;
      }
      const upd = { phi: st.phi, theta: st.theta };
      if (lastFocus !== st.focus) { upd.markers = markers(); lastFocus = st.focus; }
      if (globe) globe.update(upd);
      raf = on ? requestAnimationFrame(frame) : 0;
    }
    globeCanvas.addEventListener('pointerdown', (e) => { st.drag = { x: e.clientX, phi: st.phi }; st.target = null; globeCanvas.setPointerCapture(e.pointerId); });
    globeCanvas.addEventListener('pointermove', (e) => { if (st.drag) { const dx = e.clientX - st.drag.x; st.phi = st.drag.phi + dx / 160; st.vel = 0; } });
    const end = (e) => { if (st.drag) { st.vel = Math.max(-0.04, Math.min(0.04, (e.movementX || 0) / 600)); st.drag = null; } };
    globeCanvas.addEventListener('pointerup', end);
    globeCanvas.addEventListener('pointercancel', end);
    $('[data-regions]').addEventListener('pointerleave', () => { st.target = null; });
    const io = new IntersectionObserver((es) => {
      on = es[0].isIntersecting;
      if (on && !globe) start();
      if (on && !raf) raf = requestAnimationFrame(frame);
    }, { rootMargin: '200px' });
    io.observe(globeCanvas);
    let rt = 0;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (globe) { globe.destroy(); globe = null; lastFocus = undefined; if (on) start(); } }, 200); }).observe(globeCanvas);
  }
})();
