import type { Ledger, LedgerCategory } from '../protocol';
import * as B from '../sim/balance';
import type { Actions } from './App';
import { money } from './format';
import { panel, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

const ROWS: { key: LedgerCategory; label: string }[] = [
  { key: 'cargo', label: 'Cargo handled' },
  { key: 'wages', label: 'Wages' },
  { key: 'hauliers', label: 'Haulier fees' },
  { key: 'construction', label: 'Construction' },
  { key: 'hiring', label: 'Hiring' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'penalties', label: 'Penalties' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'interest', label: 'Loan interest' },
];

function total(l: Ledger): number {
  return ROWS.reduce((n, r) => n + l[r.key], 0);
}

function Amount({ value }: { value: number }) {
  if (value === 0) return <span class="muted">—</span>;
  return <span class={value > 0 ? 'pos' : 'neg'}>{money(value)}</span>;
}

export function FinancePanel({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const y = s.yesterday;
  return (
    <aside class="side panel wide" aria-label="Finance">
      <InfoHeader kicker="Money" title="Finance" onClose={() => (panel.value = null)} />

      <div class="section-title">
        <span>Bank loan</span>
        <span class="muted">{(B.LOAN_DAILY_RATE * 100).toFixed(1)}% interest per day</span>
      </div>
      <div class="card">
        <dl class="terms">
          <div>
            <dt>Owed</dt>
            <dd>{money(s.loan)}</dd>
          </div>
          <div>
            <dt>Interest</dt>
            <dd>{money(s.interest)} / day</dd>
          </div>
        </dl>
        <Meter value={s.loan / B.LOAN_MAX} tone={s.loan > B.LOAN_MAX * 0.75 ? 'warn' : 'ok'} />
        <div class="card-foot">
          <span class="muted">Limit {money(B.LOAN_MAX)}</span>
          <span class="confirm">
            <button
              class="btn sm"
              disabled={s.loan === 0 || s.cash < Math.min(B.LOAN_STEP, s.loan)}
              onClick={() => actions.send({ type: 'loan', amount: -B.LOAN_STEP })}
            >
              Repay {money(Math.min(B.LOAN_STEP, s.loan) || B.LOAN_STEP)}
            </button>
            <button
              class="btn primary sm"
              disabled={s.loan >= B.LOAN_MAX}
              onClick={() => actions.send({ type: 'loan', amount: B.LOAN_STEP })}
            >
              Borrow {money(B.LOAN_STEP)}
            </button>
          </span>
        </div>
      </div>

      <div class="section-title">
        <span>Statement</span>
        <span class="muted">wages and fees are paid at midnight</span>
      </div>
      <table class="ledger">
        <thead>
          <tr>
            <th />
            <th>Today</th>
            <th>Yesterday</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>
                <Amount value={s.today[r.key]} />
              </td>
              <td>{y ? <Amount value={y[r.key]} /> : <span class="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Net</td>
            <td>
              <Amount value={total(s.today)} />
            </td>
            <td>{y ? <Amount value={total(y)} /> : <span class="muted">—</span>}</td>
          </tr>
        </tfoot>
      </table>
    </aside>
  );
}
