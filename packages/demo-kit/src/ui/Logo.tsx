import { useRef, useState } from 'react';
import { TextType } from './TextType.js';

/**
 * The wordmark IS the logo (no icon). Using the ReactBits TextType engine, it
 * types the Ctrl+Z keyboard shortcut, erases it, and retypes the brand name —
 * the undo shortcut literally becomes "Ctrl+ArcZ". `+` is info-blue, `Arc` is the
 * amber brand color; `Ctrl` and `Z` stay neutral. Plays once per session.
 */
const FINAL = 'Ctrl+ArcZ';

/** Color the currently-typed substring by segment (Ctrl / + / Arc / Z). */
function colorize(shown: string) {
  const plus = shown.indexOf('+');
  const before = plus === -1 ? shown : shown.slice(0, plus);
  const tail = plus === -1 ? '' : shown.slice(plus + 1);
  // After "+": a lone "Z" is the shortcut Z (neutral); otherwise the first three
  // chars are "Arc" (amber) and a trailing "Z" is neutral.
  const arc = tail === 'Z' ? '' : tail.slice(0, 3);
  const z = tail === 'Z' ? 'Z' : tail.slice(3);
  return (
    <>
      {before && <span className="logo__ctrl">{before}</span>}
      {plus !== -1 && <span className="logo__plus">+</span>}
      {arc && <span className="logo__arc">{arc}</span>}
      {z && <span className="logo__z">{z}</span>}
    </>
  );
}

/** Animate on every load (i.e. every page refresh); honor reduced-motion. */
function shouldPlay(): boolean {
  try {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

export function LogoWordmark() {
  const [play] = useState(shouldPlay);
  const [replay, setReplay] = useState(0);
  const [cursorOff, setCursorOff] = useState(false);
  // True while the sequence is running; ignore hover until it finishes so the
  // animation never restarts mid-flight or stacks.
  const [animating, setAnimating] = useState(play);
  // True while the pointer is inside. Only a genuine enter (outside -> inside)
  // replays; the spurious mouseenter events that DOM reflow fires under a resting
  // cursor mid-animation are ignored, so it never loops (no snake-eating-tail).
  const hovered = useRef(false);

  if (!play) {
    return (
      <span className="logo" aria-label={FINAL}>
        <span className="logo__word" aria-hidden>
          {colorize(FINAL)}
        </span>
      </span>
    );
  }

  const onEnter = () => {
    if (hovered.current) return;
    hovered.current = true;
    if (animating) return;
    setCursorOff(false);
    setAnimating(true);
    setReplay((n) => n + 1);
  };
  const onLeave = () => {
    hovered.current = false;
  };

  return (
    <span
      className="logo logo--interactive"
      aria-label={FINAL}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <TextType
        key={replay}
        as="span"
        className="logo__word"
        text={['Ctrl+Z', FINAL]}
        loop={false}
        typingSpeed={110}
        deletingSpeed={70}
        pauseDuration={700}
        initialDelay={250}
        cursorCharacter="|"
        cursorClassName="logo__caret"
        showCursor={!cursorOff}
        renderText={colorize}
        onComplete={() => {
          setAnimating(false);
          window.setTimeout(() => setCursorOff(true), 900);
        }}
      />
    </span>
  );
}
