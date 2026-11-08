import * as B from '../sim/balance';
import type { PortTrainState } from '../sim/railway';
import { duration } from './format';
import { selection, snapshot } from './store';
import { InfoHeader, More, Why } from './widgets';

// A siding off the main line: how long it is and what train it holds, the
// container yards beside it its trains are worked from, and the train in
// it now, with what is still to come off it and go on.

/** What a port train in its siding is doing, in words. */
const DOING: Record<PortTrainState, string> = {
  due: 'Coming: waiting off the line for the main line to clear',
  in: 'Pulling in',
  standing: 'Standing, to be unloaded and loaded',
  out: 'Backing out onto the main line',
  away: 'On its way',
};

export function SidingInfo({ idx }: { idx: number }) {
  const s = snapshot.value;
  const siding = s?.sidings.find((x) => x.switch === idx);
  if (!s || !siding) return null;
  const close = () => (selection.value = null);
  const train = s.trains.find((t) => t.id === siding.train);
  const line = train?.port?.contractId;
  const name = s.contracts.find((c) => c.id === line)?.terms.name;
  const cells = train?.port?.cells ?? [];
  const brought = cells.filter((c) => c?.out).length;
  const taken = cells.filter((c) => c && !c.out).length;
  const leaves = train?.port?.state === 'standing' ? train.port.leaves - s.tick : 0;
  const wagons = Math.max(0, siding.cars - 1);
  return (
    <aside class="side panel" aria-label="Rail siding">
      <InfoHeader kicker="Railway" title="Rail siding" onClose={close} />
      <p class="muted">
        Track off the main line where a rail line's container trains stand. Reach stackers unload
        what each brings into a container yard for cargo going out, and load it from one for cargo
        coming in, a row or two off the track. <More topic="containers" />
      </p>
      <dl class="props">
        <dt>Length</dt>
        <dd>
          {siding.tiles.length} tiles: a train of {wagons} wagon{wagons === 1 ? '' : 's'},{' '}
          {Math.min(wagons, B.TRAIN_MAX_WAGONS) * B.WAGON_BOXES} containers
        </dd>
        <dt>Yards beside it</dt>
        <dd>
          {siding.yards === 0
            ? 'None'
            : `${siding.yardsIn} for cargo coming in, ${siding.yardsOut} going out`}
        </dd>
        {siding.crossings > 0 && (
          <>
            <dt>Level crossings</dt>
            <dd>
              {siding.crossings}: kept clear while a train is on one, gone round while one stands
              across it
            </dd>
          </>
        )}
      </dl>
      {siding.why && <Why topic="containers">{siding.why}.</Why>}
      {train?.port ? (
        <>
          <p class="status">
            <span class={`dot ${train.port.state === 'standing' ? 'live' : ''}`} />
            {name ? `${name}'s train: ` : 'A train: '}
            {DOING[train.port.state].toLowerCase()}
          </p>
          {train.port.contractId !== undefined && (
            <dl class="props">
              <dt>Still to unload</dt>
              <dd>
                {brought} container{brought === 1 ? '' : 's'} to go out on the feeders
              </dd>
              <dt>Loaded</dt>
              <dd>
                {taken} of {train.port.take ?? 0} off the feeders
              </dd>
              {train.port.state === 'standing' && (
                <>
                  <dt>Leaves</dt>
                  <dd>once worked, or in {duration(Math.max(0, leaves))} at most</dd>
                </>
              )}
            </dl>
          )}
        </>
      ) : (
        <p class="status">
          <span class="dot" />
          No train in it
        </p>
      )}
    </aside>
  );
}
