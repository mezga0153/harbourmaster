import type { Command } from '../protocol';
import * as B from '../sim/balance';
import { money } from './format';
import { land, landOffer, snapshot } from './store';
import { InfoHeader } from './widgets';

/** Asks before a plot of land is bought, with what it costs and what comes after. */
export function LandDialog({ send }: { send(cmd: Command): void }) {
  const offer = landOffer.value;
  if (!offer) return null;
  const cash = snapshot.value?.cash ?? 0;
  const short = offer.price > cash;
  const close = () => (landOffer.value = null);
  const buy = () => {
    send({ type: 'buyPlot', plot: offer.plot });
    close();
  };
  return (
    <div class="backdrop" onClick={close}>
      <div
        class="dialog panel"
        role="dialog"
        aria-labelledby="land-title"
        onClick={(e) => e.stopPropagation()}
      >
        <InfoHeader
          kicker={offer.sea ? 'Seabed lease' : 'Land'}
          title={`Buy this plot for ${money(offer.price)}?`}
          onClose={close}
        />
        <p class="muted" id="land-title">
          {offer.sea
            ? `All sea, leased from the harbour authority for ${Math.round(B.SEA_PLOT_SHARE * 100)}% of the price of land: for jetties, quays, buoys, tug berths, dredging and reclaiming.`
            : 'The port may build anything on it, dredge and fill it in, and clear its trees and rocks.'}{' '}
          {land.value && (
            <>
              {`The port owns ${land.value.owned} plots. Each plot bought costs ${Math.round((B.PLOT_PRICE_RISE - 1) * 100)}% more than the last: the next after this, ${money(land.value.after)}.`}
            </>
          )}
        </p>
        {short && <p class="note bad">Not enough money: you have {money(cash)}.</p>}
        <div class="row">
          <button class="btn block" onClick={close}>
            Not now
          </button>
          <button class="btn primary block" disabled={short} onClick={buy}>
            Buy for {money(offer.price)}
          </button>
        </div>
      </div>
    </div>
  );
}
