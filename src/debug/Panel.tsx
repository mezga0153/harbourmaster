import type { GameMap } from '../sim/map';
import { PILOTS, type PilotId } from '../sim/systems/boats/pilots';
import { Build } from '../sim/types';
import { hover, selection } from '../ui/store';
import { FINE } from './fine';
import { lastView, opts, setOpt, type DebugOpts } from './state';
import { PASS_BLOCKED, PASS_COSTLY, PASS_HIDDEN, PASS_OK, type PassKind } from './types';

// Dev server only: the debug overlays' menu, and what it says about the
// selected entity and the tile under the pointer.

const BUILD_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(Build).map(([k, v]) => [v, k]),
);
const PASS_NAME: Record<number, string> = {
  [PASS_OK]: 'ok',
  [PASS_COSTLY]: 'costly',
  [PASS_BLOCKED]: 'blocked',
  [PASS_HIDDEN]: 'blocked (unbuilt)',
};

function Check({ k, label }: { k: keyof DebugOpts; label: string }) {
  return (
    <label class="dbg-row">
      <input
        type="checkbox"
        checked={!!opts.value[k]}
        onChange={(e) => setOpt(k, e.currentTarget.checked as never)}
      />
      {label}
    </label>
  );
}

function Pick<T extends string>({
  k,
  label,
  options,
}: {
  k: 'pass' | 'fine';
  label: string;
  options: [T | null, string][];
}) {
  const v = opts.value[k];
  return (
    <label class="dbg-row">
      {label}
      <select value={v ?? ''} onChange={(e) => setOpt(k, (e.currentTarget.value || null) as never)}>
        {options.map(([value, text]) => (
          <option key={value ?? ''} value={value ?? ''}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function HoverInfo({ map }: { map: GameMap }) {
  const h = hover.value;
  if (!h) return <div class="dbg-muted">Point at a tile</div>;
  const i = map.idx(h.x, h.y);
  const o = map.orient[i];
  const bits = [
    o & 4 && 'ext',
    o & 8 && 'machines',
    o & 16 && '16',
    o & 32 && '32',
    o & 64 && 'quay',
  ]
    .filter(Boolean)
    .join(' ');
  const v = lastView.value;
  const grid = v?.pass?.grid;
  const pass = grid && grid.cell === 1 ? PASS_NAME[grid.values[i]] : null;
  const bay = v?.slots?.find((b) => b.tiles.includes(i));
  const plot = map.plotOf(i);
  return (
    <div class="dbg-kv">
      <div>
        tile <b>{i}</b> ({h.x}, {h.y})
      </div>
      <div>
        {BUILD_NAME[map.build[i]] ?? map.build[i]} · terrain {map.terrain[i]} · depth{' '}
        {map.depth[i].toFixed(1)}
      </div>
      <div>
        orient {o} = facing {o & 3}
        {bits && ` + ${bits}`} · store {map.store[i]}
      </div>
      <div>
        plot {plot} {plot >= 0 && (map.plots[plot] ? 'owned' : 'not owned')}
      </div>
      {pass && (
        <div>
          {v!.pass!.kind}: {pass}
        </div>
      )}
      {bay && (
        <div>
          {bay.name}: {bay.note}
          {bay.cap > 0 && ` · slots ${bay.used.length}/${bay.cap}, kept ${bay.kept.length}`}
        </div>
      )}
    </div>
  );
}

function Job() {
  const v = lastView.value;
  const s = selection.value;
  if (s?.type !== 'entity') return <div class="dbg-muted">Select a worker, machine or truck</div>;
  if (!v?.job) return <div class="dbg-muted">…</div>;
  const path = v.paths.find((p) => p.id === s.id);
  return (
    <div class="dbg-kv">
      {path && (
        <div>
          path {path.path.length} tiles → goal <b>{path.goal}</b>
        </div>
      )}
      <table>
        <tbody>
          {v.job
            .filter(([k]) => k !== 'path')
            .map(([k, val]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{val}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function Panel({ map }: { map: () => GameMap | null }) {
  const o = opts.value;
  if (!o.open) return null;
  const m = map();
  return (
    <div class="dbg-panel">
      <div class="dbg-head">
        <b>Debug overlays</b>
        <span class="dbg-muted">` to close</span>
        {!location.pathname.endsWith('/dev.html') && (
          <a class="dbg-lab" href="/dev.html" target="_blank" rel="noopener">
            Dev lab ↗
          </a>
        )}
        <button onClick={() => setOpt('open', false)}>×</button>
      </div>
      <Check k="on" label="Draw overlays" />
      <Check k="allPaths" label="All paths (else the selected)" />
      <Check k="labels" label="What each is doing" />
      <Pick<PassKind | 'auto'>
        k="pass"
        label="Tiles"
        options={[
          [null, 'off'],
          ['auto', 'for the selected'],
          ['walk', 'dockhands walk'],
          ['drive', 'machines drive'],
          ['fork', 'forklifts (crates)'],
          ['truck', 'trucks'],
        ]}
      />
      <Pick<string>
        k="fine"
        label="Fine"
        options={[
          [null, 'off'],
          ...Object.entries(FINE).map(([k, f]) => [k, f.label] as [string, string]),
        ]}
      />
      <Check k="roads" label="Truck road graph" />
      <Check k="slots" label="Crate slots, bays cut off" />
      <Check k="cranes" label="Crane reach" />
      <Check k="plots" label="Land plots" />
      <Check k="hover" label="Tile under the pointer" />
      <label class="dbg-row" title={PILOTS[o.pilot].note}>
        Ship pathing
        <select value={o.pilot} onChange={(e) => setOpt('pilot', e.currentTarget.value as PilotId)}>
          {Object.entries(PILOTS).map(([id, p]) => (
            <option key={id} value={id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div class="dbg-muted">{PILOTS[o.pilot].note}</div>
      <div class="dbg-legend">
        <span style="color:#3ddc68">■ ok</span> <span style="color:#f5c02a">■ costly</span>{' '}
        <span style="color:#ff3b30">■ blocked</span> <span style="color:#4fb3ff">■ crate</span>{' '}
        <span style="color:#ff9f1c">■ kept</span>
      </div>
      {o.hover && m && (
        <>
          <div class="dbg-title">Tile</div>
          <HoverInfo map={m} />
        </>
      )}
      <div class="dbg-title">Selected</div>
      <Job />
    </div>
  );
}
