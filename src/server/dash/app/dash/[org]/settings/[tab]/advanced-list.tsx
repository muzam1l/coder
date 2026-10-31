'use client';

import './advanced-list.css';

import { useState } from 'preact/hooks';

import { Card } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { iX } from '@/comps/ui/icons';
import { useConfig } from './list';
import type { ConfigShape } from '@coder/client/types';

/** The network every task has: hosts auto tasks reach without review, and whether read-only tasks reach them too. */
export function AdvancedList({ first, admin }: { first: ConfigShape; admin: boolean }) {
  const config = useConfig(first.config);
  const hosts = config.value.network?.allowedHosts ?? [];
  const [host, setHost] = useState('');
  const save = (next: string[]) => config.patch({ network: { allowedHosts: next } });

  return (
    <Card look="filled" title="Network">
      <p class="body muted">Hosts tasks reach without review, with their subdomains.</p>
      <div class="hosts">
        {hosts.map(each => (
          <span class="host mono" key={each}>
            {each}
            {admin ? (
              <button
                type="button"
                aria-label={`Remove ${each}`}
                onClick={() => void save(hosts.filter(other => other !== each))}
              >
                <Icon d={iX} />
              </button>
            ) : null}
          </span>
        ))}
        {admin ? (
          <input
            class="mono"
            value={host}
            onInput={event => setHost(event.currentTarget.value)}
            onKeyDown={event => {
              const next = host.trim();
              if (event.key !== 'Enter' || !next) return;
              event.preventDefault();
              setHost('');
              if (!hosts.includes(next)) void save([...hosts, next]);
            }}
            placeholder={hosts.length ? 'Add a host, then Enter' : 'registry.npmjs.org, then Enter'}
            aria-label="Add a host"
            autocomplete="off"
            spellcheck={false}
          />
        ) : hosts.length ? null : (
          <span class="muted">None yet. Only admins add hosts.</span>
        )}
      </div>
      <label class="hosts-switch">
        <input
          type="checkbox"
          role="switch"
          class="switch"
          checked={config.value.network?.readOnlyTasks ?? false}
          disabled={!admin}
          onChange={event =>
            void config.patch({ network: { readOnlyTasks: event.currentTarget.checked } })
          }
        />
        Read-only tasks reach these hosts too
      </label>
    </Card>
  );
}
