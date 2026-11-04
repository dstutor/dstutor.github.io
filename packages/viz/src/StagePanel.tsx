// The pictures a stage draws when a table is not the right picture (docs/visualizing-steps.md,
// Stages): a join's keys as a Venn, how each key's rows pair up, rows sorted into groups, a
// sort's new order, and the plan the library actually ran. Driven only by the trace.
import { useId } from 'react';
import type { GroupsPanel, JsonValue, KeyChip, KeysPanel, OrderPanel, PairsPanel, Panel, PlanPanel } from '@dstutor/trace-schema';
import { formatColumn, type TableStyle } from './tableFormat';
import './StagePanel.css';

/** A key value, printed the way the library prints a value of a table */
const text = (value: JsonValue, style: TableStyle) => formatColumn([value], style)[0] || '""';

/** How the library spells a missing value */
const missing = (style: TableStyle) => (style === 'duckdb' ? 'NULL' : style === 'polars' ? 'null' : 'NaN');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Chip({ chip, style }: { chip: KeyChip; style: TableStyle }) {
  return <span className={`key-chip${chip.color !== undefined ? ` key-slot-${chip.color}` : ''}`}>{text(chip.value, style)}</span>;
}

/** Up to `max` chips, then "+n" */
function Chips({ chips, style, max = 5 }: { chips: KeyChip[]; style: TableStyle; max?: number }) {
  const shown = chips.slice(0, max);
  return (
    <span className="chips">
      {shown.map((chip, i) => <Chip key={i} chip={chip} style={style} />)}
      {chips.length > max && <span className="key-chip more">+{chips.length - max}</span>}
      {chips.length === 0 && <span className="chips-none">none</span>}
    </span>
  );
}

/** Two circles of distinct key values; the regions the join keeps are shaded */
function KeysView({ panel, style }: { panel: KeysPanel; style: TableStyle }) {
  const id = useId().replace(/:/g, '');
  const keeps = new Set(panel.keeps);
  const region = (name: 'left_only' | 'both' | 'right_only', label: string, chips: KeyChip[]) => (
    <div className={`venn-region region-${name}${keeps.has(name) ? ' is-kept' : ''}`}>
      <span className="venn-region-label">{label}</span>
      <Chips chips={chips} style={style} max={4} />
      <span className="venn-region-fate">{keeps.has(name) ? 'kept' : 'dropped'}</span>
    </div>
  );
  return (
    <figure className="stage-panel keys-panel" aria-label={`Key values of ${panel.left} and ${panel.right}`}>
      <div className="venn">
        <svg className="venn-shapes" viewBox="0 0 300 160" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={`${id}-l`}><circle cx="112" cy="80" r="76" /></clipPath>
            <mask id={`${id}-notl`}><rect width="300" height="160" fill="white" /><circle cx="112" cy="80" r="76" fill="black" /></mask>
            <mask id={`${id}-notr`}><rect width="300" height="160" fill="white" /><circle cx="188" cy="80" r="76" fill="black" /></mask>
          </defs>
          <circle className={`venn-fill${keeps.has('left_only') ? ' is-kept' : ''}`} cx="112" cy="80" r="76" mask={`url(#${id}-notr)`} />
          <circle className={`venn-fill${keeps.has('right_only') ? ' is-kept' : ''}`} cx="188" cy="80" r="76" mask={`url(#${id}-notl)`} />
          <circle className={`venn-fill${keeps.has('both') ? ' is-kept' : ''}`} cx="188" cy="80" r="76" clipPath={`url(#${id}-l)`} />
          <circle className="venn-edge" cx="112" cy="80" r="76" />
          <circle className="venn-edge" cx="188" cy="80" r="76" />
        </svg>
        {region('left_only', `only in ${panel.left}`, panel.left_only)}
        {region('both', 'in both', panel.both)}
        {region('right_only', `only in ${panel.right}`, panel.right_only)}
      </div>
      <figcaption className="stage-caption">
        Distinct values of <code>{panel.key}</code>: each appears once here, however many rows have it.
      </figcaption>
    </figure>
  );
}

/** One line per key: how many rows each side has, and how many rows that makes */
function PairsView({ panel, style }: { panel: PairsPanel; style: TableStyle }) {
  return (
    <figure className="stage-panel pairs-panel">
      <ul className="pairs">
        {panel.pairs.map((pair, i) => {
          const fate = pair.rows === 0
            ? 'no match, dropped'
            : pair.left > 0 && pair.right > 0
              ? `${pair.left} × ${pair.right} → ${plural(pair.rows, 'row')}`
              : `no match, kept with ${missing(style)} → ${plural(pair.rows, 'row')}`;
          return (
            <li key={i} className={`pair${pair.rows === 0 ? ' is-dropped' : ''}`}>
              <Chip chip={pair.key} style={style} />
              <span className="pair-sides">
                <span className="pair-count" title="rows on the left">{pair.left} left</span>
                <span className="pair-count" title="rows on the right">{pair.right} right</span>
              </span>
              <span className="pair-fate">{fate}</span>
            </li>
          );
        })}
      </ul>
      <figcaption className="stage-caption pairs-total">
        {panel.pairs.map(p => p.rows).join(' + ')}
        {panel.more ? ` + … (${plural(panel.more, 'more key')})` : ''} = <strong>{plural(panel.total, 'row')}</strong>
      </figcaption>
    </figure>
  );
}

/** One card per group: its key, its rows' values and, once combined, the arithmetic */
function GroupsView({ panel, style }: { panel: GroupsPanel; style: TableStyle }) {
  return (
    <figure className="stage-panel groups-panel">
      <div className="group-cards">
        {panel.groups.map((group, i) => (
          <div key={i} className={`group-card${group.color !== undefined ? ` key-slot-${group.color}` : ''}`}>
            <div className="group-head">
              <span className="group-key">{group.key.map(k => text(k, style)).join(', ')}</span>
              <span className="group-size">{plural(group.rows, 'row')}</span>
            </div>
            {group.values.map((v, j) => (
              <div key={j} className="group-values">
                <span className="group-column">{v.column}</span>
                {v.formula !== undefined ? (
                  <code className="group-formula">{v.formula}</code>
                ) : (
                  <code className="group-list">{formatColumn([v.values], style)[0]}</code>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      {panel.more ? <figcaption className="stage-caption">…and {plural(panel.more, 'more group')}, the same way.</figcaption> : null}
    </figure>
  );
}

/** Where each result row was in the input, in result order, with ties bracketed */
function OrderView({ panel, style }: { panel: OrderPanel; style: TableStyle }) {
  const tieOf = (i: number) => (panel.ties ?? []).findIndex(([a, b]) => i >= a && i <= b);
  return (
    <figure className="stage-panel order-panel">
      <ol className="order-strip">
        {panel.from.map((from, i) => {
          const tie = tieOf(i);
          return (
            <li key={i} className={`order-slot${tie >= 0 ? ' in-tie' : ''}`}>
              <span className="order-to">{i}</span>
              <span className="order-from">{text(from, style)}</span>
              {panel.values && panel.values[i] !== undefined && <span className="order-value">{text(panel.values[i], style)}</span>}
            </li>
          );
        })}
        {panel.more ? <li className="order-slot more">+{panel.more}</li> : null}
      </ol>
      <figcaption className="stage-caption">
        Top: each row&apos;s new place. Below it: where that row was before{panel.values ? ', and its sort key' : ''}.
        {panel.ties?.length ? ' Bracketed rows tie on the sort key.' : ''}
      </figcaption>
    </figure>
  );
}

/** The plan the library ran, first step to last, with the rows out of each */
function PlanView({ panel }: { panel: PlanPanel }) {
  return (
    <figure className="stage-panel plan-panel">
      {panel.plans.map((plan, i) => (
        <div key={i} className="plan">
          <div className="plan-title">{plan.title}</div>
          <ol className="plan-steps">
            {plan.steps.map((step, j) => (
              <li key={j} className="plan-step">
                <span className="plan-name">{step.name}</span>
                {step.rows !== undefined && <span className="plan-rows">{plural(step.rows, 'row')}</span>}
                {step.detail && <code className="plan-detail">{step.detail}</code>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </figure>
  );
}

export default function StagePanel({ panel, style }: { panel: Panel; style: TableStyle }) {
  switch (panel.kind) {
    case 'keys': return <KeysView panel={panel} style={style} />;
    case 'pairs': return <PairsView panel={panel} style={style} />;
    case 'groups': return <GroupsView panel={panel} style={style} />;
    case 'order': return <OrderView panel={panel} style={style} />;
    case 'plan': return <PlanView panel={panel} />;
  }
}
