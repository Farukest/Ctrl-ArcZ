import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Typing/deleting text effect, ported from ReactBits "TextType"
 * (https://reactbits.dev/text-animations/text-type). Same char-index engine
 * (type → pause → delete → next), but adapted to this project: the cursor blink
 * is CSS instead of GSAP (no dependency), and a `renderText` hook lets the caller
 * color sub-segments of the current text (ReactBits only colors whole strings).
 */
export interface TextTypeProps {
  text: string | string[];
  as?: keyof JSX.IntrinsicElements;
  typingSpeed?: number;
  initialDelay?: number;
  pauseDuration?: number;
  deletingSpeed?: number;
  loop?: boolean;
  className?: string;
  showCursor?: boolean;
  hideCursorWhileTyping?: boolean;
  cursorCharacter?: string;
  cursorClassName?: string;
  cursorBlinkDuration?: number;
  /** Render the currently-shown substring (e.g. wrap segments in colored spans). */
  renderText?: (shown: string) => ReactNode;
  /** Fires once when the last string finishes typing and `loop` is false. */
  onComplete?: () => void;
}

export function TextType({
  text,
  as = 'span',
  typingSpeed = 50,
  initialDelay = 0,
  pauseDuration = 2000,
  deletingSpeed = 30,
  loop = true,
  className = '',
  showCursor = true,
  hideCursorWhileTyping = false,
  cursorCharacter = '|',
  cursorClassName = '',
  cursorBlinkDuration = 0.5,
  renderText,
  onComplete,
}: TextTypeProps) {
  const [displayedText, setDisplayedText] = useState('');
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [textIndex, setTextIndex] = useState(0);

  const textArray = useMemo(() => (Array.isArray(text) ? text : [text]), [text]);
  const done = useRef(false);
  const complete = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onComplete?.();
  }, [onComplete]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    const current = textArray[textIndex] ?? '';

    const step = () => {
      if (isDeleting) {
        if (displayedText === '') {
          setIsDeleting(false);
          if (textIndex === textArray.length - 1 && !loop) return;
          setTextIndex((p) => (p + 1) % textArray.length);
          setCharIndex(0);
        } else {
          timeout = setTimeout(() => setDisplayedText((p) => p.slice(0, -1)), deletingSpeed);
        }
      } else if (charIndex < current.length) {
        timeout = setTimeout(() => {
          setDisplayedText((p) => p + current[charIndex]);
          setCharIndex((p) => p + 1);
        }, typingSpeed);
      } else if (!loop && textIndex === textArray.length - 1) {
        complete();
      } else {
        timeout = setTimeout(() => setIsDeleting(true), pauseDuration);
      }
    };

    if (charIndex === 0 && !isDeleting && displayedText === '') {
      timeout = setTimeout(step, initialDelay);
    } else {
      step();
    }
    return () => clearTimeout(timeout);
  }, [
    charIndex,
    displayedText,
    isDeleting,
    textIndex,
    textArray,
    typingSpeed,
    deletingSpeed,
    pauseDuration,
    initialDelay,
    loop,
    complete,
  ]);

  const typingNow = charIndex < (textArray[textIndex]?.length ?? 0) || isDeleting;
  const hideCursor = hideCursorWhileTyping && typingNow;

  return createElement(
    as,
    { className: `text-type ${className}`.trim() },
    <span className="text-type__content">
      {renderText ? renderText(displayedText) : displayedText}
    </span>,
    showCursor && (
      <span
        className={`text-type__cursor ${cursorClassName} ${
          hideCursor ? 'text-type__cursor--hidden' : ''
        }`.trim()}
        style={{ ['--tt-blink' as string]: `${cursorBlinkDuration * 2}s` }}
        aria-hidden
      >
        {cursorCharacter}
      </span>
    ),
  );
}
