import { useRef } from 'preact/hooks';
import { soundSettings, type SoundSettings } from '../audio/sound';
import type { Graphics } from '../render/graphics';
import type { Actions } from './actions';
import { Icon } from './icons';
import { graphics } from './prefs';
import { newGameOpen, panel, pushMessage } from './store';
import { InfoHeader } from './widgets';

/** One graphics setting: what it is, and its choices side by side. */
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
    <div class="setting">
      <div>
        <div class="setting-label">{label}</div>
        <div class="muted">{hint}</div>
      </div>
      <div class="segmented" role="group" aria-label={label}>
        {options.map(([value, text]) => (
          <button
            key={String(value)}
            class={g[name] === value ? 'on' : ''}
            aria-pressed={g[name] === value}
            onClick={() => (graphics.value = { ...g, [name]: value })}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
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
    <div class="setting">
      <div>
        <div class="setting-label">{label}</div>
        <div class="muted">{hint}</div>
      </div>
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
    </div>
  );
}

/**
 * Settings, from the harbour mark at the top left: how the game is drawn,
 * how it sounds, and saving to a file.
 */
export function SettingsPanel({ actions }: { actions: Actions }) {
  const picker = useRef<HTMLInputElement>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    const sure = window.confirm(
      `Load ${file.name}? It replaces the game you are playing: save that to a file first to keep it.`,
    );
    if (!sure) return;
    let save: unknown;
    try {
      save = JSON.parse(await file.text());
    } catch {
      pushMessage(`${file.name} is not a Harbourmaster save.`, 'bad');
      return;
    }
    actions.send({ type: 'importSave', save, name: file.name });
  };

  return (
    <aside class="side panel wide settings" aria-label="Settings">
      <InfoHeader kicker="Harbourmaster" title="Settings" onClose={() => (panel.value = null)} />

      <div class="section-title">
        <span>Graphics</span>
      </div>
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
      <p class="muted">
        Lower settings run more smoothly on a slow computer. They are kept in this browser.
      </p>

      <div class="section-title">
        <span>Sound</span>
      </div>
      <div class="setting">
        <div>
          <div class="setting-label">Sound</div>
          <div class="muted">Every sound in the game, made as you play</div>
        </div>
        <div class="segmented" role="group" aria-label="Sound">
          {[true, false].map((on) => (
            <button
              key={String(on)}
              class={soundSettings.value.on === on ? 'on' : ''}
              aria-pressed={soundSettings.value.on === on}
              onClick={() => (soundSettings.value = { ...soundSettings.value, on })}
            >
              {on ? 'On' : 'Off'}
            </button>
          ))}
        </div>
      </div>
      <Level name="volume" label="Volume" hint="Everything together" />
      <Level
        name="effects"
        label="The work"
        hint="Engines, cranes, containers and crates landing, ships' horns, the port's hum from afar"
      />
      <Level
        name="ambience"
        label="Sea"
        hint="Waves washing in, and slapping at the quay walls up close"
      />
      <Level
        name="music"
        label="Music"
        hint="Easy-going tunes, written as they play: never quite the same twice"
      />
      <p class="muted">Kept in this browser. Zoom in to hear the work, out to hear the port.</p>

      <div class="section-title">
        <span>Your game</span>
      </div>
      <p class="muted">
        The game saves itself in this browser every day. Save it to a file to keep a copy, go back
        to it later, or carry on on another computer.
      </p>
      <div class="actions">
        <button class="btn" onClick={() => picker.current?.click()}>
          <Icon name="folder" />
          <span>Load from a file</span>
        </button>
        <button class="btn primary" onClick={() => actions.send({ type: 'exportSave' })}>
          <Icon name="save" />
          <span>Save to a file</span>
        </button>
      </div>
      <div class="actions">
        <button class="btn" onClick={() => (newGameOpen.value = true)}>
          <Icon name="map" />
          <span>Start a new port</span>
        </button>
      </div>

      <div class="section-title">
        <span>Tell us</span>
      </div>
      <p class="muted">
        Found a bug, or thought of something the game should have? It goes straight to the people
        making it.
      </p>
      <div class="actions">
        <button class="btn" onClick={() => (panel.value = 'feedback')}>
          <Icon name="chat" />
          <span>Report a bug or share an idea</span>
        </button>
      </div>
      <input
        ref={picker}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const input = e.currentTarget;
          const file = input.files?.[0];
          // The same file can be picked again later.
          input.value = '';
          void load(file);
        }}
      />
    </aside>
  );
}
