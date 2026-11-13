import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { DAY_NIGHT } from '../render/daylight';
import { GRAPHICS_PRESETS, presetOf, type Graphics, type GraphicsPreset } from '../render/graphics';
import { gameplay, graphics, soundSettings, type Gameplay, type SoundSettings } from './prefs';

// The player's own settings, kept in this browser: how the game is drawn, how
// it sounds and how it handles. In Settings in the game, and on the title
// screen's Options (loading.ts).

/** One setting: what it is, and its control to the right. */
function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ComponentChildren;
}) {
  return (
    <div class="setting">
      <div>
        <div class="setting-label">{label}</div>
        <div class="muted">{hint}</div>
      </div>
      {children}
    </div>
  );
}

/** Choices side by side, the one in use lit. */
function Segmented<T>({
  label,
  value,
  options,
  pick,
}: {
  label: string;
  value: T | null;
  options: [T, string][];
  pick: (v: T) => void;
}) {
  return (
    <div class="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          class={value === v ? 'on' : ''}
          aria-pressed={value === v}
          onClick={() => pick(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** One graphics setting, with its choices. */
function Choice<K extends keyof Graphics>({
  name,
  label,
  hint,
  options,
}: {
  name: K;
  label: string;
  hint: string;
  options: [Graphics[K], string][];
}) {
  const g = graphics.value;
  return (
    <Row label={label} hint={hint}>
      <Segmented
        label={label}
        value={g[name]}
        options={options}
        pick={(v) => (graphics.value = { ...g, [name]: v })}
      />
    </Row>
  );
}

const PRESETS: [GraphicsPreset, string][] = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['ultra', 'Ultra'],
];

export function GraphicsOptions() {
  const g = graphics.value;
  const preset = presetOf(g);
  return (
    <>
      <Row
        label="Quality"
        hint={
          preset
            ? 'Sets the water, shadows and resolution together'
            : 'Custom: set one by one below'
        }
      >
        <Segmented
          label="Quality"
          value={preset}
          options={PRESETS}
          pick={(p) => (graphics.value = { ...g, ...GRAPHICS_PRESETS[p] })}
        />
      </Row>
      <Choice
        name="water"
        label="Water"
        hint="Ripples, boats' wakes, and shade on the sea"
        options={[
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
        ]}
      />
      <Choice
        name="shadows"
        label="Shadows"
        hint="Shadows from the sun, and how sharp"
        options={[
          ['off', 'Off'],
          ['low', 'Low'],
          ['high', 'High'],
          ['ultra', 'Ultra'],
        ]}
      />
      <Choice
        name="resolution"
        label="Resolution"
        hint="How many pixels it draws, against your screen's"
        options={[
          ['fast', 'Fast'],
          ['balanced', 'Balanced'],
          ['sharp', 'Sharp'],
        ]}
      />
      <Choice
        name="fps"
        label="Frame rate"
        hint="As smooth as your screen goes, or fewer frames to keep a laptop cool"
        options={[
          ['screen', 'Max'],
          ['60', '60'],
          ['30', '30'],
        ]}
      />
      {DAY_NIGHT && (
        <Choice
          name="daylight"
          label="Day and night"
          hint="The sun going round with each game day, and a moonlit night at its end"
          options={[
            ['cycle', 'Day and night'],
            ['day', 'Always day'],
          ]}
        />
      )}
      <p class="muted">
        Lower settings run more smoothly on a slow computer. They are kept in this browser.
      </p>
    </>
  );
}

/** One sound level: what it is, and a slider from silent to full. */
function Level({
  name,
  label,
  hint,
}: {
  name: 'volume' | 'ambience' | 'effects' | 'music';
  label: string;
  hint: string;
}) {
  const s = soundSettings.value;
  return (
    <Row label={label} hint={hint}>
      <div class="level">
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(s[name] * 100)}
          style={{ '--fill': `${Math.round(s[name] * 100)}%` }}
          disabled={!s.on}
          aria-label={label}
          onInput={(e) =>
            (soundSettings.value = {
              ...s,
              [name]: Number(e.currentTarget.value) / 100,
            } as SoundSettings)
          }
        />
        <span class="level-value">{Math.round(s[name] * 100)}%</span>
      </div>
    </Row>
  );
}

export function SoundOptions() {
  return (
    <>
      <Row label="Sound" hint="Every sound in the game, made as you play">
        <Segmented
          label="Sound"
          value={soundSettings.value.on}
          options={[
            [true, 'On'],
            [false, 'Off'],
          ]}
          pick={(on) => (soundSettings.value = { ...soundSettings.value, on })}
        />
      </Row>
      <Level name="volume" label="Volume" hint="Everything together" />
      <Level
        name="effects"
        label="The work"
        hint="Engines, cranes, containers and crates landing, ships' horns, the port's hum from afar"
      />
      <Level name="ambience" label="Sea" hint="Waves washing in and out" />
      <Level
        name="music"
        label="Music"
        hint="Easy-going tunes, written as they play: never quite the same twice"
      />
      <p class="muted">Kept in this browser. Zoom in to hear the work, out to hear the port.</p>
    </>
  );
}

export function GameplayOptions() {
  const g = gameplay.value;
  const set = (change: Partial<Gameplay>) => (gameplay.value = { ...g, ...change });
  return (
    <>
      <Row label="Keyboard panning" hint="How fast the arrow keys and WASD move the view">
        <Segmented<Gameplay['pan']>
          label="Keyboard panning"
          value={g.pan}
          options={[
            ['slow', 'Slow'],
            ['normal', 'Normal'],
            ['fast', 'Fast'],
          ]}
          pick={(pan) => set({ pan })}
        />
      </Row>
      <Row label="Mouse wheel" hint="Which way rolling the wheel zooms">
        <Segmented
          label="Mouse wheel"
          value={g.invertZoom}
          options={[
            [false, 'Standard'],
            [true, 'Inverted'],
          ]}
          pick={(invertZoom) => set({ invertZoom })}
        />
      </Row>
      <Row
        label="Lessons"
        hint="Step-by-step lessons on a new port and each tier, or only when you open the Handbook"
      >
        <Segmented
          label="Lessons"
          value={g.lessons}
          options={[
            [true, 'Show'],
            [false, 'Handbook only'],
          ]}
          pick={(lessons) => set({ lessons })}
        />
      </Row>
      <Row
        label="The mayor"
        hint="The mayor's news about the town: popping up, or only a dot on the portrait"
      >
        <Segmented
          label="The mayor"
          value={g.mayor}
          options={[
            [true, 'Pop up'],
            [false, 'Quietly'],
          ]}
          pick={(mayor) => set({ mayor })}
        />
      </Row>
      <p class="muted">Kept in this browser.</p>
    </>
  );
}

const TABS = [
  ['graphics', 'Graphics', GraphicsOptions],
  ['sound', 'Sound', SoundOptions],
  ['gameplay', 'Gameplay', GameplayOptions],
] as const;

/** The title screen's Options: the settings above, a tab each. */
export function TitleOptions() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('graphics');
  const Body = TABS.find(([id]) => id === tab)![2];
  return (
    <>
      <div class="opt-tabs" role="tablist" aria-label="Options">
        {TABS.map(([id, name]) => (
          <button
            key={id}
            role="tab"
            id={`opt-${id}`}
            aria-selected={tab === id}
            aria-controls="opt-panel"
            class={tab === id ? 'on' : ''}
            onClick={() => setTab(id)}
          >
            {name}
          </button>
        ))}
      </div>
      <div class="settings opts-body" role="tabpanel" id="opt-panel" aria-labelledby={`opt-${tab}`}>
        <Body />
      </div>
    </>
  );
}
