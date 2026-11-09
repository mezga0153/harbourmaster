import './style.css';
import { button, el, select, slider, toggle } from '../controls';
import { LabPlayer, layerOf, type Layer } from './player';
import {
  audition,
  arrangementFor,
  compose,
  DEFAULT_SETTINGS,
  MOODS,
  noteName,
  shuffleArrangement,
  type Mood,
  type Settings,
} from './score';
import {
  HARMONIES,
  SOURCES,
  TEXTURES,
  THEMES,
  type Harmony,
  type ThemeId,
  type Texture,
} from './palette';

const LAYERS: [Layer, string, string][] = [
  ['keys', 'Piano', 'Recorded upright piano'],
  ['lead', 'Theme', 'Recorded vibraphone'],
  ['bass', 'Bass', 'The ground beneath it'],
  ['pad', 'Air', 'Slow, held fifths'],
  ['percussion', 'Pulse', 'Soft kick and brushed noise'],
];

export function composerTab(): HTMLElement & { activate(on: boolean): void } {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const player = new LabPlayer();
  let piece = compose(settings);
  let currentBar = -1;
  let shownGroup = -1;
  let editTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  const root = el('div', { className: 'lab-composer' });
  const status = el(
    'p',
    { className: 'composer-status' },
    'Ready when you are. Audio starts when you press Play.',
  );
  status.setAttribute('role', 'status');
  const play = button(
    '▶ Play',
    () => {
      if (player.running) stop();
      else void start();
    },
    'composer-primary',
  );
  const readout = el('div', { className: 'composer-readout' });
  const description = el('p', { className: 'composer-description' });
  const timeline = el('div', { className: 'composer-timeline' });
  const score = el('div', { className: 'composer-score' });
  score.setAttribute('role', 'img');
  const playhead = el('div', { className: 'composer-playhead' });
  const bars = Array.from({ length: 32 }, (_, i) => {
    const cell = el('span', { title: `Bar ${i + 1}` }, String(i + 1));
    timeline.append(cell);
    return cell;
  });

  function renderScore(index: number): void {
    const group = Math.floor(index / 4);
    if (group === shownGroup) return;
    shownGroup = group;
    const first = group * 4;
    score.replaceChildren();
    score.setAttribute(
      'aria-label',
      `Score for bars ${first + 1} to ${first + 4}. Colours identify the five instrument layers.`,
    );
    for (let k = first; k < first + 4; k++) {
      const bar = piece.bars[k];
      const column = el('div', { className: 'composer-score-bar' });
      column.append(el('span', { className: 'composer-chord' }, `${k + 1} · ${piece.chords[k]}`));
      for (const note of bar.notes) {
        const layer = layerOf(note.voice);
        const n = el('span', { className: `composer-note ${layer}` });
        n.style.left = `${(note.at / 4) * 100}%`;
        n.style.width = `${(Math.min(note.dur, 4 - note.at) / 4) * 100}%`;
        n.style.top = layer === 'percussion' ? '93%' : `${10 + ((88 - note.midi) / 60) * 75}%`;
        n.style.opacity = String(0.45 + note.vel * 0.5);
        column.append(n);
      }
      score.append(column);
    }
    score.append(playhead);
  }

  function position(index: number, beat: number): void {
    if (currentBar !== index) {
      if (currentBar >= 0) bars[currentBar].classList.remove('on');
      currentBar = index;
      bars[index].classList.add('on');
      slotControls.forEach((slot, i) =>
        slot.root.classList.toggle('on', i === Math.floor(index / 4)),
      );
      renderScore(index);
      readout.textContent = `${piece.phrases[index]} · ${piece.sections[Math.floor(index / 8)]} · ${index + 1} / 32`;
    }
    playhead.style.left = `${(((index % 4) + beat / 4) / 4) * 100}%`;
  }

  function stop(): void {
    request++;
    player.stop();
    play.textContent = '▶ Play';
    play.setAttribute('aria-pressed', 'false');
    playhead.hidden = true;
    bars.forEach((bar) => bar.classList.remove('on'));
    slotControls.forEach((slot) => slot.root.classList.remove('on'));
    currentBar = -1;
    status.textContent = 'Stopped. Play starts the composition from the beginning.';
  }

  async function start(): Promise<void> {
    const id = ++request;
    if (currentBar >= 0) bars[currentBar].classList.remove('on');
    currentBar = -1;
    play.textContent = '■ Stop';
    play.setAttribute('aria-pressed', 'true');
    playhead.hidden = false;
    status.textContent = 'Loading piano and vibraphone…';
    try {
      await player.play(piece.bars, position);
      if (id !== request) return;
      status.textContent =
        'Playing · the 32-bar piece loops. Composition changes restart from the beginning.';
    } catch (error) {
      if (id !== request) return;
      stop();
      status.textContent = `Audio could not start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function listen(
    ingredient: 'theme' | 'harmony' | 'texture',
    source?: ThemeId,
    phrase: 'call' | 'answer' = 'call',
  ): Promise<void> {
    stop();
    const id = ++request;
    const name = source
      ? `${THEMES[source].name} · ${phrase}`
      : ingredient === 'theme'
        ? THEMES[settings.theme].name
        : ingredient === 'harmony'
          ? HARMONIES[settings.harmony].name
          : TEXTURES[settings.texture].name;
    play.textContent = '■ Stop';
    play.setAttribute('aria-pressed', 'true');
    readout.textContent = `Audition · ${name}`;
    status.textContent = `Loading ${name}…`;
    try {
      await player.play(audition(settings, ingredient, source, phrase), () => {}, {
        loop: false,
        ignoreMutes: true,
        onEnded: () => {
          if (id !== request) return;
          stop();
          readout.textContent = '32 bars · ready to combine';
          status.textContent = `${name} audition finished. Press Play to hear the combination.`;
        },
      });
      if (id === request)
        status.textContent = `Audition · ${name} · four bars, then stop. Layer mutes are bypassed for auditions.`;
    } catch (error) {
      if (id !== request) return;
      stop();
      status.textContent = `Could not load the instruments: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function hearBlock(index: number, loop: boolean): Promise<void> {
    stop();
    const id = ++request;
    play.textContent = '■ Stop';
    play.setAttribute('aria-pressed', 'true');
    playhead.hidden = false;
    currentBar = -1;
    const first = index * 4;
    status.textContent = `Loading bars ${first + 1}–${first + 4}…`;
    try {
      await player.play(
        piece.bars.slice(first, first + 4),
        (bar, beat) => position(first + bar, beat),
        {
          loop,
          onEnded: () => {
            if (id !== request) return;
            stop();
            status.textContent = `Bars ${first + 1}–${first + 4} finished. Play starts the full piece.`;
          },
        },
      );
      if (id === request)
        status.textContent = `${loop ? 'Looping' : 'Playing'} bars ${first + 1}–${first + 4} · ${piece.phrases[first]}.`;
    } catch (error) {
      if (id !== request) return;
      stop();
      status.textContent = `Audio could not start: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function recompose(): void {
    clearTimeout(editTimer);
    editTimer = undefined;
    const wasPlaying = player.running;
    stop();
    piece = compose(settings);
    if (currentBar >= 0) bars[currentBar].classList.remove('on');
    currentBar = -1;
    shownGroup = -1;
    description.textContent = THEMES[settings.theme].description;
    key.textContent = `${noteName(piece.tonic)} ${piece.mode} · 4/4 · ${settings.tempo} BPM`;
    readout.textContent = '32 bars · complete calls and answers';
    themeSelect.querySelector('select')!.value = settings.theme;
    harmonySelect.querySelector('select')!.value = settings.harmony;
    textureSelect.querySelector('select')!.value = settings.texture;
    harmonyInfo.textContent = `${HARMONIES[settings.harmony].name} · ${piece.chords.slice(0, 8).join(' → ')}`;
    slotControls.forEach((control, i) => {
      const slot = piece.slots[i];
      control.select.value = slot.theme === 'rest' ? 'rest' : `${slot.theme}:${slot.phrase}`;
      control.lock.checked = slot.locked;
      control.root.classList.toggle('locked', slot.locked);
      control.root.classList.remove('on');
    });
    renderScore(0);
    status.textContent =
      'Ready. The seed rearranges whole phrases; the tune keeps its notes and rhythm.';
    if (wasPlaying) void start();
  }

  function changed(): void {
    clearTimeout(editTimer);
    editTimer = setTimeout(recompose, 200);
  }

  const key = el('span', { className: 'composer-key' });
  const harmonyInfo = el('p', { className: 'composer-harmony-info' });
  const themeSelect = select<ThemeId>(
    'Theme',
    Object.entries(THEMES).map(([id, theme]) => [id as ThemeId, theme.name]),
    settings.theme,
    (value) => {
      settings.theme = value;
      recompose();
    },
  );
  const harmonySelect = select<Harmony>(
    'Chords',
    Object.entries(HARMONIES).map(([id, harmony]) => [id as Harmony, harmony.name]),
    settings.harmony,
    (value) => {
      settings.harmony = value;
      recompose();
    },
  );
  const textureSelect = select<Texture>(
    'Pattern',
    Object.entries(TEXTURES).map(([id, texture]) => [id as Texture, texture.name]),
    settings.texture,
    (value) => {
      settings.texture = value;
      recompose();
    },
  );
  const tempo = slider(
    'Tempo',
    settings.tempo,
    (v) => {
      settings.tempo = v;
      changed();
    },
    40,
    140,
    1,
  );
  const seed = el('input', { type: 'text', value: settings.seed, maxLength: 80 });
  const seedForm = el(
    'form',
    { className: 'composer-seed' },
    el('label', {}, 'Seed', seed),
    el('button', { type: 'submit' }, 'Recompose'),
    button('New seed', () => {
      settings.seed = `harbour-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
      seed.value = settings.seed;
      recompose();
    }),
  );
  seedForm.onsubmit = (event) => {
    event.preventDefault();
    settings.seed = seed.value.trim() || 'a quiet harbour';
    seed.value = settings.seed;
    recompose();
  };
  // Utility buttons inside the seed form must not also submit it.
  seedForm.querySelectorAll('button').forEach((b) => {
    if (!b.hasAttribute('type')) b.type = 'button';
  });

  const layers = el('div', { className: 'composer-layers' });
  for (const [id, name, detail] of LAYERS) {
    const toggle = button(
      '',
      () => {
        if (player.muted.has(id)) player.muted.delete(id);
        else player.muted.add(id);
        const muted = player.muted.has(id);
        toggle.classList.toggle('muted', muted);
        toggle.setAttribute('aria-pressed', String(!muted));
        score.classList.toggle(`mute-${id}`, muted);
      },
      `composer-layer ${id}`,
    );
    toggle.append(el('strong', {}, name), el('small', {}, detail));
    toggle.setAttribute('aria-label', `${name} layer`);
    toggle.setAttribute('aria-pressed', 'true');
    layers.append(toggle);
  }

  const slotGrid = el('div', { className: 'composer-slots' });
  const slotControls = Array.from({ length: 8 }, (_, i) => {
    const choices: [string, string][] = [
      ['follow:call', 'Home theme · call'],
      ['follow:answer', 'Home theme · answer'],
      ...Object.entries(THEMES).flatMap(([id, theme]): [string, string][] => [
        [`${id}:call`, `${theme.name} · call`],
        [`${id}:answer`, `${theme.name} · answer`],
      ]),
      ['rest', 'Melody break · backing only'],
    ];
    const picker = select(`Bars ${i * 4 + 1}–${i * 4 + 4}`, choices, 'follow:call', (value) => {
      const slots = arrangementFor(settings);
      const [theme, phrase] = value.split(':');
      slots[i] = {
        ...slots[i],
        theme: theme as ThemeId | 'follow' | 'rest',
        phrase: phrase === 'answer' ? 'answer' : 'call',
      };
      settings.slots = slots;
      recompose();
    });
    const keep = toggle('Keep', false, (value) => {
      const slots = arrangementFor(settings);
      slots[i].locked = value;
      settings.slots = slots;
      row.classList.toggle('locked', value);
    });
    const row = el(
      'div',
      { className: 'composer-slot' },
      picker,
      el(
        'div',
        { className: 'composer-slot-actions' },
        button('Hear', () => void hearBlock(i, false)),
        button('Loop', () => void hearBlock(i, true)),
        keep,
      ),
    );
    keep
      .querySelector('input')!
      .setAttribute('aria-label', `Keep bars ${i * 4 + 1}–${i * 4 + 4} when shuffling`);
    slotGrid.append(row);
    return {
      root: row,
      select: picker.querySelector('select')!,
      lock: keep.querySelector('input')!,
    };
  });
  const arranger = el(
    'section',
    { className: 'composer-panel composer-blocks' },
    el(
      'div',
      { className: 'composer-score-heading' },
      el('h2', {}, 'Arrange the phrases'),
      el(
        'div',
        { className: 'lab-row' },
        button('Shuffle phrases', () => {
          settings.seed = `harbour-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
          seed.value = settings.seed;
          settings.slots = shuffleArrangement(settings);
          recompose();
        }),
        button('Use home theme', () => {
          settings.slots = undefined;
          recompose();
        }),
      ),
    ),
    el(
      'p',
      { className: 'composer-hint' },
      'Each block is four bars. Mix calls and answers from different scores; all phrases follow the home theme’s key and mode. Keep a block to protect it when shuffling. A melody break leaves the backing playing.',
    ),
    slotGrid,
  );

  const library = el(
    'section',
    { className: 'composer-panel composer-library' },
    el('h2', {}, 'The ingredient shelf'),
    el(
      'p',
      { className: 'composer-hint' },
      'Short phrases from public-domain scores. Hear one on its own, then combine its theme, harmony, or accompaniment above. All clips share a key and a four-beat clock.',
    ),
  );
  const cards = el('div', { className: 'composer-source-cards' });
  for (const [id, theme] of Object.entries(THEMES) as [ThemeId, (typeof THEMES)[ThemeId]][]) {
    const source = SOURCES[theme.source];
    cards.append(
      el(
        'article',
        { className: 'composer-source' },
        el('span', { className: 'composer-eyebrow' }, `${source.composer} · ${source.license}`),
        el(
          'h3',
          {},
          el('a', { href: source.url, target: '_blank', rel: 'noreferrer' }, theme.name),
        ),
        el('p', {}, THEMES[id].description),
        el(
          'div',
          { className: 'lab-row' },
          button('Hear call', () => void listen('theme', id, 'call')),
          button('Hear answer', () => void listen('theme', id, 'answer')),
          button('Use theme', () => {
            settings.theme = id;
            recompose();
          }),
        ),
        el(
          'details',
          {},
          el('summary', {}, 'Source & adaptation'),
          el('p', {}, source.extraction),
          el('small', {}, source.credit),
        ),
      ),
    );
  }
  library.append(cards);

  root.append(
    el(
      'div',
      { className: 'composer-content' },
      el(
        'header',
        { className: 'composer-heading' },
        el(
          'div',
          {},
          el('span', { className: 'composer-eyebrow' }, 'Soundtrack experiment / 03'),
          el('h1', {}, 'A few good phrases. A new little tune.'),
          el('p', {}, 'Borrow a theme, choose the chords, try another pattern. Dev lab only.'),
        ),
        el('span', { className: 'composer-badge' }, 'Phrase composer'),
      ),
      el(
        'section',
        { className: 'composer-panel composer-transport' },
        el('div', { className: 'lab-row' }, play, key),
        slider('Volume', 0.65, (v) => player.setVolume(v)),
        slider('Space', 0.18, (v) => player.setSpace(v)),
      ),
      el(
        'div',
        { className: 'composer-workspace' },
        el(
          'section',
          { className: 'composer-panel composer-settings' },
          el('h2', {}, 'Mix the ingredients'),
          select<Mood>(
            'Preset',
            Object.entries(MOODS).map(([id, value]) => [id as Mood, value.name]),
            settings.mood,
            (v) => {
              settings.mood = v;
              settings.tempo = MOODS[v].tempo;
              settings.theme = MOODS[v].theme;
              settings.harmony = MOODS[v].harmony;
              settings.texture = MOODS[v].texture;
              settings.slots = undefined;
              tempo.querySelector('input')!.value = String(settings.tempo);
              tempo.querySelector('output')!.textContent = String(settings.tempo);
              recompose();
            },
          ),
          themeSelect,
          description,
          harmonySelect,
          textureSelect,
          el(
            'div',
            { className: 'composer-auditions' },
            button('Hear theme', () => void listen('theme')),
            button('Hear chords', () => void listen('harmony')),
            button('Hear pattern', () => void listen('texture')),
          ),
          toggle('Fit strong notes to chords', settings.fit, (value) => {
            settings.fit = value;
            recompose();
          }),
          tempo,
          slider('Density', settings.density, (v) => {
            settings.density = v;
            changed();
          }),
          seedForm,
          el(
            'p',
            { className: 'composer-hint' },
            'Density changes the accompaniment, keeping the theme intact. The seed chooses how complete calls and answers follow each other.',
          ),
        ),
        el(
          'section',
          { className: 'composer-panel composer-arrangement' },
          el(
            'div',
            { className: 'composer-score-heading' },
            el('h2', {}, 'The arrangement'),
            readout,
          ),
          harmonyInfo,
          el(
            'div',
            { className: 'composer-phrases' },
            ...piece.sections.map((name) => el('span', {}, name)),
          ),
          timeline,
          score,
          el(
            'p',
            { className: 'composer-hint' },
            'Four bars at a time · higher notes sit higher · the line follows the audio clock',
          ),
          layers,
          el(
            'p',
            { className: 'composer-hint' },
            'Click a layer to mute it from the next bar. Piano and vibraphone use the game’s CC0 instrument samples; the bass and quiet air are synthesized.',
          ),
        ),
      ),
      arranger,
      library,
      status,
    ),
  );
  recompose();
  playhead.hidden = true;
  const deactivate = () => {
    stop();
    if (editTimer !== undefined) recompose();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) deactivate();
  });
  window.addEventListener('pagehide', deactivate);
  return Object.assign(root, {
    activate(on: boolean) {
      if (!on) deactivate();
    },
  });
}
