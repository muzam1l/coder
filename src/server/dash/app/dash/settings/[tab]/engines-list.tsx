'use client';

import './engines-list.css';

import { useState } from 'preact/hooks';

import { Badge } from '@/comps/ui/badge';
import { MenuItem } from '@/comps/ui/menu';
import { Select, type Option } from '@/comps/ui/select';
import { ENGINES, ENGINE_NAMES, defaultLabel } from '@/app/dash/settings/model-options';
import { useConfig, List, Row, EFFORTS, PERMISSIONS, AddRow } from './list';
import type { ConfigShape, EngineEntry } from '@coder/client/types';

/** Each engine's defaults, the order tasks try them, and the hosts tasks may reach. */
export function EnginesList({
  first,
  defaults,
}: {
  first: ConfigShape;
  defaults: Record<string, EngineEntry | undefined>;
}) {
  const [making, setMaking] = useState('');
  const config = useConfig(first.config);
  const chain = config.value.chain ?? first.effective.chain ?? ENGINES;
  const hosts = config.value.approvals?.allowedNetworkHosts ?? [];
  const rows = [
    ...chain.filter(name => ENGINES.includes(name)),
    ...ENGINES.filter(name => !chain.includes(name)),
  ];
  // What an unset select resolves to: the inherited value, else the built-in default.
  const resolved = (name: string, key: 'effort' | 'permissions') =>
    (first.config.engines?.[name]?.[key] ? undefined : first.effective.engines?.[name]?.[key]) ??
    defaults[name]?.[key];
  const pick = (name: string, key: 'effort' | 'permissions', options: string[]) => (
    <label>
      {key}
      <Select
        label={`${ENGINE_NAMES[name]} ${key}`}
        value={config.value.engines?.[name]?.[key] ?? ''}
        options={[
          ['', defaultLabel(resolved(name, key) ?? (key === 'permissions' ? 'auto' : undefined))],
          ...options.map((option): Option => [option, option]),
        ]}
        onChange={value => void config.patch({ engines: { [name]: { [key]: value || null } } })}
      />
    </label>
  );
  return (
    <>
      <List title="Engines" count={chain.length} error={config.error}>
        {rows.map(name => (
          <Row
            key={name}
            title={ENGINE_NAMES[name]!}
            badges={
              <>
                {chain[0] === name ? <Badge tone="acc">default</Badge> : null}
                {chain.includes(name) ? null : <Badge>off</Badge>}
              </>
            }
            sub={
              <span class="inline-picks">
                {pick(name, 'effort', EFFORTS)}
                {pick(name, 'permissions', PERMISSIONS)}
              </span>
            }
            actions={
              chain[0] === name ? null : (
                <button
                  type="button"
                  class="btn secondary sm"
                  disabled={making === name}
                  aria-busy={making === name}
                  onClick={() => {
                    setMaking(name);
                    void config
                      .patch({ chain: [name, ...chain.filter(each => each !== name)] })
                      .finally(() => setMaking(''));
                  }}
                >
                  Make default
                </button>
              )
            }
            menu={
              chain.includes(name) ? (
                chain.length > 1 ? (
                  <MenuItem
                    title="Disable"
                    onClick={() =>
                      void config.patch({ chain: chain.filter(each => each !== name) })
                    }
                  />
                ) : undefined
              ) : (
                <MenuItem
                  title="Enable"
                  onClick={() => void config.patch({ chain: [...chain, name] })}
                />
              )
            }
          />
        ))}
      </List>
      <List
        title="Allowed network hosts"
        count={hosts.length}
        error=""
        add={
          <AddRow
            fields={[['host', 'Host, like registry.npmjs.org']]}
            onAdd={({ host }) =>
              config.patch({ approvals: { allowedNetworkHosts: [...new Set([...hosts, host!])] } })
            }
          />
        }
      >
        {hosts.map(host => (
          <Row
            key={host}
            title={host}
            remove={{
              title: `Remove ${host}?`,
              body: 'Tasks lose access to it.',
              onRemove: () =>
                config.patch({
                  approvals: { allowedNetworkHosts: hosts.filter(each => each !== host) },
                }),
            }}
          />
        ))}
      </List>
    </>
  );
}
