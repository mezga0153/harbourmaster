import { useRef } from 'preact/hooks';
import type { Graphics } from '../render/graphics';
import type { Actions } from './App';
import { Icon } from './icons';
import { graphics } from './prefs';
import { panel, pushMessage } from './store';
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

/** Settings, from the harbour mark at the top left: how the game is drawn, and saving to a file. */
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
