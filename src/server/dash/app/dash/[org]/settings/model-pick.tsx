'use client';

import './model-pick.css';

import { Fragment } from 'preact';
import { useId } from 'preact/hooks';

import { Icon } from '@/comps/ui/icon';
import { iDown, iPlus, iRight } from '@/comps/ui/icons';
import { MenuItem, MenuLink, MenuPanel, MenuRadio, MenuRow } from '@/comps/ui/menu-items';
import { useOrg } from '@/comps/nav/org';
import type { ModelsShape } from '@coder/client/types';
import {
  EFFORTS,
  ENGINES,
  ENGINE_NAMES,
  joinSpec,
  modelsByEngine,
  ownEffort,
  splitSpec,
} from '@/app/dash/[org]/settings/model-options';

/** The no-model row: its label, what it runs, and whether it takes an effort too. */
export type FirstRow = { label: string; sub?: string; efforts?: boolean };

/** A model menu's rows: the no-model row, then each engine's names; a row's effort opens its choices beside it, and the list ends in Add models. */
export function ModelChoices({
  groups,
  first,
  model,
  effort,
  base = () => 'medium',
  onPick,
  onAdd,
}: {
  /** Model names by engine. */
  groups: Record<string, string[]>;
  first?: FirstRow;
  model: string;
  effort: string;
  /** The effort a name runs at with none given. */
  base?: (model: string) => string;
  onPick: (model: string, effort: string) => void;
  /** What Add models does; by default it opens the Models settings. */
  onAdd?: () => void;
}) {
  const org = useOrg();
  const uid = useId();
  const sections: Array<[string, string[]]> = [
    ...(first ? [['', ['']] as [string, string[]]] : []),
    ...ENGINES.filter(engine => groups[engine]?.length).map(
      (engine): [string, string[]] => [ENGINE_NAMES[engine] ?? engine, groups[engine]!],
    ),
  ];
  // A spec no name matches, such as a full model id, still shows as picked.
  if (model && !sections.some(([, names]) => names.includes(model))) sections.push(['', [model]]);

  return (
    <div role="group" aria-label="Model" class="pop-radios model-choices">
      {sections.map(([engine, names]) => (
        <Fragment key={engine || names[0]}>
          {engine ? <p class="pop-group">{engine}</p> : null}
          {names.map(name => {
            const on = name === model;
            const label = name || first!.label;
            const flyout = `${uid}-effort-${name || 'default'}`;
            const efforts: Array<[string, string]> = [
              ['', `Default (${name ? base(name) : 'medium'})`],
              ...EFFORTS,
            ];
            const picked = on && effort ? efforts.find(([key]) => key === effort)?.[1] : undefined;
            return (
              <MenuRow key={name}>
                <MenuRadio
                  on={on}
                  onPick={() => onPick(name, '')}
                  end={!name && first?.sub ? <small>{first.sub}</small> : null}
                >
                  {label}
                </MenuRadio>
                {name || first?.efforts ? (
                  <>
                    <button
                      type="button"
                      class="pop-chev"
                      data-keep
                      popovertarget={flyout}
                      aria-label={`Effort for ${label}`}
                    >
                      {/* The row's effort on its chevron, so the chevron reads as where effort is picked. */}
                      <small>{(picked ?? (name ? base(name) : 'default')).toLowerCase()}</small>
                      <Icon d={iRight} />
                    </button>
                    <MenuPanel
                      id={flyout}
                      class="pop-flyout"
                      popover="auto"
                      role="group"
                      aria-label={`Effort for ${label}`}
                      onBeforeToggle={placeBeside}
                    >
                      {efforts.map(([key, text]) => (
                        <MenuRadio key={key} on={on && effort === key} onPick={() => onPick(name, key)}>
                          {text}
                        </MenuRadio>
                      ))}
                    </MenuPanel>
                  </>
                ) : null}
              </MenuRow>
            );
          })}
        </Fragment>
      ))}
      {onAdd ? (
        <MenuItem class="add-models" icon={iPlus} title="Add models" onClick={onAdd} />
      ) : (
        <MenuLink
          class="add-models"
          href="/dash/[org]/settings/[tab]"
          params={{ org, tab: 'models' }}
          icon={iPlus}
        >
          Add models
        </MenuLink>
      )}
    </div>
  );
}

/** Opens a row's effort choices beside the row, on the left when the right has no room, and under it on a phone; the list itself never moves. */
function placeBeside(event: ToggleEvent) {
  const pop = event.currentTarget as HTMLElement;
  const row = document.querySelector(`[popovertarget="${pop.id}"]`)?.parentElement;
  const box = row?.getBoundingClientRect();
  if (event.newState !== 'open' || !box) return;
  pop.style.cssText = 'display: block; visibility: hidden';
  const { offsetWidth: width, offsetHeight: height } = pop;
  pop.style.cssText = '';
  const phone = innerWidth < 560;
  const right = box.right + 4 + width <= innerWidth - 8;
  const left = phone ? box.left : right ? box.right + 4 : box.left - width - 4;
  const top = phone ? box.bottom + 2 : box.top;
  pop.style.left = `${Math.round(Math.max(8, left))}px`;
  pop.style.top = `${Math.round(Math.max(8, Math.min(top, innerHeight - height - 8)))}px`;
}

/** Opens a model menu at its button: below when it fits there, else on the roomier side, scrolling only within that room. */
function placeAt(event: ToggleEvent) {
  const pop = event.currentTarget as HTMLElement;
  const box = document.querySelector(`[popovertarget="${pop.id}"]`)?.getBoundingClientRect();
  if (event.newState !== 'open' || !box) return;
  pop.style.cssText = 'display: block; visibility: hidden; max-height: none';
  const height = pop.offsetHeight;
  const width = pop.offsetWidth;
  pop.style.cssText = '';
  const below = innerHeight - box.bottom - 12;
  const above = box.top - 12;
  const up = height > below && above > below;
  const room = Math.max(160, Math.round(up ? above : below));
  pop.style.left = `${Math.round(Math.max(8, Math.min(box.left, innerWidth - width - 8)))}px`;
  pop.style.maxHeight = `${room}px`;
  if (up) pop.style.bottom = `${Math.round(innerHeight - box.top + 4)}px`;
  else pop.style.top = `${Math.round(box.bottom + 4)}px`;
}

/** A model spec as one button and the composer's model menu: a model, and its effort from the row's chevron; `name` posts the spec. */
export function ModelPick({
  shape,
  value,
  onChange,
  empty,
  name,
  compact,
  onAdd,
}: {
  shape: ModelsShape;
  value: string;
  onChange: (spec: string) => void;
  /** The no-model row, like the default chain. */
  empty?: FirstRow;
  name?: string;
  /** Chip-sized, for a row of models. */
  compact?: boolean;
  onAdd?: () => void;
}) {
  const id = `${useId()}-models`;
  const { model, effort } = splitSpec(value, shape);
  const hide = () => document.getElementById(id)?.hidePopover();

  return (
    <span class={compact ? 'model-pick compact' : 'model-pick'}>
      <button type="button" class="model-pick-btn" popovertarget={id} aria-label="Model">
        <span class="grow">{model || empty?.label || 'Pick a model'}</span>
        {model ? <small class="muted">{effort || ownEffort(model, shape)}</small> : null}
        <Icon d={iDown} />
      </button>
      <MenuPanel id={id} class="model-pop" popover="auto" onBeforeToggle={placeAt}>
        <ModelChoices
          groups={modelsByEngine(shape)}
          first={empty}
          model={model}
          effort={effort}
          base={each => ownEffort(each, shape)}
          onPick={(next, level) => {
            hide();
            onChange(joinSpec(next, level, shape));
          }}
          onAdd={
            onAdd &&
            (() => {
              hide();
              onAdd();
            })
          }
        />
      </MenuPanel>
      {name ? <input type="hidden" name={name} value={value} /> : null}
    </span>
  );
}
