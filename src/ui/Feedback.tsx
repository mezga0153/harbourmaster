import { signal } from '@preact/signals';
import { soundSettings } from '../audio/sound';
import { context, sendFeedback, type FeedbackKind } from '../log/feedback';
import { Icon } from './icons';
import { graphics } from './prefs';
import { messages, panel, selection, snapshot } from './store';
import { InfoHeader } from './widgets';

// Telling us about a bug, an idea or anything else, from Settings: what the
// player writes, and if they let it their game and a picture of the view,
// sent by src/log/feedback.ts. What they were writing stays while the panel
// is closed, until it is sent.

const kind = signal<FeedbackKind>('bug');
const text = signal('');
const contact = signal('');
/** Sending the game and a picture: yes for a bug unless the player says not. */
const withGame = signal<boolean | null>(null);
const withPicture = signal<boolean | null>(null);
const state = signal<'writing' | 'sending' | 'sent' | 'failed'>('writing');

const KINDS: [FeedbackKind, string][] = [
  ['bug', 'A bug'],
  ['idea', 'An idea'],
  ['other', 'Something else'],
];
const PROMPT: Record<FeedbackKind, string> = {
  bug: 'What happened, and what did you expect? What were you doing just before?',
  idea: 'What would you like the game to have, or do differently?',
  other: 'Anything at all',
};

/** A yes or no, as the settings have them. */
function YesNo({
  label,
  hint,
  value,
  set,
}: {
  label: string;
  hint: string;
  value: boolean;
  set: (v: boolean) => void;
}) {
  return (
    <div class="setting">
      <div>
        <div class="setting-label">{label}</div>
        <div class="muted">{hint}</div>
      </div>
      <div class="segmented" role="group" aria-label={label}>
        {[true, false].map((on) => (
          <button
            key={String(on)}
            class={value === on ? 'on' : ''}
            aria-pressed={value === on}
            onClick={() => set(on)}
          >
            {on ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
    </div>
  );
}

async function send(game: boolean, picture: boolean): Promise<void> {
  state.value = 'sending';
  const sel = selection.peek();
  const ctx = context(snapshot.peek(), {
    messages: messages.peek().map((m) => m.text),
    selected: sel ? JSON.stringify(sel) : null,
    settings: { ...graphics.peek(), sound: soundSettings.peek().on },
  });
  const ok = await sendFeedback(
    {
      kind: kind.peek(),
      text: text.peek(),
      contact: contact.peek(),
      withGame: game,
      withPicture: picture,
    },
    ctx,
  );
  state.value = ok ? 'sent' : 'failed';
  if (ok) {
    text.value = '';
    withGame.value = withPicture.value = null;
  }
}

export function FeedbackPanel() {
  const k = kind.value;
  const game = withGame.value ?? k === 'bug';
  const picture = withPicture.value ?? k === 'bug';
  const close = () => {
    if (state.peek() === 'sent') state.value = 'writing';
    panel.value = null;
  };
  if (state.value === 'sent') {
    return (
      <aside class="side panel wide settings feedback" aria-label="Tell us">
        <InfoHeader kicker="Harbourmaster" title="Thank you" onClose={close} />
        <p>It has been sent, and will be read.</p>
        <div class="actions">
          <button class="btn" onClick={() => (state.value = 'writing')}>
            <Icon name="chat" />
            <span>Tell us something else</span>
          </button>
          <button class="btn primary" onClick={close}>
            <span>Back to the port</span>
          </button>
        </div>
      </aside>
    );
  }
  const busy = state.value === 'sending';
  return (
    <aside class="side panel wide settings feedback" aria-label="Tell us">
      <InfoHeader kicker="Harbourmaster" title="Tell us" onClose={close} />
      <p class="muted">
        A bug, an idea, or anything else: it goes straight to the people making the game.
      </p>
      <div class="segmented" role="group" aria-label="What is it">
        {KINDS.map(([id, label]) => (
          <button
            key={id}
            class={k === id ? 'on' : ''}
            aria-pressed={k === id}
            onClick={() => (kind.value = id)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        rows={7}
        maxLength={5000}
        placeholder={PROMPT[k]}
        value={text.value}
        onInput={(e) => (text.value = e.currentTarget.value)}
      />
      <input
        type="text"
        maxLength={200}
        placeholder="Your email, if you would like an answer (optional)"
        value={contact.value}
        onInput={(e) => (contact.value = e.currentTarget.value)}
      />
      <YesNo
        label="Send my game"
        hint="Your port as it is now, so the bug can be seen for ourselves"
        value={game}
        set={(v) => (withGame.value = v)}
      />
      <YesNo
        label="Send a picture"
        hint="Of the view as it is behind this panel"
        value={picture}
        set={(v) => (withPicture.value = v)}
      />
      <p class="muted">
        With it go the game's version, the day, your screen's size and the last few messages;
        nothing about who you are unless you write it.
      </p>
      {state.value === 'failed' && (
        <p class="note bad">It could not be sent: are you online? Your words are still here.</p>
      )}
      <div class="actions">
        <button class="btn" onClick={close}>
          <span>Not now</span>
        </button>
        <button
          class="btn primary"
          disabled={busy || !text.value.trim()}
          onClick={() => void send(game, picture)}
        >
          <Icon name="chat" />
          <span>{busy ? 'Sending…' : 'Send'}</span>
        </button>
      </div>
    </aside>
  );
}
