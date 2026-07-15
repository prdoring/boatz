// Brush-ink renderer for character art. The engine's drawUnifiedArt draws uniform
// stroked polylines; this re-interprets the (small, flat) character-art shape set
// and renders each stroke as a TAPERED filled ribbon (thin → thick → thin) with
// ink "splops" pooling at sharp corners and stroke ends, plus a faint hand-wobble.
// Result: hand-inked line-art instead of mechanical lines. Used only by
// PortraitRenderer (captain portraits), so it never touches the engine.

const TAU = Math.PI * 2;

// Evaluate the tiny angle expressions the art uses ("PI", "2*PI", "PI*1.05", …).
function evalAngle(s) {
  if (typeof s === 'number') return s;
  return String(s).replace(/PI/g, String(Math.PI)).split('*').reduce((a, b) => a * parseFloat(b), 1);
}

// Stable per-point hash → tiny deterministic wobble (no per-frame shimmer).
function hash(x, y, s) {
  const h = Math.sin(x * 12.9898 + y * 78.233 + s * 37.719) * 43758.5453;
  return (h - Math.floor(h)) - 0.5;
}

export function dab(ctx, x, y, rad, color) {
  rad = Math.max(0.5, rad);
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
  // a smaller offset lobe makes the pool read as organic ink, not a dot
  ctx.beginPath(); ctx.arc(x + rad * 0.35, y - rad * 0.2, rad * 0.7, 0, TAU); ctx.fill();
}

// Render a polyline as a tapered ink ribbon. `closed` rings get a calligraphic
// (pen-angle) weight variation instead of end taper.
export function brush(ctx, pts, color, maxW, closed) {
  const n = pts.length;
  if (n === 1) { dab(ctx, pts[0][0], pts[0][1], maxW * 0.6, color); return; }

  const widthAt = (i) => {
    if (closed) return maxW * (0.55 + 0.45 * Math.abs(Math.sin((i / n) * TAU + 0.9))); // pen drag
    const t = i / (n - 1);
    return maxW * (0.18 + 0.82 * Math.pow(Math.sin(Math.PI * t), 0.5)); // taper both ends
  };

  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const pa = closed || i > 0 ? a : p;
    const pb = closed || i < n - 1 ? b : p;
    let dx = pb[0] - pa[0], dy = pb[1] - pa[1];
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const nx = -dy, ny = dx, w = widthAt(i) / 2;
    left.push([p[0] + nx * w, p[1] + ny * w]);
    right.push([p[0] - nx * w, p[1] - ny * w]);
  }

  ctx.fillStyle = color;
  if (closed) {
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(left[i][0], left[i][1]);
    ctx.closePath();
    ctx.moveTo(right[0][0], right[0][1]);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill('evenodd');
  } else {
    ctx.beginPath();
    ctx.moveTo(left[0][0], left[0][1]);
    for (let i = 1; i < n; i++) ctx.lineTo(left[i][0], left[i][1]);
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    ctx.fill();
    // a little ink build-up where the stroke begins
    dab(ctx, pts[0][0], pts[0][1], maxW * 0.3, color);
  }

  // pools at sharp corners
  const lo = closed ? 0 : 1, hi = closed ? n : n - 1;
  for (let i = lo; i < hi; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const v1x = b[0] - a[0], v1y = b[1] - a[1], v2x = c[0] - b[0], v2y = c[1] - b[1];
    const ang = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
    if (ang > 0.6) dab(ctx, b[0], b[1], widthAt(i) * (0.5 + ang / Math.PI * 0.6), color);
  }
}

// Catmull-Rom: turn a sparse set of authored points into a flowing curve, so paths
// read as drawn ink rather than angular polylines. Works for open + closed shapes.
export function smoothPts(pts, closed, sub = 7) {
  const n = pts.length;
  if (n < 3) return pts;
  const get = (i) => (closed ? pts[((i % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let j = 0; j < sub; j++) {
      const t = j / sub, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

function effective(shape, state) {
  if (shape.visibleStates && !shape.visibleStates.includes(state)) return null;
  if (shape.states && shape.states[state]) {
    return { ...shape, ...shape.states[state], setup: { ...shape.setup, ...(shape.states[state].setup || {}) } };
  }
  return shape;
}

const ROLE_FALLBACK = '#3a2a18';
const OCCLUDE_TINT = 0.2; // how far an occluder's paper fill leans toward its ink colour

// Blend two #rrggbb colours (t = 0 → a, t = 1 → b).
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  if (Number.isNaN(pa) || Number.isNaN(pb)) return a;
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255;
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}

// `colors` is either a single CSS string (legacy: every shape that colour) or a
// role→colour map (e.g. a scheme's roles). A shape's `role` selects its ink; an
// unknown/absent role falls back to the map's `ink`, then a safe default. This is
// the seam that lets one character carry skin / cloth / metal inks at once.
function makeResolver(colors) {
  if (colors && typeof colors === 'object') {
    return (role) => colors[role] || colors.ink || ROLE_FALLBACK;
  }
  const flat = colors || ROLE_FALLBACK;
  return () => flat;
}

/** Drop-in for drawUnifiedArt, restricted to the character-art shape set. */
export function inkDraw(ctx, r, colors, def, state, _now) {
  if (!def || !Array.isArray(def.shapes)) return;
  const colorFor = makeResolver(colors);
  // Occlusion: when a paper colour is supplied (and the asset isn't `lacy`), fill each
  // shape's silhouette with opaque paper FIRST, so this part hides the layers drawn
  // behind it — hat over hair, hair over head, armour over body. Lacy/see-through parts
  // (crown, circlet, wreath…) opt out so hair still shows between their gaps.
  const paper = (colors && typeof colors === 'object') ? colors.paper : null;
  const occlude = !!paper && !def.lacy;
  const wob = r * 0.012;
  const S = (v) => (typeof v === 'number' ? v * r : 0);
  const P = (x, y) => [S(x) + hash(x, y, 1) * wob, S(y) + hash(x, y, 2) * wob];
  const Pa = (pair) => P(pair[0], pair[1]);

  ctx.save();
  ctx.lineJoin = 'round';

  // Opaque silhouette pre-pass: paint every fillable shape so the crisp ink (and
  // everything below this part) is hidden inside the part's outline. Each shape fills
  // with a FAINT tint of its own role colour mixed into the pale paper, so cloth/metal/
  // skin/hair regions read as distinct coloured parchment (a hat won't blend into a
  // head). Roleless shapes fill plain paper.
  if (occlude) {
    ctx.globalAlpha = 1;
    for (const raw of def.shapes) {
      const shape = effective(raw, state);
      if (!shape) continue;
      let poly = null;
      if (shape.type === 'circle' && !shape.fill) {
        const cx = S(shape.cx), cy = S(shape.cy);
        const rad = shape.radiusAbs != null ? shape.radiusAbs : S(shape.radius);
        poly = [];
        const steps = Math.max(18, Math.round(rad));
        for (let i = 0; i < steps; i++) { const t = (i / steps) * TAU; poly.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * rad]); }
      } else if (shape.type === 'path') {
        let pts = (shape.points || []).map(Pa);
        if (shape.smooth && pts.length >= 3) pts = smoothPts(pts, !!shape.closed);
        if (pts.length >= 3) poly = pts;
      } else if (shape.type === 'arc') {
        const cx = S(shape.cx), cy = S(shape.cy), rad = S(shape.radius);
        const a = evalAngle(shape.startAngle), b = evalAngle(shape.endAngle);
        const steps = Math.max(8, Math.round(Math.abs(b - a) / (Math.PI / 16)));
        poly = [];
        for (let i = 0; i <= steps; i++) { const t = a + (b - a) * (i / steps); poly.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * rad]); }
      }
      if (poly && poly.length >= 3) {
        ctx.fillStyle = shape.role ? mixHex(paper, colorFor(shape.role), OCCLUDE_TINT) : paper;
        ctx.beginPath();
        ctx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i][0], poly[i][1]);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  for (const raw of def.shapes) {
    const shape = effective(raw, state);
    if (!shape) continue;
    const color = colorFor(shape.role);
    const lw = (shape.setup && shape.setup.lineWidth) || 2.5;
    const maxW = Math.max(1.0, lw * (0.32 + r * 0.012)); // lineWidth differentiates outline vs detail

    switch (shape.type) {
      case 'circle': {
        const cx = S(shape.cx), cy = S(shape.cy);
        const rad = shape.radiusAbs != null ? shape.radiusAbs : S(shape.radius);
        if (shape.fill) { dab(ctx, cx, cy, rad, color); }
        else {
          const pts = [];
          const steps = Math.max(18, Math.round(rad));
          for (let i = 0; i < steps; i++) { const t = (i / steps) * TAU; pts.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * rad]); }
          brush(ctx, pts, color, maxW, true);
        }
        break;
      }
      case 'path': {
        let pts = (shape.points || []).map(Pa);
        if (shape.smooth && pts.length >= 3) pts = smoothPts(pts, !!shape.closed);
        if (pts.length) brush(ctx, pts, color, maxW, !!shape.closed);
        if (shape.fillSoft && pts.length > 2) { // faint ink wash inside a closed shape
          ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = color;
          ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        break;
      }
      case 'lines': {
        for (const seg of shape.segments || []) brush(ctx, seg.map(Pa), color, maxW, false);
        break;
      }
      case 'arc': {
        const cx = S(shape.cx), cy = S(shape.cy), rad = S(shape.radius);
        let a = evalAngle(shape.startAngle), b = evalAngle(shape.endAngle);
        const steps = Math.max(8, Math.round(Math.abs(b - a) / (Math.PI / 16)));
        const pts = [];
        for (let i = 0; i <= steps; i++) { const t = a + (b - a) * (i / steps); pts.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * rad]); }
        brush(ctx, pts, color, maxW, false);
        break;
      }
      default: break;
    }
  }
  ctx.restore();
}
