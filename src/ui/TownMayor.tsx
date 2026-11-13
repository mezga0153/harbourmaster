import { useEffect, useRef, useState } from 'preact/hooks';
import { mayorStage } from '../render/mayor';
import type { Actions } from './actions';
import { GUIDES } from './guides';
import { Icon } from './icons';
import { availableAction, runHelpAction } from './learning';
import { mayorAt, mayorLines, mayorOpen, mayorUnread, type Help, type Mood } from './mayorTalk';
import {
  guide,
  menuOpen,
  narrow,
  openCategory,
  openGuide,
  panel,
  selection,
  snapshot,
} from './store';
import { Meter } from './widgets';

/**
 * Mayor Bramblewick's face, drawn here: a round, rosy town mayor in a top
 * hat, spectacles and the chain of office, with a moustache of great
 * ambition; brows and mouth by `mood`, a monocle for thinking.
 */
export function MayorFace({ mood, talking }: { mood: Mood; talking?: boolean }) {
  const happy = mood === 'cheer' || mood === 'proud';
  // Brows: [outer, inner] lift; inner end up for worry, both raised for cheer.
  const brow = {
    cheer: [-3, -3],
    proud: [-1, -2],
    hope: [-1, -3],
    worry: [2, -4],
    ponder: [-4, 1],
  }[mood];
  const mouth = {
    cheer: 'M43 75 Q50 83 57 75 Q50 78 43 75 Z',
    proud: 'M44 75 Q50 81 56 75 Q50 77 44 75 Z',
    hope: 'M45 76 Q50 79 55 76',
    worry: 'M45 78 Q47.5 75.5 50 77 Q52.5 78.5 55 76',
    ponder: 'M46 77 Q51 77.5 55 75.5',
  }[mood];
  return (
    <svg
      class={`mayor-portrait ${talking ? 'talking' : ''}`}
      viewBox="0 0 100 100"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="mayor-sky" cx="50%" cy="35%" r="70%">
          <stop offset="0" stop-color="#7cc4ec" />
          <stop offset="1" stop-color="#2a6fa8" />
        </radialGradient>
        <clipPath id="mayor-round">
          <circle cx="50" cy="50" r="50" />
        </clipPath>
      </defs>
      <g clip-path="url(#mayor-round)">
        <circle cx="50" cy="50" r="50" fill="url(#mayor-sky)" />
        <path d="M0 88 Q25 82 50 88 T100 88 V100 H0 Z" fill="#1d5a8c" opacity="0.6" />
        {/* Coat, shirt and bow tie */}
        <path d="M12 100 Q14 86 32 83 L50 90 L68 83 Q86 86 88 100 Z" fill="#2c3e64" />
        <path d="M40 84 L50 98 L60 84 Q50 88 40 84 Z" fill="#f3f1ea" />
        <path d="M44 86 L50 89 L56 86 L56 92 L50 89 L44 92 Z" fill="#c0392b" />
        {/* The chain of office */}
        <path
          d="M31 84 Q50 104 69 84"
          fill="none"
          stroke="#f5c542"
          stroke-width="3"
          stroke-dasharray="3 1.6"
        />
        <circle cx="50" cy="96" r="5" fill="#f5c542" stroke="#b8862a" stroke-width="1.2" />
        <path d="M50 93.5 l1 2 2.2.3-1.6 1.5.4 2.2-2-1-2 1 .4-2.2-1.6-1.5 2.2-.3z" fill="#b8862a" />
        <g class="mayor-head">
          {/* Neck, ears and face */}
          <rect x="43" y="76" width="14" height="10" fill="#e9b48f" />
          <ellipse cx="29" cy="61" rx="4" ry="5.5" fill="#e3a782" />
          <ellipse cx="71" cy="61" rx="4" ry="5.5" fill="#e3a782" />
          <ellipse cx="50" cy="60" rx="21" ry="23" fill="#f2c4a0" />
          {/* Grey tufts of hair under the hat */}
          <path d="M28 52 Q24 44 31 40 Q30 47 33 50 Z" fill="#d9dde3" />
          <path d="M72 52 Q76 44 69 40 Q70 47 67 50 Z" fill="#d9dde3" />
          {/* Rosy cheeks, rosier when pleased */}
          <ellipse cx="36" cy="68" rx="4.5" ry="2.8" fill="#ec8a8a" opacity={happy ? 0.75 : 0.4} />
          <ellipse cx="64" cy="68" rx="4.5" ry="2.8" fill="#ec8a8a" opacity={happy ? 0.75 : 0.4} />
          {/* Eyes behind round spectacles, and the brows over them */}
          {[41, 59].map((x, i) => (
            <g key={x}>
              {happy ? (
                <path
                  d={`M${x - 2.6} 59.5 Q${x} 56.5 ${x + 2.6} 59.5`}
                  stroke="#2a2420"
                  stroke-width="1.6"
                  fill="none"
                  stroke-linecap="round"
                />
              ) : (
                <>
                  <circle cx={x} cy="59" r="2.2" fill="#2a2420" />
                  <circle cx={x + 0.7} cy="58.3" r="0.7" fill="#fff" />
                </>
              )}
              {!(mood === 'ponder' && i === 1) && (
                <circle
                  cx={x}
                  cy="59"
                  r="5.4"
                  fill="#fff"
                  fill-opacity="0.12"
                  stroke="#5a4a3a"
                  stroke-width="1.2"
                />
              )}
              <path
                d={`M${x - 5} ${50.5 + (i === 0 ? brow[0] : brow[1]) * 0.7} L${x + 5} ${50.5 + (i === 0 ? brow[1] : brow[0]) * 0.7}`}
                stroke="#8e959f"
                stroke-width="2.6"
                stroke-linecap="round"
              />
            </g>
          ))}
          {mood === 'ponder' ? (
            <>
              <circle
                cx="59"
                cy="59"
                r="5.8"
                fill="#fff"
                fill-opacity="0.15"
                stroke="#f5c542"
                stroke-width="1.4"
              />
              <path d="M64.6 61 Q68 70 64 80" fill="none" stroke="#f5c542" stroke-width="0.8" />
            </>
          ) : (
            <path d="M46.4 59 Q50 57.5 53.6 59" stroke="#5a4a3a" stroke-width="1.2" fill="none" />
          )}
          {/* Nose, mouth, and a moustache of great ambition */}
          <ellipse cx="50" cy="66" rx="3.6" ry="3" fill="#e7a07c" />
          <path
            class="mayor-mouth"
            d={mouth}
            fill={happy ? '#7a2a22' : 'none'}
            stroke="#7a2a22"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <path
            d="M50 70 Q44 67.5 38 70 Q33 72.5 29.5 69 Q31 75 38 74.5 Q45 74 50 71.5 Q55 74 62 74.5 Q69 75 70.5 69 Q67 72.5 62 70 Q56 67.5 50 70 Z"
            fill="#d9dde3"
            stroke="#b5bcc6"
            stroke-width="0.6"
          />
          {/* The top hat, at a jaunty angle */}
          <g transform="rotate(-7 50 36)">
            <ellipse cx="50" cy="40" rx="25" ry="5" fill="#121318" />
            <path d="M35 39 L37 13 Q50 9.5 63 13 L65 39 Q50 42 35 39 Z" fill="#1c1e26" />
            <path d="M35.6 32 Q50 35 64.4 32 L64.8 37 Q50 40 35.2 37 Z" fill="#c0392b" />
            <path d="M41 15 L40 30" stroke="#fff" stroke-opacity="0.12" stroke-width="2" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * The mayor in 3D, in the round portrait (render/mayor.ts), acting out the
 * mood of what is said; the drawn face where WebGL will not start.
 */
function MayorPortrait({ mood, talking, wave }: { mood: Mood; talking: boolean; wave: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const stage = mayorStage();
  useEffect(() => {
    const el = host.current;
    if (!stage || !el) return;
    stage.size(el.clientWidth || 60);
    el.appendChild(stage.canvas);
    stage.play();
    return () => {
      stage.stop();
      stage.canvas.remove();
    };
  }, [stage]);
  useEffect(() => stage?.set({ mood, talking, wave }), [stage, mood, talking, wave]);
  if (!stage) return <MayorFace mood={mood} talking={talking} />;
  return <div class="mayor-stage" ref={host} />;
}

/** The link after the mayor's words to the lesson, or the offer, for what is asked. */
function HowTo({ help, actions }: { help: Help; actions: Actions }) {
  const label =
    'guide' in help
      ? `Lesson: ${lowerFirst(
          help.step === undefined
            ? GUIDES[help.guide].title
            : GUIDES[help.guide].steps[help.step].title,
        )}`
      : help.action.label;
  if ('action' in help && !availableAction(help.action)) return null;
  const go = (e: MouseEvent) => {
    e.stopPropagation();
    mayorOpen.value = false;
    if ('guide' in help) openGuide(help.guide, help.step);
    else runHelpAction(help.action, actions);
  };
  return (
    <>
      {' '}
      <button class="link mayor-how" onClick={go}>
        {label} ›
      </button>
    </>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** How far the town's next goal has got, 0 to 1, days running and all. */
function goalProgress(n: NonNullable<NonNullable<ReturnType<typeof townNext>>>): number {
  const part = n.need > 0 ? Math.min(1, n.have / n.need) : 1;
  return n.days ? Math.min(1, (n.days.done + part) / n.days.need) : part;
}

const townNext = () => snapshot.value?.town?.next ?? null;

const reducedMotion =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A passing update puts itself away after this long, unless the pointer is on it. */
const CLOSE_MS = 16000;

/**
 * The mayor's corner: a portrait that opens into what the mayor has to
 * say about the town's next landmark and how the port is getting on with
 * it (mayorTalk.ts decides when and what).
 */
export function Mayor({ actions }: { actions: Actions }) {
  const lines = mayorLines.value;
  const at = Math.min(mayorAt.value, lines.length - 1);
  const line = lines[at];
  const [shown, setShown] = useState(0);
  const hovering = useRef(false);
  const busy = !!(panel.value || selection.value);
  const open = mayorOpen.value && !!line && !busy && !guide.value;

  // Type the line out a few letters at a time.
  useEffect(() => {
    if (!line || !open) return;
    if (reducedMotion) {
      setShown(line.text.length);
      return;
    }
    setShown(0);
    const id = setInterval(() => {
      setShown((n) => {
        if (n + 2 >= line.text.length) clearInterval(id);
        return n + 2;
      });
    }, 22);
    return () => clearInterval(id);
  }, [line?.id, open]);

  // A passing update goes away again by itself.
  useEffect(() => {
    if (!line || !open || line.keep || at < lines.length - 1) return;
    const id = setTimeout(function close() {
      if (hovering.current) {
        setTimeout(close, 3000);
        return;
      }
      if (mayorLines.peek()[mayorAt.peek()]?.id === line.id) mayorOpen.value = false;
    }, CLOSE_MS);
    return () => clearTimeout(id);
  }, [line?.id, open]);

  if (!snapshot.value?.town || lines.length === 0) return null;
  if (narrow.value && (panel.value || selection.value || menuOpen.value)) return null;

  const n = townNext();
  const typing = open && shown < line.text.length;
  const toggle = () => {
    if (mayorOpen.value) {
      mayorOpen.value = false;
      return;
    }
    // Opening on unread lines starts at the first of them.
    const unread = mayorUnread.value;
    mayorAt.value = Math.max(0, lines.length - Math.max(1, unread));
    mayorUnread.value = 0;
    if (busy) {
      panel.value = null;
      selection.value = null;
    }
    mayorOpen.value = true;
  };
  const go = () => {
    if (line.action === 'port') {
      selection.value = null;
      panel.value = 'port';
    } else {
      panel.value = null;
      selection.value = { type: 'town' };
    }
  };
  const newer = at < lines.length - 1;
  return (
    <div class={`mayor ${openCategory.value ? 'raised' : ''}`}>
      {open && (
        <div
          class="mayor-card panel"
          role="status"
          onMouseEnter={() => (hovering.current = true)}
          onMouseLeave={() => (hovering.current = false)}
        >
          <div class="mayor-head">
            <span class="kicker">Mayor Bramblewick of {snapshot.value.town.name}</span>
            <div class="mayor-head-actions">
              {lines.length > 1 && (
                <>
                  <button
                    class="btn icon ghost"
                    aria-label="Something the mayor said before"
                    disabled={at === 0}
                    onClick={() => (mayorAt.value = at - 1)}
                  >
                    ‹
                  </button>
                  <span class="muted">
                    {at + 1}/{lines.length}
                  </span>
                  <button
                    class="btn icon ghost"
                    aria-label="Something the mayor said after"
                    disabled={!newer}
                    onClick={() => (mayorAt.value = at + 1)}
                  >
                    ›
                  </button>
                </>
              )}
              <button
                class="btn icon ghost"
                aria-label="Put the mayor away"
                title="Put the mayor away"
                onClick={() => (mayorOpen.value = false)}
              >
                <Icon name="close" />
              </button>
            </div>
          </div>
          <p class="mayor-text" onClick={() => setShown(line.text.length)}>
            {line.text.slice(0, shown)}
            {typing && <span class="mayor-caret" />}
            {!typing && line.help && <HowTo help={line.help} actions={actions} />}
          </p>
          {n && !n.waiting && (
            <div class="mayor-goal">
              <span>{n.name}</span>
              <Meter value={goalProgress(n)} tone={goalProgress(n) >= 1 ? 'good' : 'ok'} />
            </div>
          )}
          <div class="mayor-actions">
            <button class="btn primary" onClick={go}>
              {line.action === 'port' ? 'Open the port panel' : 'See the town'}
            </button>
            {newer && (
              <button class="btn" onClick={() => (mayorAt.value = at + 1)}>
                And?
              </button>
            )}
          </div>
        </div>
      )}
      <button
        class={`mayor-face ${mayorUnread.value > 0 ? 'unread' : ''}`}
        onClick={toggle}
        aria-label={mayorOpen.value ? 'Put the mayor away' : 'Hear from the mayor'}
        title={mayorUnread.value > 0 ? 'The mayor has news' : 'Mayor Bramblewick'}
      >
        <MayorPortrait mood={line.mood} talking={typing} wave={mayorUnread.value > 0 && !open} />
        {mayorUnread.value > 0 && <span class="mayor-dot">{mayorUnread.value}</span>}
      </button>
    </div>
  );
}
