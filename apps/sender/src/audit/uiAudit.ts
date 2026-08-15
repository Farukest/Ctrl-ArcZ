/**
 * In-page UI audit. Loaded in dev only (see main.tsx) and reachable as
 * `window.__uiAudit`, so a browser session can measure a screen instead of
 * describing it.
 *
 * It exists because eyeballing screenshots does not catch what it is supposed to
 * catch. "The selected tab looks a bit faint" is a judgement call that gets waved
 * through; "the selected tab is 1.00:1 against its own track" is a number that
 * cannot be. Every rule below is one a person had to notice first and say out loud.
 *
 * Nothing here mutates the page except the theme, which it puts back.
 */

export type Severity = 'high' | 'medium';

export interface Finding {
  rule: string;
  severity: Severity;
  where: string;
  detail: Record<string, unknown>;
}

type Rgb = [number, number, number];

const rgb = (s: string): Rgb | null => {
  const m = String(s).match(/[\d.]+/g);
  if (!m || m.length < 3) return null;
  return [Number(m[0]), Number(m[1]), Number(m[2])];
};

const channel = (v: number): number => {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const lum = ([r, g, b]: Rgb): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export const contrast = (a: string, b: string): number | null => {
  const ca = rgb(a);
  const cb = rgb(b);
  if (!ca || !cb) return null;
  const la = lum(ca);
  const lb = lum(cb);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
};

/** Rough perceptual distance between two colours, 0 to ~255. Hue counts, not just
 *  luminance: an amber label beside a slate one can be the same brightness. */
export const distance = (a: string, b: string): number => {
  const ca = rgb(a);
  const cb = rgb(b);
  if (!ca || !cb) return 0;
  const rm = (ca[0] + cb[0]) / 2;
  const dr = ca[0] - cb[0];
  const dg = ca[1] - cb[1];
  const db = ca[2] - cb[2];
  return +Math.sqrt(
    (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db,
  ).toFixed(0);
};

const opaque = (bg: string): boolean => {
  if (!bg || bg === 'transparent') return false;
  const a = /rgba?\([^)]*?([\d.]+)\)\s*$/.exec(String(bg));
  return !(String(bg).startsWith('rgba') && a?.[1] !== undefined && parseFloat(a[1]) < 0.9);
};

/**
 * What an element is really painted on, which is not always its parent. A segmented
 * control's thumb is an absolutely positioned sibling sitting *under* the label, so
 * walking up the tree reports the track and calls a perfectly readable label
 * unreadable. Hit-testing the element's own centre finds what is actually behind it.
 */
const painted = (el: Element, includeSelf = true): Element => {
  // Its own background first. A chip that paints itself is what its own label sits
  // on, and skipping straight to the ancestors reported a dark badge's white text
  // as white-on-white against the card behind it.
  if (includeSelf && opaque(getComputedStyle(el).backgroundColor)) return el;
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
    const stack = document.elementsFromPoint(cx, cy);
    const i = stack.indexOf(el);
    for (const n of i === -1 ? stack : stack.slice(i + 1)) {
      if (el.contains(n)) continue;
      if (opaque(getComputedStyle(n).backgroundColor)) return n;
    }
  }
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (opaque(getComputedStyle(n).backgroundColor)) return n;
  }
  return document.body;
};

const visible = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
};

const where = (el: Element | null): string => {
  if (!el) return '(none)';
  const bits: string[] = [];
  for (let n: Element | null = el; n && bits.length < 4; n = n.parentElement) {
    let s = n.tagName.toLowerCase();
    if (n.id) s += '#' + n.id;
    else if (typeof n.className === 'string' && n.className.trim())
      s += '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.');
    bits.unshift(s);
  }
  return bits.join(' > ');
};

const text = (el: Element, n = 40): string => (el.textContent ?? '').trim().slice(0, n);

/** Freeze transitions while measuring: see themeAudit for why this is load-bearing. */
const withoutMotion = <T>(fn: () => T): T => {
  const style = document.createElement('style');
  style.textContent =
    '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
  try {
    return fn();
  } finally {
    style.remove();
  }
};

/** Every rule that can be judged from a single rendered screen. */
export function audit(): { url: string; theme: string; width: number; findings: Finding[] } {
  const findings: Finding[] = [];
  const add = (rule: string, severity: Severity, el: Element, detail: Record<string, unknown>) =>
    findings.push({ rule, severity, where: where(el), detail });

  withoutMotion(() => {
    // 1. A selected state has to be visible against the track it sits in.
    //    Fill contrast alone is allowed to be low: a white thumb on a grey track is
    //    about 1.2:1 in every operating system, and it still reads because of the
    //    shadow and the label. Failing fill AND label AND weight is what makes a
    //    selected tab genuinely disappear.
    document
      .querySelectorAll('[aria-selected="true"], .is-active, [aria-pressed="true"]')
      .forEach((el) => {
        if (!visible(el) || !el.parentElement) return;
        const sibs = [...el.parentElement.children].filter(
          (n) => n !== el && n.tagName === el.tagName && visible(n),
        );
        const sib = sibs[0];
        if (!sib) return;
        const me = getComputedStyle(el);
        const other = getComputedStyle(sib);
        // The track is the parent, not painted(): painted() answers "what is this
        // painted on", and a thumb that paints itself would be compared to itself.
        const track = getComputedStyle(el.parentElement).backgroundColor;
        const fill = contrast(me.backgroundColor, track);
        // Label difference has to be measured as colour distance, not contrast
        // ratio. Amber and slate can be the same luminance and still be obviously
        // different to the eye, and a ratio near 1.0 would call that invisible.
        const label = distance(me.color, other.color);
        const weight = parseInt(me.fontWeight, 10) - parseInt(other.fontWeight, 10);
        if ((fill ?? 1) < 1.25 && label < 60 && weight < 60) {
          add('selected-state-invisible', 'high', el, {
            text: text(el, 30),
            fillVsTrack: fill,
            labelColourDistance: label,
            weightDelta: weight,
          });
        }
      });

    // 1b. A control has to be distinguishable from the page it sits on.
    //     Rule 1 only asks whether the selected half stands out inside its own
    //     track. It says nothing about whether the track is visible at all, and a
    //     switch whose unselected half is the same grey as the background does not
    //     read as a switch: the inactive side looks like empty page. A control is
    //     separated by its fill or by its edge, and failing both is invisible.
    document
      .querySelectorAll('.segtabs, .modeswitch, .card, .input, .searchfield, .select-trigger')
      .forEach((el) => {
        if (!visible(el)) return;
        const s = getComputedStyle(el);
        const behind = getComputedStyle(painted(el.parentElement ?? document.body)).backgroundColor;
        const fill = contrast(s.backgroundColor, behind) ?? 1;
        const hasBorder = parseFloat(s.borderTopWidth) > 0;
        const edge = hasBorder ? (contrast(s.borderTopColor, behind) ?? 1) : 1;
        if (fill < 1.15 && edge < 1.35) {
          add('surface-not-distinguishable', 'high', el, {
            fillVsPage: fill,
            edgeVsPage: hasBorder ? edge : 'no border',
            bg: s.backgroundColor,
            behind,
          });
        }
      });

    // 1c. A shimmer is a promise that a value is on its way. One still shimmering
    //     long after the screen settled is a broken promise, and it is worse than
    //     the placeholder it replaced: a dash said "not available", a shimmer says
    //     "wait" forever. Callers that genuinely cannot read a value pass
    //     `still`, which is excluded here on purpose.
    document.querySelectorAll('.skeleton:not(.skeleton--still)').forEach((el) => {
      if (!visible(el)) return;
      add('stuck-loading', 'high', el, {
        near: text(el.parentElement ?? el, 60),
        size: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(
          el.getBoundingClientRect().height,
        )}`,
      });
    });

    // 2. Text has to be legible on whatever it is actually painted on.
    document.querySelectorAll('button, a, label, p, span, dd, dt, td, th, li').forEach((el) => {
      if (!visible(el)) return;
      const own = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 1,
      );
      if (!own) return;
      const s = getComputedStyle(el);
      const bg = getComputedStyle(painted(el)).backgroundColor;
      const c = contrast(s.color, bg);
      const size = parseFloat(s.fontSize);
      const large = size >= 18.66 || (size >= 14 && parseInt(s.fontWeight, 10) >= 700);
      const floor = large ? 3 : 4.5;
      if (c !== null && c < floor) {
        add('text-contrast', c < floor - 1.2 ? 'high' : 'medium', el, {
          text: text(el),
          contrast: c,
          needs: floor,
          color: s.color,
          on: bg,
        });
      }
    });

    // 3. Touch targets. WCAG 2.5.8 puts the floor at 24x24 CSS px.
    //    Measured by hit-testing, not by getBoundingClientRect: a 14px glyph with a
    //    32px invisible ::after overlay is a perfectly good target, and a box
    //    measurement would fail it while a thumb would not.
    const HALF = 12;
    document.querySelectorAll('button, a[href], [role="tab"], input, select').forEach((el) => {
      if (!visible(el)) return;
      // A disabled control is supposed not to answer, and one scrolled out of the
      // viewport cannot be hit-tested at all. Neither is a finding.
      if ((el as HTMLButtonElement).disabled) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx - HALF < 0 || cy - HALF < 0 || cx + HALF >= innerWidth || cy + HALF >= innerHeight)
        return;
      const hits = (
        [
          [cx - HALF + 1, cy],
          [cx + HALF - 1, cy],
          [cx, cy - HALF + 1],
          [cx, cy + HALF - 1],
        ] as const
      ).every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === el || el.contains(hit));
      });
      if (!hits) {
        add('touch-target', innerWidth < 560 ? 'high' : 'medium', el, {
          text: text(el, 30),
          box: `${Math.round(r.width)}x${Math.round(r.height)}`,
          note: 'does not answer a tap 12px from its centre',
        });
      }
    });

    // 4. Nothing may push the page sideways.
    const docW = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > docW + 1) {
      document.querySelectorAll('body *').forEach((el) => {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
        if (r.right > docW + 1 && r.width <= docW) {
          add('horizontal-overflow', 'high', el, {
            right: Math.round(r.right),
            viewport: docW,
            text: text(el, 30),
          });
        }
      });
    }

    // 5. An inline chip has to share an optical line with the label beside it.
    //    This is the "the notification number sits crooked" rule.
    document.querySelectorAll('button, [role="tab"], a, .hstatus').forEach((el) => {
      if (!visible(el)) return;
      const label = [...el.childNodes].find(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 1,
      );
      if (!label) return;
      const range = document.createRange();
      range.selectNode(label);
      const lineBox = range.getBoundingClientRect();
      range.detach();
      if (!lineBox.height) return;
      [...el.children].forEach((c) => {
        const r = c.getBoundingClientRect();
        if (!visible(c) || r.height > 28 || r.width > 60) return;
        const off = Math.abs(r.top + r.height / 2 - (lineBox.top + lineBox.height / 2));
        if (off > 2.5) {
          add('badge-misaligned', 'medium', c, {
            chip: text(c, 12),
            offCentreBy: +off.toFixed(1),
            inside: text(el, 24),
          });
        }
      });
    });
  });

  return {
    url: location.href,
    theme: document.documentElement.dataset.theme ?? 'dark',
    width: innerWidth,
    findings,
  };
}

export interface StuckElement {
  tag: string;
  cls: string;
  bg: string;
  fg: string;
  text: string;
}

/**
 * Everything that paints must actually change when the theme does. Anything whose
 * background and colour are byte-identical in both themes is either a deliberate
 * constant or, far more often, a hardcoded value the theme cannot reach. That is
 * how a control stays black on a white page.
 *
 * Freezing transitions first is not optional. Every themed control here carries
 * `transition: background-color 160ms`, and getComputedStyle mid-transition returns
 * the value being animated FROM, so a flip-and-read reports "nothing changed" for
 * precisely the elements that theme correctly.
 */
export function themeAudit(): StuckElement[] {
  return withoutMotion(() => {
    const snap = () =>
      [...document.querySelectorAll('body *')].map((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          el,
          paints: opaque(s.backgroundColor),
          bg: s.backgroundColor,
          fg: s.color,
          visible: r.width > 0 && r.height > 0,
        };
      });

    const root = document.documentElement;
    const started = root.dataset.theme ?? 'dark';
    root.dataset.theme = 'dark';
    const dark = snap();
    root.dataset.theme = 'light';
    const light = snap();
    root.dataset.theme = started;

    const stuck: StuckElement[] = [];
    dark.forEach((d, i) => {
      const l = light[i];
      if (!l || d.el !== l.el || !d.visible || !d.paints) return;
      if (d.bg === l.bg && d.fg === l.fg) {
        stuck.push({
          tag: d.el.tagName.toLowerCase(),
          cls: String(d.el.className || '').slice(0, 60),
          bg: d.bg,
          fg: d.fg,
          text: text(d.el, 30),
        });
      }
    });
    return stuck;
  });
}

export function fullAudit() {
  return { ...audit(), stuckInBothThemes: themeAudit() };
}
