// Bits of page for the dev lab: elements, buttons, sliders and the
// parameter panels the galleries build from each item's params.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { dataset?: Record<string, string> } = {},
  ...kids: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const { dataset, ...rest } = props;
  const e = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(e.dataset, dataset);
  e.append(...kids.filter((k): k is Node | string => !!k));
  return e;
}

export function button(text: string, onclick: () => void, className = ''): HTMLButtonElement {
  return el('button', { onclick, className }, text);
}

export function slider(
  text: string,
  value: number,
  onInput: (v: number) => void,
  min = 0,
  max = 1,
  step = 0.01,
): HTMLLabelElement {
  const input = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
  });
  input.value = String(value);
  const shown = el('output', {}, fmt(value));
  input.oninput = () => {
    shown.textContent = fmt(Number(input.value));
    onInput(Number(input.value));
  };
  return el('label', { className: 'lab-ctl' }, el('span', {}, text), input, shown);
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function select<T extends string>(
  text: string,
  options: readonly (readonly [T, string])[],
  value: T,
  onChange: (v: T) => void,
): HTMLLabelElement {
  const s = el('select', {});
  for (const [v, label] of options) s.append(el('option', { value: v }, label));
  s.value = value;
  s.onchange = () => onChange(s.value as T);
  return el('label', { className: 'lab-ctl' }, el('span', {}, text), s);
}

export function toggle(
  text: string,
  value: boolean,
  onChange: (v: boolean) => void,
): HTMLLabelElement {
  const c = el('input', { type: 'checkbox' });
  c.checked = value;
  c.onchange = () => onChange(c.checked);
  return el('label', { className: 'lab-ctl lab-check' }, c, el('span', {}, text));
}

/** A control an item offers over how it is made or run. */
export type Param =
  | {
      key: string;
      label: string;
      kind: 'range';
      min: number;
      max: number;
      step?: number;
      value: number;
      live?: boolean;
    }
  | {
      key: string;
      label: string;
      kind: 'select';
      options: readonly (readonly [string, string])[];
      value: string;
      live?: boolean;
    }
  | { key: string; label: string; kind: 'toggle'; value: boolean; live?: boolean };

export type RangeParam = Extract<Param, { kind: 'range' }>;

export type Params = Record<string, number | string | boolean>;

export function defaults(params: readonly Param[]): Params {
  return Object.fromEntries(params.map((p) => [p.key, p.value]));
}

/**
 * Controls for `params`, telling `onLive` of a change to a live one (taken
 * up by what is shown as it stands) and `onRebuild` of any other (what is
 * shown is made again).
 */
export function paramPanel(
  params: readonly Param[],
  values: Params,
  onLive: () => void,
  onRebuild: () => void,
): HTMLElement {
  const panel = el('div', { className: 'lab-params' });
  for (const p of params) {
    const changed = () => (p.live ? onLive() : onRebuild());
    if (p.kind === 'range') {
      panel.append(
        slider(
          p.label,
          values[p.key] as number,
          (v) => {
            values[p.key] = v;
            changed();
          },
          p.min,
          p.max,
          p.step ??
            (Number.isInteger(p.min) && Number.isInteger(p.max) && p.max - p.min <= 40 ? 1 : 0.01),
        ),
      );
    } else if (p.kind === 'select') {
      panel.append(
        select(p.label, p.options, values[p.key] as string, (v) => {
          values[p.key] = v;
          changed();
        }),
      );
    } else {
      panel.append(
        toggle(p.label, values[p.key] as boolean, (v) => {
          values[p.key] = v;
          changed();
        }),
      );
    }
  }
  return panel;
}

/** Integers from `a` to `b` as select options. */
export function range(a: number, b: number, label = (k: number) => String(k)): [string, string][] {
  return Array.from({ length: b - a + 1 }, (_, k) => [String(a + k), label(a + k)]);
}
