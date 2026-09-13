/* Uno Momento — print renderer.
 *
 * The old version drew the customer's photo as a plain <img> on top of a
 * garment photo. It read as a sticker because it was one: flat, unlit, and
 * indifferent to the fabric underneath.
 *
 * This draws the print the way a mockup actually works, in four passes on a
 * canvas:
 *
 *   1. WARP      Each destination pixel samples the artwork at an offset taken
 *                from the garment's displacement map, so the print bends into
 *                folds instead of lying across them.
 *   2. SHADE     The garment's own luminance is multiplied over the print, so
 *                creases darken it and highlights catch it.
 *   3. WEAVE     A little fabric grain, so it reads as ink on cotton.
 *   4. INK       Slight opacity and edge softening — screen printing is never
 *                a perfect hard-edged rectangle.
 *
 * All maps are precomputed by build_mock.py. The render is a single pass over
 * the print area only (not the whole garment), which keeps it fast enough to
 * run on every drag frame on a phone.
 */

const Mock = (() => {
  const cache = {};           // colour -> {base, disp, light, weave} ImageData
  let META = null;
  const genOf = new WeakMap();   // output canvas -> its own generation                // guards against out-of-order paints

  function loadImg(src) {
    return new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('load failed: ' + src));
      i.src = src;
    });
  }

  async function meta() {
    if (!META) META = await fetch('img/mock/mock.json').then(r => r.json());
    return META;
  }

  /* Pull the maps for one colourway once, as pixel data at print-area size. */
  async function maps(color, W, H, zoneKey) {
    const key = color + ':' + W + 'x' + H + ':' + (zoneKey || 'zone');
    if (cache[key]) return cache[key];
    const m = await meta();
    const z = m[zoneKey || 'zone'];

    const [disp, light, weave] = await Promise.all([
      loadImg(`img/mock/${color}-disp.webp`),
      loadImg(`img/mock/${color}-light.webp`),
      loadImg(`img/mock/${color}-weave.webp`)
    ]);

    // crop each map to the print zone and scale to the render size
    const grab = (img) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img,
        z.x * img.naturalWidth, z.y * img.naturalHeight,
        z.w * img.naturalWidth, z.h * img.naturalHeight,
        0, 0, W, H);
      return g.getImageData(0, 0, W, H).data;
    };

    cache[key] = { disp: grab(disp), light: grab(light), weave: grab(weave) };
    return cache[key];
  }

  /* Draw the artwork into an offscreen canvas at print-area resolution,
     honouring the customer's placement (centre, scale, rotation).
     The scratch canvas and the output buffer are reused across frames — a
     fresh canvas + ImageData per frame is the single biggest avoidable cost
     in a drag loop. */
  let scratch = null, scratchG = null, outBuf = null;
  /* How the artwork meets the garment. Each preset is a different real print
     treatment, not a filter. */
  /* Print orientations. The value is the frame's height/width ratio; the photo
     is centre-cropped to fill it (cover), never squashed. 'free' keeps the
     photo's own shape. */
  const ORIENT = {
    free:      null,
    square:    1,
    portrait:  1.25,   // 4:5, the classic photo print
    landscape: 0.667   // 3:2, a wide frame
  };

  const FITS = {
    torn:    { round: 0,    fade: 0,    desat: 0.45, paper: 0.075, tear: 0.055 },
    square:  { round: 0,    fade: 0,    desat: 0.45 },  // straight cut, hard edge
    soft:    { round: 0.03, fade: 0.10, desat: 0.45 },  // gently eased corners
    faded:   { round: 0,    fade: 0.28, desat: 0.62, lo: 0.18, hi: 0.88 },  // washed
    circle:  { round: 0.5,  fade: 0.04, desat: 0.45 },  // punched circle
    arch:    { round: 0,    fade: 0.06, desat: 0.45, arch: true }
  };

  /* ---- the ink press -------------------------------------------------------
     Measured off Uno Momento's OWN garments, not guessed. Inside a real print:

         marley  sat 0.095   tonal range 133   grain 12-13
         tee     sat 0.315   tonal range 181   grain 12-13

     while the source photo the customer uploads sits at sat 0.41, range 198+,
     with true 0-black. That gap is why the Studio print read as a photograph
     pasted onto a shirt rather than ink pressed into it. Three things close it:

       DESAT  water-based ink on cotton never holds a screen's saturation.
       LO/HI  cotton has no paper-white and no ink-black. Compressing into
              [0.12, 0.91] is the single biggest contributor — full blacks are
              what make a digital image look backlit.
       DOT    a 45-degree clustered-dot halftone, modulated by midtone weight
              (the extremes of a screen print carry almost no dot structure).

     Verified offline in Pillow against real crops before any of it ran in the
     browser: desat 0.45 lands at sat 0.103 vs the real garment's 0.095. */
  const INK = { lo: 0.12, hi: 0.91, amp: 12, perCell: 135 };

  /* The halftone screen is registered to the PRINT, not to the artwork, so it
     is a pure function of the canvas size — build it once per size and reuse.
     Indexing it by destination x,y (never by the warped source) also stops the
     dots shimmering while the customer drags. */
  const screenCache = {};
  function halftone(W, H) {
    const key = W + 'x' + H;
    if (screenCache[key]) return screenCache[key];
    const cell = Math.max(1.6, W / INK.perCell);
    const out = new Float32Array(W * H);
    const c = Math.SQRT1_2, TAU = Math.PI * 2;   // 45 degrees
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x * c + y * c) / cell, v = (-x * c + y * c) / cell;
        // amplitude is baked in here so the hot loop does one multiply, not two
        out[y * W + x] = (Math.cos(u * TAU) + Math.cos(v * TAU)) * 0.5 * INK.amp;
      }
    }
    screenCache[key] = out;
    return out;
  }

  /* ---- ink coverage: why a real print is not a flat slab --------------------
     Measured on Uno Momento's OWN garment (tee-black-print.webp), the white
     paper margin of a real screen print runs L mean 191 with sd 22.5
     (p10 156, p90 217) -- the laydown is BLOTCHY. Coverage varies over a few
     millimetres and wherever it thins the cotton reads straight through.
     The Studio painted that same margin at L 199-203 sd 3.7-5.2: a perfectly
     uniform slab, which is precisely what a paper card glued to a shirt looks
     like, and the loudest remaining "pasted" tell once the torn edge was in.

     Modelled as an ALPHA modulation, which is the physically honest way round:
     less ink means more garment showing through, on whatever colourway happens
     to be underneath, and the fabric's own folds and shadow come through the
     thin patches for free. Two octaves -- a broad uneven pull plus the cotton
     tooth biting the thin edges of the laydown -- shaped by pow() so the print
     is mostly solid with a minority of thin patches rather than uniformly
     grey. Indexed by DESTINATION x,y (never the warped source coordinate) so
     the blotches belong to the PRINT and do not crawl while the customer
     drags, exactly as the halftone screen is. Pure function of canvas size,
     therefore built once per size and cached. */
  const COV = { depth: 0.52, shape: 2.3, blotch: 0.052, tooth: 0.0115, fine: 0.30, stampScale: 0.42 };
  const covCache = {};

  function coverage(W, H) {
    const key = W + 'x' + H;
    if (covCache[key]) return covCache[key];

    let st = 0x6B7F1A3D;                       // fixed seed: the blotches are a
    const rnd = () => {                        // property of the garment, so they
      st |= 0; st = st + 0x6D2B79F5 | 0;       // must be stable across renders
      let t = Math.imul(st ^ st >>> 15, 1 | st);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };

    const base = Math.max(W, H);
    const n1 = valueNoise(W, H, Math.max(3, base * COV.blotch), rnd);
    const n2 = valueNoise(W, H, Math.max(2, base * COV.tooth), rnd);

    const n = W * H;
    const raw = new Float32Array(n);
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < n; i++) {
      const v = n1[i] * (1 - COV.fine) + n2[i] * COV.fine;
      raw[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const span = Math.max(1e-6, hi - lo);

    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // 0 = thickest laydown, 1 = thinnest. pow() keeps the print mostly solid.
      const t = Math.pow((raw[i] - lo) / span, COV.shape);
      out[i] = 1 - COV.depth * t;
    }
    covCache[key] = out;
    return out;
  }

  /* ---- the torn photo-paper edge -------------------------------------------
     The real Uno Momento garments do not carry a clean rectangle: the print is
     a photo sitting on a white paper margin whose border is TORN, the way an
     old screen print flakes. A razor rectangle was the loudest remaining
     "pasted" tell in the Studio, and the one finish the brand actually sells
     was the one finish the customiser could not produce.

     Built from coherent value noise raced against distance-from-edge: where the
     noise beats the edge distance the ink is gone. Three octaves so the tears
     have big bites AND fine crumbs; corners bite deeper (they always do on a
     real garment); a handful of surviving flecks sit outside the tear line.
     The tear band is confined to the white margin so the photograph itself is
     never eaten. Cached per size+seed, since it is far too slow per drag frame. */
  const tornCache = {};

  function valueNoise(W, H, cell, rnd) {
    const gw = Math.max(2, Math.ceil(W / cell) + 2);
    const gh = Math.max(2, Math.ceil(H / cell) + 2);
    const g = new Float32Array(gw * gh);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    const out = new Float32Array(W * H);
    const sx = (gw - 1) / W, sy = (gh - 1) / H;
    const sm = t => t * t * (3 - 2 * t);          // smoothstep, so no grid seams
    for (let y = 0; y < H; y++) {
      const fy = y * sy, y0 = Math.floor(fy), ty = sm(fy - y0);
      const y1 = Math.min(gh - 1, y0 + 1);
      for (let x = 0; x < W; x++) {
        const fx = x * sx, x0 = Math.floor(fx), tx = sm(fx - x0);
        const x1 = Math.min(gw - 1, x0 + 1);
        const a = g[y0 * gw + x0] + (g[y0 * gw + x1] - g[y0 * gw + x0]) * tx;
        const b = g[y1 * gw + x0] + (g[y1 * gw + x1] - g[y1 * gw + x0]) * tx;
        out[y * W + x] = a + (b - a) * ty;
      }
    }
    return out;
  }

  function boxBlur(src, W, H, r) {
    const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
    const win = 2 * r + 1;
    const cl = (v, m) => v < 0 ? 0 : (v > m ? m : v);
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * W + cl(x, W - 1)];
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = acc / win;
        acc -= src[y * W + cl(x - r, W - 1)];
        acc += src[y * W + cl(x + r + 1, W - 1)];
      }
    }
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[cl(y, H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = acc / win;
        acc -= tmp[cl(y - r, H - 1) * W + x];
        acc += tmp[cl(y + r + 1, H - 1) * W + x];
      }
    }
    return out;
  }

  function tornMask(W, H, band, seed) {
    const key = W + "x" + H + ":" + band.toFixed(4) + ":" + seed;
    if (tornCache[key]) return tornCache[key];

    let st = (seed >>> 0) || 1;
    const rnd = () => {                            // mulberry32, so the tear is
      st |= 0; st = st + 0x6D2B79F5 | 0;           // stable across every render
      let t = Math.imul(st ^ st >>> 15, 1 | st);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };

    const base = Math.max(W, H);
    const B = Math.max(3, base * band);
    const c0 = base / 8.0;
    const n1 = valueNoise(W, H, c0, rnd);
    const n2 = valueNoise(W, H, c0 / 2.4, rnd);
    const n3 = valueNoise(W, H, c0 / 5.6, rnd);
    const nf = valueNoise(W, H, base / 60.0, rnd);

    const raw = new Float32Array(W * H);
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < raw.length; i++) {
      const v = n1[i] * 0.60 + n2[i] * 0.27 + n3[i] * 0.13;
      raw[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const span = Math.max(1e-6, hi - lo);

    const a = new Float32Array(W * H);
    const cR = base * 0.18;
    for (let y = 0; y < H; y++) {
      const dy = Math.min(y, H - 1 - y);
      const cy = 1 - Math.min(1, dy / cR);
      for (let x = 0; x < W; x++) {
        const dx = Math.min(x, W - 1 - x);
        const i = y * W + x;
        const d = Math.min(dx, dy);
        const e = Math.min(1, d / B);
        let v = (raw[i] - lo) / span;
        v = Math.pow(v, 1.5);
        v *= 1 + (1 - Math.min(1, dx / cR)) * cy * 0.7;   // corners tear deeper
        let on = v > e ? 0 : 1;
        if (!on && nf[i] > 0.945 && d < B * 1.5) on = 1;  // a surviving ink fleck
        a[i] = on;
      }
    }

    // feather only the cut, so it reads as ink rather than a stencil
    const r = Math.max(1, Math.round(base * 0.0032));
    const blurred = boxBlur(boxBlur(a, W, H, r), W, H, r);
    tornCache[key] = blurred;
    return blurred;
  }

  /* The tear is built ONCE at a canonical resolution per aspect ratio and then
     scaled with destination-in. Building it at the card's live pixel size meant
     every step of the size slider was a cold mask: measured 91.5ms per frame at
     4x CPU throttle. Bucketed by ratio it is a cached drawImage: ~0ms. */
  const MASK_LONG = 260;
  const maskCanvases = {};

  function tornMaskCanvas(w, h, band, seed) {
    const ratio = h / w;
    const bucket = Math.round(ratio * 24) / 24;              // 24 ratio buckets
    const key = bucket.toFixed(3) + ":" + band.toFixed(4) + ":" + seed;
    if (maskCanvases[key]) return maskCanvases[key];

    let MW, MH;
    if (bucket >= 1) { MH = MASK_LONG; MW = Math.max(8, Math.round(MASK_LONG / bucket)); }
    else             { MW = MASK_LONG; MH = Math.max(8, Math.round(MASK_LONG * bucket)); }

    const m = tornMask(MW, MH, band, seed);
    const c = document.createElement("canvas");
    c.width = MW; c.height = MH;
    const g = c.getContext("2d");
    const id = g.createImageData(MW, MH);
    for (let i = 0, n = MW * MH; i < n; i++) {
      const a = (m[i] * 255) | 0;
      id.data[i * 4] = 255; id.data[i * 4 + 1] = 255;
      id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = a;
    }
    g.putImageData(id, 0, 0);
    maskCanvases[key] = c;
    return c;
  }

  /* Render the artwork as a torn photo card into its own canvas, which the
     caller then draws (and rotates) like any other art layer. */
  let cardC = null, cardG = null;
  function tornCard(art, w, h, sx, sy, sw, sh, f) {
    w = Math.max(8, Math.round(w)); h = Math.max(8, Math.round(h));
    // reuse the card canvas across frames — a fresh one per drag frame is pure
    // GC pressure, the same trap the scratch canvas already avoids
    if (!cardC) { cardC = document.createElement("canvas"); cardG = cardC.getContext("2d"); }
    if (cardC.width !== w || cardC.height !== h) { cardC.width = w; cardC.height = h; }
    const c = cardC, g = cardG;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, w, h);
    const P = Math.round(Math.min(w, h) * (f.paper || 0.075));
    /* NOT screen white. Measured inside the white margin of the brand's own
       printed tee: L mean 191, p90 217 -- white plastisol on cotton is a good
       deal duller than #fff, and painting it at 245 was a "pasted paper card"
       tell all by itself. #ddd8cd sits at L 217, and the coverage map then
       pulls it down toward the measured mean. */
    g.fillStyle = "#ddd8cd";
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = "high";
    g.drawImage(art, sx, sy, sw, sh, P, P, Math.max(1, w - 2 * P), Math.max(1, h - 2 * P));

    g.globalCompositeOperation = "destination-in";
    g.drawImage(tornMaskCanvas(w, h, f.tear || 0.055, 20260908), 0, 0, w, h);
    g.globalCompositeOperation = "source-over";
    return c;
  }

  /* Shape the artwork's alpha according to the chosen fit. Everything is done
     on the offscreen layer so the warp/shade passes treat it as one print. */
  function shapeLayer(g, W, H, x, y, w, h, fit) {
    const f = FITS[fit] || FITS.square;
    g.globalCompositeOperation = 'destination-in';

    if (f.arch) {
      // rounded at the top like an arch, straight at the bottom
      const r = Math.min(w, h) * 0.5;
      g.beginPath();
      g.moveTo(x, y + h);
      g.lineTo(x, y + r);
      g.arc(x + w / 2, y + r, r, Math.PI, 0);
      g.lineTo(x + w, y + h);
      g.closePath();
      g.fillStyle = '#fff';
      g.fill();
    } else if (f.round > 0) {
      const r = Math.min(w, h) * f.round;
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r);
      else g.rect(x, y, w, h);
      g.fillStyle = '#fff';
      g.fill();
    } else {
      g.fillStyle = '#fff';
      g.fillRect(x, y, w, h);
    }

    if (f.fade > 0) {
      // feather the edge inward — a washed print has no hard border
      g.globalCompositeOperation = 'destination-out';
      const inset = Math.min(w, h) * f.fade;
      const grad = g.createLinearGradient(x, 0, x + inset, 0);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(x, y, inset, h);
      const g2 = g.createLinearGradient(x + w, 0, x + w - inset, 0);
      g2.addColorStop(0, 'rgba(0,0,0,1)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = g2; g.fillRect(x + w - inset, y, inset, h);
      const g3 = g.createLinearGradient(0, y, 0, y + inset);
      g3.addColorStop(0, 'rgba(0,0,0,1)'); g3.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = g3; g.fillRect(x, y, w, inset);
      const g4 = g.createLinearGradient(0, y + h, 0, y + h - inset);
      g4.addColorStop(0, 'rgba(0,0,0,1)'); g4.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = g4; g.fillRect(x, y + h - inset, w, inset);
    }
    g.globalCompositeOperation = 'source-over';
  }

  function layout(art, W, H, p) {
    if (!scratch || scratch.width !== W || scratch.height !== H) {
      scratch = document.createElement('canvas');
      scratch.width = W; scratch.height = H;
      scratchG = scratch.getContext('2d', { willReadFrequently: true });
      outBuf = null;                        // size changed, drop the old buffer
    }
    const c = scratch;
    const g = scratchG;
    g.clearRect(0, 0, W, H);

    // p.scale is relative to the print area's width. The orientation decides
    // the FRAME's shape; the photo is cropped to cover it so nothing distorts.
    const natural = art.naturalHeight / art.naturalWidth;
    const ratio = ORIENT[p.orient || 'free'] || natural;
    const aw = W * p.scale;
    const ah = aw * ratio;

    // source rect: centre-crop the photo to the frame's aspect (cover)
    const sW = art.naturalWidth, sH = art.naturalHeight;
    let sx = 0, sy = 0, sw = sW, sh = sH;
    if (Math.abs(ratio - natural) > 0.001) {
      if (natural > ratio) {            // photo taller than frame -> trim top/bottom
        sh = sW * ratio; sy = (sH - sh) / 2;
      } else {                          // photo wider than frame -> trim sides
        sw = sH / ratio; sx = (sW - sw) / 2;
      }
    }

    g.save();
    g.translate(p.cx * W, p.cy * H);
    g.rotate((p.rot || 0) * Math.PI / 180);
    g.imageSmoothingQuality = "high";
    const ff = FITS[p.fit] || FITS.square;
    if (ff.paper) {
      // the torn photo card is built at its own size, then placed like any art
      g.drawImage(tornCard(art, aw, ah, sx, sy, sw, sh, ff), -aw / 2, -ah / 2, aw, ah);
    } else {
      g.drawImage(art, sx, sy, sw, sh, -aw / 2, -ah / 2, aw, ah);
      shapeLayer(g, W, H, -aw / 2, -ah / 2, aw, ah, p.fit);
    }
    g.restore();
    return g.getImageData(0, 0, W, H);
  }

  /* Draw the location stamp — the brand's signature: logo, place, date, time,
     stacked and centred, the way it is printed on the real garments. Rendered
     into the same offscreen canvas so it goes through the identical
     warp/shade/weave passes as a photo print. */
  function stampLayout(W, H, txt, ink) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, W, H);

    const unit = H / 100;
    /* No print shop pulls white ink onto a cream garment. Measured on our own
       back photos, screen-white on `cream` reaches 1.18:1 against the fabric
       and on `tee-cream` 1.29:1 — the brand's signature was, literally, not
       visible. The ink colour is chosen per garment in mock.json (whichever of
       the off-white or the warm near-black wins on contrast) and the worst
       colourway now measures 4.77:1. Never pure #fff either: plastisol is a
       shade off-white and screen-white is a "pasted" tell of its own. */
    g.fillStyle = ink || '#f4f1ea';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // the logo mark: a filled circle with a leaf-shaped cut, drawn not fetched
    const r = unit * 11;
    const cx = W / 2, cyTop = unit * 16;
    g.beginPath(); g.arc(cx, cyTop, r, 0, Math.PI * 2); g.fill();
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath();
    g.ellipse(cx, cyTop, r * 0.62, r * 0.30, -Math.PI / 4, 0, Math.PI * 2);
    g.fill();
    g.restore();

    // Only the lines the customer actually filled in. Dropping the timestamp is
    // a real choice, so the remaining block has to re-centre rather than sit
    // top-heavy where the date used to be.
    const lines = [
      { t: txt.place, s: unit * 15, w: 700 },
      { t: txt.date,  s: unit * 13, w: 500 },
      { t: txt.time,  s: unit * 13, w: 500 }
    ].filter(l => l.t);

    const blockH = lines.reduce((a, l) => a + l.s * 1.22, 0);
    const avail = H - (cyTop + r);              // space under the mark
    let y = cyTop + r + (avail - blockH) / 2 + (lines.length ? lines[0].s * 0.5 : 0);

    for (const ln of lines) {
      g.font = `${ln.w} ${ln.s}px Archivo, system-ui, sans-serif`;
      g.fillText(ln.t, cx, y);
      y += ln.s * 1.22;
    }
    return g.getImageData(0, 0, W, H);
  }

  /**
   * Composite the print onto the garment.
   * @param {HTMLCanvasElement} out   canvas sized to the print AREA
   * @param {HTMLImageElement}  art   the customer's photo
   * @param {string} color            colourway key
   * @param {object} p                {cx, cy, scale, rot} in print-area fractions
   */
  /* Renders are SERIALISED. The scratch canvas and output buffer are reused
     between frames (allocating them per frame is heavy GC churn), which means
     two renders running at once will clobber each other's pixels: the stamp
     render resized the shared buffers mid-flight and the print came out empty.
     One at a time, in order. */
  let chain = Promise.resolve();
  function render(out, art, color, p) {
    const run = () => renderNow(out, art, color, p);
    chain = chain.then(run, run);
    return chain;
  }

  async function renderNow(out, art, color, p) {
    /* Generation is PER OUTPUT CANVAS. A single shared counter meant a stamp
       render (a different canvas entirely) bumped `gen` and made the in-flight
       print render cancel itself — every garment switch left a blank chest. */
    const myGen = (genOf.get(out) || 0) + 1;
    genOf.set(out, myGen);
    const W = out.width, H = out.height;
    const M = await maps(color, W, H, p && p.zone);
    if (myGen !== genOf.get(out)) return;   // a newer render of THIS canvas started
    const src = (p && p.stamp)
      ? stampLayout(W, H, p.stamp, (p.ink || (META && META.stampInk &&
          META.stampInk[String(color).replace(/-back$/, '')]) || (META && META.stampInkDefault)))
      : layout(art, W, H, p);
    // A razor-sharp border is the loudest "pasted on" tell. Blur the alpha
    // channel only, so the ink edge spreads a hair like real screen printing.
    const soft = softAlpha(src, W, H);
    if (!outBuf || outBuf.width !== W || outBuf.height !== H) {
      outBuf = out.getContext('2d').createImageData(W, H);
    }
    const dst = outBuf;
    const S = src.data, D = dst.data;
    const { disp, light, weave } = M;

    const AMP = Math.max(3, Math.round(W * 0.045));   // fold warp strength, px
    const F = FITS[p && p.fit] || FITS.square;
    const DESAT = F.desat || 0;
    // The back stamp is a solid ink mark, not a photograph: it must not be
    // tone-compressed or screened or it turns into a grey smudge.
    const isStamp = !!(p && p.stamp);
    const LO   = (F.lo != null ? F.lo : INK.lo) * 255;
    const SPAN = (F.hi != null ? F.hi : INK.hi) - (F.lo != null ? F.lo : INK.lo);
    const SCR  = isStamp ? null : halftone(W, H);
    const CVR  = coverage(W, H);
    const COVLO = 0.34, COVHI = 0.66;   // show-through vs ink density
    // The stamp is a small solid mark that must stay legible; a photograph can
    // carry the full uneven laydown.
    const COVS = isStamp ? COV.stampScale : 1;

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;

        // --- 1. warp: sample the artwork where the fold pushes it ----------
        // central difference on the displacement map = local slope
        const xm = Math.max(0, x - 2), xp = Math.min(W - 1, x + 2);
        const ym = Math.max(0, y - 2), yp = Math.min(H - 1, y + 2);
        const gx = (disp[(y * W + xp) * 4] - disp[(y * W + xm) * 4]) / 255;
        const gy = (disp[(yp * W + x) * 4] - disp[(ym * W + x) * 4]) / 255;

        let sx = Math.round(x - gx * AMP);
        let sy = Math.round(y - gy * AMP);
        sx = sx < 0 ? 0 : (sx >= W ? W - 1 : sx);
        sy = sy < 0 ? 0 : (sy >= H ? H - 1 : sy);
        const j = (sy * W + sx) * 4;

        const a = soft[sy * W + sx];        // softened alpha, warped with the art
        if (a === 0) { D[i] = D[i+1] = D[i+2] = D[i+3] = 0; continue; }

        // --- 2. shade: OVERLAY, not multiply -------------------------------
        // A multiply can only darken (k maxes at 1.0), so highlights on fold
        // ridges never lifted the ink and the print read flat. Overlay both
        // darkens in creases and brightens on ridges.
        const Lv = light[i] / 255;
        // STR pulls the effect back toward neutral so it reads as fabric, not
        // a filter. 1 = full overlay, 0 = untouched.
        const STR = 0.72;

        // --- 3. weave: fine grain, signed around zero ----------------------
        const wv = (weave[i] - 128) * 0.22;   // cotton grain

        // --- 1b. INK PRESS: desaturate, compress the tonal range, screen ---
        let r0 = S[j], g0 = S[j + 1], b0 = S[j + 2];
        if (DESAT > 0) {
          const lum = 0.299 * r0 + 0.587 * g0 + 0.114 * b0;
          r0 += (lum - r0) * DESAT;
          g0 += (lum - g0) * DESAT;
          b0 += (lum - b0) * DESAT;
        }
        if (!isStamp) {
          // clustered-dot halftone, carried by the midtones only
          const mid = 1 - Math.abs((r0 + g0 + b0) * 0.00261438 - 1);   // /382.5
          const dg = SCR[y * W + x] * mid;
          r0 += dg; g0 += dg; b0 += dg;
        }
        /* Tone compression is the LAST step, after the fabric overlay.
           Applied before it, the overlay on a dark garment multiplied the
           lifted black point straight back down (measured: range stayed 200
           against the real garments' 133-181). Ink sits on top of the cloth,
           so its floor and ceiling are what the eye actually reads. */
        if (isStamp) {
          D[i]     = clamp(mix(r0, Lv, STR) + wv);
          D[i + 1] = clamp(mix(g0, Lv, STR) + wv);
          D[i + 2] = clamp(mix(b0, Lv, STR) + wv);
        } else {
          D[i]     = clamp(LO + (mix(r0, Lv, STR) + wv) * SPAN);
          D[i + 1] = clamp(LO + (mix(g0, Lv, STR) + wv) * SPAN);
          D[i + 2] = clamp(LO + (mix(b0, Lv, STR) + wv) * SPAN);
        }
        // --- 4. ink: screen print is not fully opaque, and NOT evenly laid --
        // COV is indexed by destination so the blotches sit still while the
        // art is dragged underneath them, the same rule as the halftone.
        //
        // Weighted by ink DENSITY, which is what a press actually does: the
        // pale paper margin is a single thin film of white and shows the most
        // fabric through, while a dark passage of the photograph is a heavy
        // deposit that covers. Applying one flat coverage figure everywhere
        // pulled rust-brown fabric up through the faces and read as a dirty
        // smudge rather than a print. Weighted, the margin keeps its full
        // blotch and the shadows stay solid.
        const dens = COVLO + COVHI * (0.299 * r0 + 0.587 * g0 + 0.114 * b0) * 0.00392157;
        D[i + 3] = a * 0.94 * (1 - (1 - CVR[y * W + x]) * COVS * dens);
      }
    }
    if (myGen !== genOf.get(out)) return;              // don't paint stale pixels
    const g = out.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.putImageData(dst, 0, 0);
  }

  function clamp(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

  /* Overlay blend of one channel against the garment's luminance, eased back
     toward the original by (1 - strength). */
  function mix(ch, Lv, strength) {
    const b = ch / 255;
    const o = Lv < 0.5 ? (2 * b * Lv) : (1 - 2 * (1 - b) * (1 - Lv));
    return (b + (o - b) * strength) * 255;
  }

  /* Separable box blur over the alpha channel — cheap, and enough to take the
     mechanical edge off. Radius scales with size so it looks the same on any
     display. */
  function softAlpha(img, W, H) {
    const src = img.data;
    const a = new Float32Array(W * H);
    for (let i = 0, p = 0; i < src.length; i += 4, p++) a[p] = src[i + 3];
    const r = Math.max(1, Math.round(W * 0.006));
    const tmp = new Float32Array(W * H);
    const n = r * 2 + 1;
    for (let y = 0; y < H; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[y * W + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        tmp[y * W + x] = sum / n;
        const out_ = a[y * W + Math.min(W - 1, Math.max(0, x - r))];
        const in_ = a[y * W + Math.min(W - 1, Math.max(0, x + r + 1))];
        sum += in_ - out_;
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / n;
        const out_ = tmp[Math.min(H - 1, Math.max(0, y - r)) * W + x];
        const in_ = tmp[Math.min(H - 1, Math.max(0, y + r + 1)) * W + x];
        sum += in_ - out_;
      }
    }
    return a;
  }

  return { render, meta };
})();
