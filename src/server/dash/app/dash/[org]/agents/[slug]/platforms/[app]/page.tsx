import '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/page.css';

import { createUrl, load, loadAgent, orgOf, unwrap } from '@/api/load';
import { Back, Page, PageHead } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';
import { Card, Empty } from '@/comps/ui/card';
import { Badge } from '@/comps/ui/badge';
import { eventNames, isAdmin } from '@/api/types';
import { Platform } from '@/app/dash/[org]/agents/agent/agent-pills';
import { AppCards } from './app-cards';

/** One of an agent's apps: its handle and platform, then where it is installed, how it stays up to date, and removing it. */
export default async function AgentAppPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { slug: rawSlug, app: rawApp } = await params;
  const slug = Array.isArray(rawSlug) ? rawSlug[0]! : rawSlug!;
  const id = Array.isArray(rawApp) ? rawApp[0]! : rawApp!;
  const org = orgOf(request);
  const search = new URL(request.url).searchParams;
  const agent = loadAgent(request, slug);
  const apps = load(request).apps.list(slug).then(unwrap);
  const installations = load(request)
    .installations.list(slug, { limit: 200, active: true })
    .then(unwrap);
  const catalog = load(request)
    .integrations.list(slug)
    .catch(() => []);
  const me = load(request)
    .me()
    .catch(() => undefined);
  apps.catch(() => {});
  installations.catch(() => {});
  const back = (
    <Back
      href="/dash/[org]/agents/[slug]/platforms"
      params={{ org, slug }}
      label="Platforms"
      back={search.get('back')}
    />
  );

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([agent, apps, installations, catalog, me]).then(
            async ([row, own, all, integrations, who]) => {
              const app = own.find(entry => entry.id === id);
              if (!app)
                return (
                  <>
                    <PageHead back={back} title="App not found" />
                    <Card>
                      <Empty title="This app is gone">
                        Coder no longer knows it, or it belongs to another agent.
                      </Empty>
                    </Card>
                  </>
                );

              const info = integrations.find(entry => entry.id === app.integration);
              const name = info?.name ?? app.integration;
              const installs = all.filter(entry => entry.app === app.id);
              const events =
                row.settings?.integrations?.[app.integration]?.allowedEvents ??
                eventNames(row.definition?.integrations?.[app.integration]?.events);
              const admin = who ? isAdmin(who) : false;
              // A chat's update link opens the dialog with what to change already read.
              const check =
                admin &&
                !app.builtin &&
                search.has('update') &&
                info?.appUpdate &&
                info.appUpdate !== 'push'
                  ? await load(request)
                      .apps.drift(app.id)
                      .catch(() => undefined)
                  : undefined;

              return (
                <>
                  <PageHead
                    back={back}
                    title={app.name}
                    meta={
                      <>
                        <Platform
                          id={app.integration}
                          info={info}
                          state={
                            installs.some(entry => !entry.uninstalled) ? 'installed' : 'created'
                          }
                        />
                        {app.changed ? <Badge tone="warn">update needed</Badge> : null}
                        {app.builtin ? <Badge>shared</Badge> : null}
                      </>
                    }
                    lead={
                      events.includes('mention')
                        ? `Mention @${app.name} on ${name} to start a task.`
                        : `The agent's handle on ${name} is @${app.name}.`
                    }
                  />
                  <AppCards
                    org={org}
                    slug={slug}
                    app={app}
                    installs={installs}
                    events={events}
                    covered={info?.covered ?? 'account'}
                    admin={admin}
                    operator={who?.operator === true}
                    appUpdate={info?.appUpdate}
                    check={check}
                    asked={search.has('delete')}
                    create={{
                      integration: app.integration,
                      name,
                      createUrl: createUrl(row, own, app.integration),
                      create: info?.create,
                      unreachable: integrations.some(entry => entry.unreachable),
                      publicApps: info?.publicApps,
                      organizationApps: info?.organizationApps,
                    }}
                  />
                </>
              );
            },
          )
        }
      />
    </Page>
  );
}
