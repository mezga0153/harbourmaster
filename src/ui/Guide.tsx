import { useEffect, useState } from 'preact/hooks';
import { guideFrames, type Frame, type PictureId } from '../render/guides';
import { GUIDES, type GuideStep } from './guides';
import { guide } from './store';
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

/** The open guide, a step at a time. */
export function GuideDialog() {
  const g = guide.value;
  if (!g) return null;
  const def = GUIDES[g.id];
  const steps = def.steps as GuideStep[];
  const step = steps[g.step];
  const close = () => (guide.value = null);
  const go = (n: number) => (guide.value = { id: g.id, step: n });
  const last = g.step === steps.length - 1;
  return (
    <div class="backdrop" onClick={close}>
      <div
        class="dialog panel guide"
        role="dialog"
        aria-labelledby="guide-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' && !last) go(g.step + 1);
          if (e.key === 'ArrowLeft' && g.step > 0) go(g.step - 1);
          if (e.key === 'Escape') close();
        }}
      >
        <InfoHeader kicker={def.kicker} title={def.title} onClose={close} />
        <FlipBook id={step.picture} />
        <div class="guide-step">
          <div class="guide-count">
            Step {g.step + 1} of {steps.length}
          </div>
          <strong id="guide-title">{step.title}</strong>
          {step.how && <div class="guide-how">{step.how}</div>}
          <p>{step.text}</p>
        </div>
        <div class="guide-nav">
          <div class="guide-dots" role="tablist" aria-label="Steps">
            {steps.map((s, n) => (
              <button
                key={n}
                role="tab"
                aria-selected={n === g.step}
                aria-label={s.title}
                class={n === g.step ? 'on' : ''}
                onClick={() => go(n)}
              />
            ))}
          </div>
          {g.step > 0 && (
            <button class="btn" onClick={() => go(g.step - 1)}>
              Back
            </button>
          )}
          <button class="btn primary" autoFocus onClick={() => (last ? close() : go(g.step + 1))}>
            {last ? 'Got it' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
