'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { iDots, iPlus, iSpark } from '@/comps/ui/icons';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';

/** The one next step for a platform, and the rarer ones in its row menu. */
export function PlatformActions({
  integration,
  apps,
  installed,
  createUrl,
  owners = [],
}: {
  integration: string;
  apps: Array<{ id: string; name: string }>;
  installed: boolean;
  createUrl: string;
  /** Organizations the app could live under instead of your own account. */
  owners?: string[];
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const where = (owner = '') =>
    owner ? `${createUrl}&owner=${encodeURIComponent(owner)}` : createUrl;
  const install = (app: string) => {
    setBusy(true);
    setError('');
    void client.apps
      .install(app, location.pathname)
      .then(({ url }) => {
        location.href = url;
      })
      .catch(reason => {
        setBusy(false);
        setError(reasonText(reason));
      });
  };
  // The organization the workspace already works in is preselected; the menu holds the other places.
  if (!apps.length)
    return (
      <>
        <a
          class="btn sm"
          href={where(owners[0])}
          title={owners[0] ? `Creates the app in ${owners[0]}` : undefined}
        >
          Create app
        </a>
        {owners.length ? (
          <Menu
            summaryClass="icon-btn"
            label={`Where the ${integration} app lives`}
            wide
            summary={<Icon d={iDots} />}
          >
            {[...owners.slice(1), ''].map(name => (
              <MenuItem
                key={name}
                icon={iSpark}
                href={where(name)}
                title={name ? `Create in ${name}` : 'Create under your account'}
                sub="The app is private to where it lives."
              />
            ))}
          </Menu>
        ) : null}
      </>
    );
  return (
    <>
      {installed ? null : (
        <button type="button" class="btn sm" disabled={busy} onClick={() => install(apps[0]!.id)}>
          Install
        </button>
      )}
      <Menu
        summaryClass="icon-btn"
        label={`More for ${integration}`}
        wide
        summary={<Icon d={iDots} />}
      >
        {apps.map(app => (
          <MenuItem
            key={app.id}
            icon={iPlus}
            title={
              apps.length > 1
                ? `Install ${app.name} on another account`
                : 'Install on another account'
            }
            sub="Add this app to more repositories, another org, or another workspace."
            onClick={() => install(app.id)}
          />
        ))}
        <MenuItem
          icon={iSpark}
          href={where(owners[0])}
          title={`Create another ${integration} app`}
          sub="A separate app for an account this one cannot be installed on."
        />
      </Menu>
      <ErrorText value={error} />
    </>
  );
}
