import { useEffect, useRef, useState } from 'preact/hooks';
import { guideFrames, type Frame, type PictureId } from '../render/guides';
import { checkStep, GUIDES } from './guides';
import type { Actions } from './actions';
import { availableAction, runHelpAction } from './learning';
import { guide, openCategory, panel, snapshot, tool } from './store';
import { InfoHeader } from './widgets';

// A guide over the game: its steps one at a time, each with its picture
// playing as a flip book, the hand over it showing where to click and drag.

const still =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A guide picture, its beats shown in turn and round again; with `still`, only the last. */
export function FlipBook({ id, small }: { id: PictureId; small?: boolean }) {
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [k, setK] = useState(0);
  // The beat before, kept showing under this one as it fades in.
  const [was, setWas] = useState(-1);
  useEffect(() => {
    let live = true;
    setFrames(null);
    setK(0);
    setWas(-1);
    guideFrames(id).then(
      (f) => live && (setFrames(f), setK(still ? f.length - 1 : 0)),
      (err) => console.warn('No guide picture', err),
    );
    return () => void (live = false);
  }, [id]);
  useEffect(() => {
    if (!frames || still) return;
    const t = setTimeout(() => {
      setWas(k);
      setK((k + 1) % frames.length);
    }, frames[k].hold);
    return () => clearTimeout(t);
  }, [frames, k]);
  const f = frames?.[k];
  return (
    <div class={`flipbook ${small ? 'small' : ''} ${f ? '' : 'loading'}`} aria-hidden="true">
      {frames?.map((fr, n) => (
        <img key={n} src={fr.url} alt="" class={n === k ? 'on' : n === was ? 'was' : ''} />
      ))}
      {f?.hand && (
        <span
          class={`hand ${f.hand.down ? 'down' : ''}`}
          style={{ left: `${f.hand.left}%`, top: `${f.hand.top}%` }}
        >
          <svg viewBox="0 0 24 24" width="26" height="26">
            <path
              d="M5 2.5 L5 19 L9.2 15.2 L12 21.5 L14.8 20.3 L12.1 14.2 L17.8 14 Z"
              fill="#fff"
              stroke="#1b2333"
              stroke-width="1.6"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      )}
    </div>
  );
}

/** Read a lesson while paused, or keep one compact step beside the working port. */
export function GuideDialog({ actions }: { actions: Actions }) {
  const g = guide.value;
  const s = snapshot.value;
  const box = useRef<HTMLDivElement>(null);
  const previousGuide = useRef<string | null>(null);
  useEffect(() => {
    if (!g) {
      previousGuide.current = null;
      return;
    }
    actions.send({
      type: 'help',
      id: g.id,
      action: previousGuide.current === g.id ? 'step' : 'open',
      step: g.step,
    });
    previousGuide.current = g.id;
  }, [g?.id, g?.step]);
  useEffect(() => {
    if (!g || g.practice) return;
    const previous = document.activeElement;
    box.current?.querySelector<HTMLElement>('.guide-primary')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [!!g, g?.practice]);
  if (!g || !s) return null;
  const def = GUIDES[g.id];
  if (!def) return null;
  const step = def.steps[g.step] ?? def.steps[0];
  const statuses = def.steps.map((step) =>
    checkStep(
      step,
      s,
      g.target,
      g.id === 'jib' || g.id === 'harbour' || g.id === 'gantry' ? g.id : undefined,
    ),
  );
  const current = statuses[g.step];
  const done = statuses.every((c) => !c || c.done);
  const count = statuses.filter((c) => c?.done).length;
  const last = g.step === def.steps.length - 1;
  const close = (complete = false) => {
    actions.send({
      type: 'help',
      id: g.id,
      action: complete ? 'complete' : 'dismiss',
      step: g.step,
    });
    guide.value = null;
  };
  const go = (step: number) => {
    guide.value = { ...g, step };
  };
  const toggle = () => {
    if (!g.practice) {
      panel.value = null;
      openCategory.value = null;
    }
    tool.value = 'select';
    guide.value = { ...g, practice: !g.practice };
  };
  const content = (
    <div
      ref={box}
      class={`panel guide ${g.practice ? `guide-coach ${openCategory.value ? 'raised' : ''}` : 'dialog'}`}
      role={g.practice ? 'region' : 'dialog'}
      aria-modal={g.practice ? undefined : true}
      aria-labelledby="guide-title"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
        if (!g.practice && e.key === 'ArrowRight' && !last) {
          e.preventDefault();
          go(g.step + 1);
        }
        if (!g.practice && e.key === 'ArrowLeft' && g.step > 0) {
          e.preventDefault();
          go(g.step - 1);
        }
        if (!g.practice && e.key === 'Tab') {
          const controls = [
            ...(box.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), select, summary, [href]',
            ) ?? []),
          ].filter((el) => el.getClientRects().length);
          const first = controls[0],
            end = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            end?.focus();
          }
          if (!e.shiftKey && document.activeElement === end) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <InfoHeader kicker={def.kicker} title={def.title} onClose={() => close()} />
      <div class="guide-mode">
        <span class="muted">
          {g.practice ? 'Practice in your port' : 'Game paused while you read'}
        </span>
        <button class="link" onClick={toggle}>
          {g.practice ? 'Read with example' : 'Try in my port'}
        </button>
      </div>
      {g.practice ? (
        <details class="guide-example">
          <summary>See animated example</summary>
          <FlipBook id={step.picture} />
        </details>
      ) : (
        <FlipBook id={step.picture} />
      )}
      <div class="guide-step">
        <div class="guide-count">
          Step {g.step + 1} of {def.steps.length}
        </div>
        <strong id="guide-title">{step.title}</strong>
        {step.how && <div class="guide-how">{step.how}</div>}
        <p>{step.text}</p>
      </div>
      {current && (
        <p class={`guide-check ${current.done ? 'pos' : ''}`} role="status">
          {current.done ? '✓' : '○'} {current.label}
        </p>
      )}
      <div class="actions guide-actions">
        {step.actions?.map((a) => (
          <button
            key={a.label}
            class="btn"
            disabled={!availableAction(a)}
            onClick={() => runHelpAction(a, actions)}
          >
            {a.label}
          </button>
        ))}
      </div>
      <details class="guide-checklist">
        <summary>
          {count} of {statuses.filter(Boolean).length} checks complete
        </summary>
        <ol>
          {def.steps.map((st, n) => (
            <li key={st.title}>
              <button
                class={`link ${statuses[n]?.done ? 'pos' : ''}`}
                aria-current={n === g.step ? 'step' : undefined}
                onClick={() => go(n)}
              >
                {statuses[n]?.done ? '✓ ' : ''}
                {st.title}
              </button>
            </li>
          ))}
        </ol>
      </details>
      <div class="guide-nav">
        {g.step > 0 && (
          <button class="btn" onClick={() => go(g.step - 1)}>
            Back
          </button>
        )}
        <button
          class="btn primary guide-primary"
          disabled={last && !done}
          onClick={() => (last ? close(true) : go(g.step + 1))}
        >
          {last ? 'Finish lesson' : 'Next'}
        </button>
        <button class="link" onClick={() => close()}>
          Save for later
        </button>
      </div>
      {last && !done && (
        <p class="muted">
          Complete the checks in your port to finish. You can revisit any step or save the lesson
          for later.
        </p>
      )}
      {g.id === 'wharf' && last && done && (
        <button
          class="link"
          onClick={() => {
            close(true);
            guide.value = { id: 'jib', step: 0 };
          }}
        >
          Next: speed up with a jib crane ›
        </button>
      )}
    </div>
  );
  return g.practice ? (
    content
  ) : (
    <div class="backdrop" onClick={() => close()}>
      {content}
    </div>
  );
}
