'use client';

import { client } from '@/utils/client';

/** Installs the app that reaches repositories, a built-in one first, and comes back to `back`. */
export async function connectRepositories(back: string) {
  const [apps, catalog] = await Promise.all([client.apps.list(), client.integrations.list()]);
  const reach = new Set(catalog.filter(entry => entry.repositories).map(entry => entry.id));
  const app = apps
    .map(row => row.value)
    .sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)))
    .find(entry => reach.has(entry.integration));
  if (!app) throw new Error('No app here can reach repositories yet.');
  const { url } = await client.apps.install(app.id, back);
  location.href = url;
}
