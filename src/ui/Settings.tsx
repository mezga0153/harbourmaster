import { useRef } from 'preact/hooks';
import type { Actions } from './actions';
import { Icon } from './icons';
import { GameplayOptions, GraphicsOptions, SoundOptions } from './Options';
import { newGameOpen, panel, pushMessage } from './store';
import { InfoHeader } from './widgets';

/**
 * Settings, from the harbour mark at the top left: how the game is drawn,
 * how it sounds and handles, saving to a file, and back to the title screen.
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
      <GraphicsOptions />

      <div class="section-title">
        <span>Sound</span>
      </div>
      <SoundOptions />

      <div class="section-title">
        <span>Gameplay</span>
      </div>
      <GameplayOptions />

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
        {actions.mainMenu && (
          <button class="btn" onClick={actions.mainMenu}>
            <Icon name="exit" />
            <span>Main menu</span>
          </button>
        )}
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
      {import.meta.env.DEV && (
        <>
          <div class="section-title">
            <span>Dev server</span>
          </div>
          <div class="actions">
            {/* src/debug/: paths, passability, slots and more drawn over the map (`). */}
            <button class="btn" onClick={() => window.dispatchEvent(new Event('hm-debug'))}>
              <Icon name="map" />
              <span>Debug overlays</span>
            </button>
          </div>
        </>
      )}
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
