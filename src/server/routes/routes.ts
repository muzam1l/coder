import {
  accountAllowed,
  adminGuard,
  adminOnly,
  apiAllowed,
  completedTaskGuard,
  createAllowed,
  credentialAllowed,
  dashboardAllowed,
  dashboardTokenAllowed,
  engineAllowed,
  inboxGuard,
  installAllowed,
  localOnly,
  loginAllowed,
  loginGuard,
  metadataAllowed,
  oauthAllowed,
  organizationAllowed,
  pageSession,
  requireWorkspaceAdmin,
  signInAllowed,
  taskGuard,
  tokenLinkAllowed,
} from './guards';
import { group, mount, route, type Params } from './match';
import { dashboard, dashboardToken, home, loginPage, signIn } from '../dash/serve';
import { health, metrics } from '../health';
import { meRoute, organizationRoute } from '../auth/account';
import { json, notFound } from './http';
import {
  ackMessages,
  heartbeat,
  readContext,
  readMessages,
  refreshCredential,
  reportResult,
} from '../tasks/callbacks';
import {
  answerLogin,
  cancelLogin,
  createLogin,
  readLogin,
  readLoginEngine,
  reportLogin,
  takeLoginInput,
} from '../settings/logins';
import {
  checkRunner,
  createRunner,
  deleteRunner,
  listRunners,
  pairRunner,
  registerRunner,
  updateRunner,
} from '../settings/runners';
import { completeCreate, completeCreateForm, createPage } from '../agents/create';
import { completeInstall, installPage } from '../agents/install';
import { completeOAuth, confirmTokenLink, startOAuth, startTokenLink } from '../auth/connect';
import { hook, listFlows, listPulls, review, runFlow } from '../tasks/flows';
import { type ServerContext } from '../context';
import { readUsage, readUsageTotals } from '../tasks/usage';
import { checkFolder, cloneFolder, localFolders, pickFolder } from '../settings/folders';
import { engineStatus } from '../tasks/local';
import {
  createCredential,
  defaultCredential,
  deleteCredential,
  listCredentials,
  signInEngine,
  signOutEngine,
} from '../settings/credentials';
import {
  adminConnection,
  adminInstallLink,
  adminRepositories,
  integrationCatalog,
  listApps,
  listInstallations,
} from '../agents/connections';
import { importAgent, previewImport } from '../agents/import';
import { listAgents, listVersions, readAgent, readVersion } from '../agents/catalog';
import { deleteAgent, publish, updateSettings } from '../agents/publishing';
import {
  adminCreate,
  approveTask,
  archiveTask,
  askTask,
  cancelTask,
  continueTaskRequest,
  listTasks,
  readTask,
  removeTask,
  steerTask,
  taskLogs,
} from '../tasks/admin';
import { taskEvents, taskStream } from '../tasks/stream';
import { patchConfiguration, readConfig, saveConfiguration } from '../settings/config';
import {
  aliasModel,
  createModel,
  deleteModel,
  disableModel,
  enableModel,
  listModels,
  probe,
} from '../settings/models';
import { createMcp, deleteMcp, listMcp, mcpRegistry } from '../settings/mcp';
import {
  CLI_CLIENT_PATH,
  RESOURCE_PATH,
  WEB_CLIENT_PATH,
  cliDocument,
  resourceDocument,
  webDocument,
} from '../auth/metadata';

const pagesRoutes = [
  route('GET', WEB_CLIENT_PATH, webDocument, metadataAllowed),
  route('GET', CLI_CLIENT_PATH, cliDocument, metadataAllowed),
  route('GET', RESOURCE_PATH, resourceDocument, metadataAllowed),
  route('GET', '/health', (req, ctx) => health(ctx)),
  route('GET', '/', home, pageSession),
  route('GET', '/login', signIn, signInAllowed),
  ...mount('/login', loginPage, signInAllowed).filter(entry => entry.method !== 'GET'),
  route('POST', '/dash/token', dashboardToken, dashboardTokenAllowed),
  ...mount('/dash', dashboard, dashboardAllowed),
];

const authRoutes = [
  route('GET', '/api/auth/capabilities', (req, ctx) => json({ wular: ctx.auth?.issuer ?? null })),
  ...mount('/api/auth', (req, ctx) => ctx.auth!.handler(req), apiAllowed),
  route('GET', '/me', meRoute, accountAllowed),
  route('POST', '/me/organization', organizationRoute, organizationAllowed),
];

const callbacksRoutes = [
  ...group('/tasks', [
    route('GET', '/:id/messages', readMessages, inboxGuard),
    route('POST', '/:id/ack', ackMessages, inboxGuard),
    route('POST', '/:id/heartbeat', heartbeat, inboxGuard),
    route('POST', '/:id/result', reportResult, completedTaskGuard),
    route('POST', '/:id/credential', refreshCredential, completedTaskGuard),
    route('GET', '/:id', readContext, taskGuard),
  ]),
  ...group('/logins', [
    route('GET', '/:id/input', takeLoginInput, loginGuard),
    route('GET', '/:id', readLoginEngine, loginGuard),
    route('POST', '/:id', reportLogin, loginGuard),
  ]),
  ...group('/runners', [route('POST', '/register', registerRunner)]),
];

const provisionRoutes = [
  ...group('/create', [
    route('GET', '/:id', createPage, createAllowed),
    route('POST', '/:id', createPage, createAllowed),
    route('GET', '/:id/callback', completeCreate, createAllowed),
    route('POST', '/:id/callback', completeCreateForm, createAllowed),
  ]),
  ...group('/install', [
    route('GET', '/:id', installPage, installAllowed),
    route('POST', '/:id', installPage, installAllowed),
    route('GET', '/:id/callback', completeInstall, installAllowed),
    route('POST', '/:id/callback', completeInstall, installAllowed),
  ]),
];

const connectRoutes = group('/connect', [
  route('GET', '', startTokenLink, tokenLinkAllowed),
  route('POST', '', confirmTokenLink, tokenLinkAllowed),
  route('GET', '/:integration', startOAuth, oauthAllowed),
  route('GET', '/:integration/callback', completeOAuth, oauthAllowed),
]);

const known = (req: Request, ctx: ServerContext, params: Params) =>
  ctx.integrations[params['*']!] ? ctx : notFound();

const hooksRoutes = group('/hooks', [
  route('POST', '/*', (req, ctx, params) => hook(req, ctx, params['*']!), known),
]);

const platformRoutes = [...hooksRoutes, ...provisionRoutes, ...connectRoutes];

const usageRoutes = [
  route(
    'GET',
    '/metrics',
    async (req, ctx) => json(await metrics(ctx), 200, { 'cache-control': 'no-store' }),
    adminOnly,
  ),
  route('GET', '/usage', readUsage),
  route('GET', '/usage/totals', readUsageTotals),
];

const foldersRoutes = group(
  '',
  [
    route('GET', '/folders', (req, ctx) => json(localFolders(ctx.local!.cwd))),
    route('POST', '/folders/check', async (req, ctx) => {
      const body = await req.json().catch(() => undefined);
      return json(checkFolder(body?.path));
    }),
    route('POST', '/folders/clone', async (req, ctx) => {
      const body = await req.json().catch(() => undefined);
      return json(await cloneFolder(body?.url));
    }),
    route('POST', '/folders/pick', async (req, ctx) => json(await pickFolder())),
  ],
  localOnly,
);

const enginesRoutes = group(
  '',
  [
    route('GET', '/engines/status', async (req, ctx) => json(await engineStatus())),
    route('POST', '/engines/:engine/login', signInEngine),
    route('POST', '/engines/:engine/logout', signOutEngine),
  ],
  engineAllowed,
);

const appsRoutes = [
  route('POST', '/apps/:id/install', (req, ctx, params, url) =>
    adminInstallLink(req, ctx, params.id!, url.searchParams.get('back')),
  ),
  route('GET', '/apps', listApps),
  route('GET', '/installations', listInstallations),
  route('POST', '/connections', (req, ctx) => adminConnection(req, ctx)),
  route('GET', '/integrations', (req, ctx) => integrationCatalog(ctx)),
  route('GET', '/repositories', (req, ctx) => adminRepositories(ctx)),
];

const agentsRoutes = [
  route('GET', '/agents/import', previewImport),
  route('POST', '/agents/import', importAgent),
  route('GET', '/agents', listAgents),
  route('PATCH', '/agents/:slug/settings', updateSettings),
  route('GET', '/agents/:slug/versions', listVersions),
  route('GET', '/agents/:slug/versions/:version', readVersion),
  route('GET', '/agents/:slug', readAgent),
  route('DELETE', '/agents/:slug', deleteAgent, (req, ctx) =>
    requireWorkspaceAdmin(ctx, 'Only an owner or admin can delete an agent.'),
  ),
  route('PUT', '/agents/:slug', publish),
];

const credentialsRoutes = [
  route('GET', '/credentials', listCredentials),
  route('POST', '/credentials', createCredential, credentialAllowed),
  route('POST', '/credentials/:label/default', defaultCredential),
  route('DELETE', '/credentials/:label', deleteCredential),
  route('POST', '/logins', createLogin, loginAllowed),
  route('GET', '/logins/:id', readLogin, loginAllowed),
  route('POST', '/logins/:id', answerLogin, loginAllowed),
  route('DELETE', '/logins/:id', cancelLogin, loginAllowed),
];

const runnersRoutes = [
  route('GET', '/runners', listRunners),
  route('POST', '/runners', createRunner),
  route('POST', '/runners/pair', pairRunner),
  route('POST', '/runners/:id/test', checkRunner),
  route('PATCH', '/runners/:id', updateRunner),
  route('DELETE', '/runners/:id', deleteRunner),
];

const tasksRoutes = [
  route('GET', '/tasks', listTasks),
  route('POST', '/tasks', adminCreate),
  route('GET', '/tasks/:id', readTask),
  route('DELETE', '/tasks/:id', removeTask),
  route('GET', '/tasks/:id/logs', taskLogs),
  route('GET', '/tasks/:id/stream', taskStream),
  route('POST', '/tasks/:id/steer', steerTask),
  route('POST', '/tasks/:id/ask', askTask),
  route('POST', '/tasks/:id/continue', continueTaskRequest),
  route('POST', '/tasks/:id/approve', approveTask),
  route('POST', '/tasks/:id/cancel', cancelTask),
  route('POST', '/tasks/:id/archive', archiveTask),
  route('GET', '/events', taskEvents),
];

const configRoutes = [
  route('GET', '/config', readConfig),
  route('PATCH', '/config', patchConfiguration),
  route('PUT', '/config', saveConfiguration),
];

const modelsRoutes = [
  route('POST', '/models/probe', (req, ctx) => probe(req, ctx)),
  route('GET', '/models', listModels),
  route('POST', '/models', createModel),
  route('DELETE', '/models/:name', deleteModel),
  route('POST', '/models/:name/alias', aliasModel),
  route('POST', '/models/:name/disable', disableModel),
  route('POST', '/models/:name/enable', enableModel),
];

const mcpRoutes = [
  route('GET', '/mcp', listMcp),
  route('POST', '/mcp', createMcp),
  route('DELETE', '/mcp/:name', deleteMcp),
  route('GET', '/mcp-registry', (req, ctx, params, url) => mcpRegistry(req, ctx, url)),
];

const flowsRoutes = [
  route('GET', '/flows', listFlows),
  route('GET', '/pulls', listPulls),
  route('POST', '/flows/:name/run', runFlow),
  route('POST', '/review', review),
];

/** The admin table before its guard; tests dispatch through it with their own contexts. */
export const adminTable = group('/admin', [
  ...usageRoutes,
  ...foldersRoutes,
  ...enginesRoutes,
  ...appsRoutes,
  ...agentsRoutes,
  ...credentialsRoutes,
  ...runnersRoutes,
  ...tasksRoutes,
  ...configRoutes,
  ...modelsRoutes,
  ...mcpRoutes,
  ...flowsRoutes,
]);
const adminRoutes = adminTable.map(entry => ({ ...entry, guard: adminGuard(entry.guard) }));

export const routes = [
  ...callbacksRoutes,
  ...adminRoutes,
  ...authRoutes,
  ...platformRoutes,
  ...pagesRoutes,
];
