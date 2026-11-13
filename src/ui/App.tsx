import { ROTATABLE } from '../sim/rules';
import type { BuildKind } from '../sim/types';
import type { Actions } from './actions';
import { Advisor } from './Advisor';
import { BuildBar } from './BuildBar';
import { ContractsPanel } from './Contracts';
import { BankruptDialog, NewGameDialog, PhoneNotice } from './Dialogs';
import { FeedbackPanel, ReportButton } from './Feedback';
import { FinancePanel } from './Finance';
import { GuideDialog } from './Guide';
import { HandbookPanel } from './Handbook';
import { Icon } from './icons';
import { InfoPanel } from './Inspector';
import { LandDialog } from './Land';
import { Mayor } from './TownMayor';
import { BankBanner, HoverTip, Messages, PreviewTip } from './Overlays';
import { PortPanel } from './Port';
import { SettingsPanel } from './Settings';
import { StaffPanel } from './Staff';
import { StatsPanel } from './Stats';
import {
  guide,
  menuOpen,
  narrow,
  newGameOpen,
  openCategory,
  panel,
  selection,
  snapshot,
  tool,
} from './store';
import { MobileMenu, TopBar } from './TopBar';

export function App({ actions }: { actions: Actions }) {
  return (
    <>
      <TopBar actions={actions} />
      <BankBanner />
      <Messages />
      {panel.value === 'contracts' ? (
        <ContractsPanel actions={actions} />
      ) : panel.value === 'staff' ? (
        <StaffPanel actions={actions} />
      ) : panel.value === 'finance' ? (
        <FinancePanel actions={actions} />
      ) : panel.value === 'stats' ? (
        <StatsPanel />
      ) : panel.value === 'port' ? (
        <PortPanel actions={actions} />
      ) : panel.value === 'handbook' ? (
        <HandbookPanel actions={actions} />
      ) : panel.value === 'settings' ? (
        <SettingsPanel actions={actions} />
      ) : panel.value === 'feedback' ? (
        <FeedbackPanel />
      ) : (
        <InfoPanel actions={actions} />
      )}
      <PreviewTip />
      <HoverTip />
      {!guide.value && !(narrow.value && (panel.value || selection.value || menuOpen.value)) && (
        <Advisor actions={actions} />
      )}
      <Mayor actions={actions} />
      <ReportButton />
      <MapControls actions={actions} />
      <BuildBar />
      <MobileMenu actions={actions} />
      {snapshot.value?.bankrupt && !newGameOpen.value && <BankruptDialog />}
      {newGameOpen.value && <NewGameDialog actions={actions} />}
      <GuideDialog actions={actions} />
      <LandDialog send={actions.send} />
      <PhoneNotice />
    </>
  );
}

/**
 * On a touch screen, what the keys and the right mouse button do on a
 * computer: zoom, turn the view, and turn a building being placed. Two
 * fingers pinch to zoom and drag to pan.
 */
function MapControls({ actions }: { actions: Actions }) {
  // Out of the way of a panel, which rises from the bottom on a phone.
  if (!narrow.value || panel.value || selection.value) return null;
  const turnable = ROTATABLE.has(tool.value as BuildKind);
  return (
    <div class={`map-controls ${openCategory.value ? 'raised' : ''}`}>
      {turnable && (
        <button class="btn" onClick={() => actions.rotateBuilding()} aria-label="Turn the building">
          <Icon name="turn" />
          <span>Turn</span>
        </button>
      )}
      <div class="map-controls-group panel">
        <button class="btn icon" onClick={() => actions.zoom(1 / 1.25)} aria-label="Zoom in">
          <Icon name="plus" />
        </button>
        <button class="btn icon" onClick={() => actions.zoom(1.25)} aria-label="Zoom out">
          <Icon name="minus" />
        </button>
        <button
          class="btn icon"
          onClick={() => actions.rotateView(-1)}
          aria-label="Turn the view left"
        >
          <Icon name="rotateLeft" />
        </button>
        <button
          class="btn icon"
          onClick={() => actions.rotateView(1)}
          aria-label="Turn the view right"
        >
          <Icon name="rotateRight" />
        </button>
      </div>
    </div>
  );
}
