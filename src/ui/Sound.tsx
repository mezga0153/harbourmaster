import { soundSettings } from './prefs';
import { Icon } from './icons';

/** Sound on or off, and how loud, at the top right. */
export function SoundControl() {
  const s = soundSettings.value;
  return (
    <div class="sound-control">
      <button
        class={`btn icon ${s.on ? '' : 'off'}`}
        onClick={() => (soundSettings.value = { ...s, on: !s.on })}
        title={s.on ? 'Sound on: click to mute' : 'Sound off: click to turn it on'}
        aria-pressed={s.on}
        aria-label="Sound"
      >
        <Icon name={s.on ? 'sound' : 'mute'} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(s.volume * 100)}
        style={{ '--fill': `${Math.round(s.volume * 100)}%` }}
        disabled={!s.on}
        aria-label="Volume"
        title="Volume"
        onInput={(e) =>
          (soundSettings.value = { ...s, volume: Number(e.currentTarget.value) / 100 })
        }
      />
    </div>
  );
}
