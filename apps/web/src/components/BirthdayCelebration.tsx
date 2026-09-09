import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { usePrimarySettings } from "../hooks/useSettings";
import "./birthday.css";

const CONFETTI_COLORS = ["#ffaf91", "#f8d477", "#a8dcca", "#d5b7f4"];
const BIRTHDAY_NOTES: readonly string[] = [
  "The cake has requested a code freeze. Your wish has higher priority.",
  "Wishing you a year with more good surprises and fewer mystery bugs.",
  "Another trip around the sun. No rollback requested.",
  "Birthday checks passed. Cake coverage remains below target.",
  "May your next year have excellent snacks, kind people, and very boring error logs.",
];
const BirthdayContext = createContext({
  active: false,
  year: 0,
  noteIndex: 0,
  notes: BIRTHDAY_NOTES,
  nextNote: () => {},
});
const BIRTHDAY_CAKES = [
  { name: "Strawberry birthday cake", layer: "#b881aa", icing: "#ffd0bd", sprinkles: "#9d496c" },
  { name: "Chocolate birthday cake", layer: "#8b5b49", icing: "#e8ba8c", sprinkles: "#634037" },
  { name: "Lemon birthday cake", layer: "#c9a458", icing: "#f8e6a5", sprinkles: "#837646" },
];

/** Temporary decoration. The saved theme and application actions remain untouched. */
export function BirthdayCelebration({ children }: { readonly children: ReactNode }) {
  const birthday = usePrimarySettings((settings) => settings.birthdayCelebration);
  const [now, setNow] = useState(Date.now);
  const [noteIndex, setNoteIndex] = useState(0);
  const [bursts, setBursts] = useState<
    readonly { id: number; x: number; y: number; wide: boolean }[]
  >([]);
  const today = new Date(now);
  const active =
    birthday?.enabled === true &&
    birthday.month === today.getMonth() + 1 &&
    birthday.day === today.getDate();
  const effects = active && birthday?.tapEffects === true;
  const year = today.getFullYear();
  const notes = birthday?.notes?.length ? birthday.notes : BIRTHDAY_NOTES;
  const context = useMemo(
    () => ({ active, year, noteIndex, notes, nextNote: () => setNoteIndex((index) => index + 1) }),
    [active, year, noteIndex, notes],
  );

  useEffect(() => {
    if (!birthday?.enabled) return;
    const update = () => setNow(Date.now());
    const timer = window.setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    update();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [birthday?.enabled, birthday?.month, birthday?.day]);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-birthday", active);
    root.toggleAttribute("data-birthday-effects", effects);
    return () => {
      root.removeAttribute("data-birthday");
      root.removeAttribute("data-birthday-effects");
    };
  }, [active, effects]);

  useEffect(() => {
    if (!effects) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timers = new Set<number>();
    let lastBurst = -Infinity;
    let nextId = 0;
    const clear = () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      setBursts([]);
    };
    const click = (event: MouseEvent) => {
      if (motion.matches || document.visibilityState === "hidden" || event.button !== 0) return;
      const control =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              'button, [role="button"], [role="switch"], summary, a[href]',
            )
          : null;
      if (!control || control.matches(':disabled, [aria-disabled="true"]')) return;
      const at = Date.now();
      if (at - lastBurst < 100) return;
      lastBurst = at;
      const rect = control.getBoundingClientRect();
      const id = nextId++;
      setBursts((previous) => [
        ...previous.slice(-2),
        {
          id,
          x: event.detail === 0 ? rect.left + rect.width / 2 : event.clientX,
          y: event.detail === 0 ? rect.top + rect.height / 2 : event.clientY,
          wide: control.hasAttribute("data-birthday-wish"),
        },
      ]);
      const timer = window.setTimeout(() => {
        setBursts((previous) => previous.filter((burst) => burst.id !== id));
        timers.delete(timer);
      }, 850);
      timers.add(timer);
    };
    document.addEventListener("click", click, true);
    document.addEventListener("visibilitychange", clear);
    motion.addEventListener("change", clear);
    return () => {
      document.removeEventListener("click", click, true);
      document.removeEventListener("visibilitychange", clear);
      motion.removeEventListener("change", clear);
      clear();
    };
  }, [effects]);

  return (
    <BirthdayContext value={context}>
      {children}
      {effects ? (
        <div className="birthday-confetti" aria-hidden="true">
          {bursts.map((burst) => (
            <div key={burst.id} className="birthday-burst" style={{ left: burst.x, top: burst.y }}>
              {Array.from({ length: 12 }, (_, index) => {
                const angle = (index / 12) * Math.PI * 2;
                const distance = (burst.wide ? 110 : 36) + (index % 3) * 12;
                return (
                  <i
                    key={index}
                    style={
                      {
                        "--confetti-x": `${Math.cos(angle) * distance}px`,
                        "--confetti-y": `${Math.sin(angle) * distance - 28}px`,
                        "--confetti-turn": `${index % 2 ? 210 : -150}deg`,
                        background: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
                        borderRadius: index % 3 === 0 ? "50%" : "1px",
                      } as CSSProperties
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </BirthdayContext>
  );
}

export function BirthdayGreeting() {
  const { active, year, noteIndex, notes, nextNote } = useContext(BirthdayContext);
  const [wished, setWished] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  if (!active) return null;
  const cake = BIRTHDAY_CAKES[year % BIRTHDAY_CAKES.length]!;
  return (
    <section className="birthday-greeting" aria-label="Birthday celebration">
      <div className="birthday-greeting-copy">
        <p className="birthday-eyebrow">
          <span aria-hidden="true">⌘</span> birthday/{year}{" "}
          <span className="birthday-status">{wished ? "completed" : "ready"}</span>
        </p>
        <h2>
          Happy birthday<span aria-hidden="true"> ✦</span>
        </h2>
        <p role="status" aria-live="polite">
          {wished
            ? "Wish made. Delivery date classified."
            : "One candle. Unlimited retries. Make this next year a good one."}
        </p>
        <button
          type="button"
          className="birthday-note-toggle"
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen(!noteOpen)}
        >
          {noteOpen ? "Close birthday.log" : "Open birthday.log"}
          <span aria-hidden="true"> ↗</span>
        </button>
      </div>
      <button
        type="button"
        className="birthday-wish"
        data-birthday-wish=""
        onClick={() => setWished(!wished)}
        aria-label={wished ? "Light the birthday candle again" : "Make a birthday wish"}
      >
        <svg viewBox="0 0 88 92" aria-hidden="true" className="birthday-cake">
          <title>{cake.name}</title>
          {!wished ? (
            <path d="M44 4c-7 9-9 13-5 17 3 3 8 2 10-2 2-5-2-10-5-15Z" fill="#f8d477" />
          ) : (
            <path
              d="M44 21c-6-5 7-8 1-14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              opacity=".5"
            />
          )}
          <rect x="41" y="25" width="6" height="21" rx="2" fill="#a8dcca" />
          <path d="M18 56h52v23c0 6-52 6-52 0Z" fill={cake.layer} />
          <ellipse cx="44" cy="56" rx="26" ry="10" fill={cake.icing} />
          <path
            d="M18 56v8c5 0 4 9 9 9s3-9 9-9 4 5 9 5 4-5 10-5 6 5 11 2l4-5v-5"
            fill={cake.icing}
          />
          <path
            d="m29 52 3 2m9 2 3-2m12 0 2-3"
            stroke={cake.sprinkles}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <ellipse cx="44" cy="83" rx="34" ry="4" fill="#a8dcca" opacity=".65" />
        </svg>
        <span>{wished ? "↻ Run again" : "▶ Make a wish"}</span>
      </button>
      {noteOpen ? (
        <div className="birthday-note">
          <p aria-live="polite">{notes[(year + noteIndex) % notes.length]}</p>
          <button type="button" onClick={nextNote}>
            Next entry →
          </button>
        </div>
      ) : null}
      <Link to="/settings/appearance" className="birthday-settings-link">
        Birthday settings
      </Link>
    </section>
  );
}
