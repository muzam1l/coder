import {
  accountAllowed,
  adminGuard,
  adminOnly,
  agentSettingsAllowed,
  apiAllowed,
  connectionOAuthAllowed,
  contextGuard,
  createAllowed,
  credentialAllowed,
  dashboardAllowed,
  dashboardTokenAllowed,
  engineAllowed,
  inboxGuard,
  installAllowed,
  localOnly,
  loginAllowed,
  logsGuard,
  loginGuard,
  metadataAllowed,
  oauthAllowed,
  operatorOnly,
  operatorPageAllowed,
  pageSession,
  requireWorkspaceAdmin,
  secretsGuard,
  signInAllowed,
  taskAccess,
  taskCreateAllowed,
  taskGuard,
} from './guards';
import { group, mount, route, type Params } from './match';
import { dashboard, dashboardToken, home, loginPage, signIn } from '../dash/serve';
import { health, metrics } from '../health';
import { json, notFound } from './http';
import {
  ackMessages,
  heartbeat,
  readContext,
  readMessages,
  taskConnection,
  refreshCredential,
  reportResult,
  reportLogs,
  sendReaction,
  sendReply,
} from '../tasks/callbacks';
import { listHistory, readHistory, saveHistory } from '../tasks/logs';
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
import {
  adminCreateTransaction,
  completeCreate,
  completeCreateForm,
  createPage,
  createStart,
} from '../agents/create';
import { completeInstall, installPage } from '../agents/install';
import { completeOAuth, meRoute, startOAuth } from '../auth/members';
import { MCP_CLIENT_PATH, oauthCallback, oauthClientDocument } from '../connections/oauth';
import { hook, listFlows, listPulls, runFlow } from '../tasks/flows';
import { type ServerContext } from '../context';
import { readUsage, readUsageTotals } from '../tasks/usage';
import { checkFolder, cloneFolder, localFolders, pickFolder } from '../settings/folders';
import { engineStatus } from '../tasks/local';
import {
  createCredential,
  deleteCredential,
  listCredentials,
  signInEngine,
  signOutEngine,
} from '../settings/credentials';
import {
  adminInstallLink,
  adminRepositories,
  integrationCatalog,
  listApps,
  listInstallations,
  readDrift,
  removeApp,
  uninstallApp,
  updateApp,
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
  composerOptions,
  listTasks,
  readTask,
  removeTask,
  steerTask,
  taskLogs,
} from '../tasks/admin';
import { taskEvents, taskStream } from '../tasks/stream';
import { decideRequest, listPendingApprovals } from '../tasks/changes';
import { configSchemaDocument, patchConfiguration, readConfig } from '../settings/config';
import { CONFIG_SCHEMA_URL } from '../../core/config';
import {
  aliasModel,
  createModel,
  deleteModel,
  disableModel,
  enableModel,
  listModels,
  probe,
  updateModel,
} from '../settings/models';
import { mcpRegistry } from '../settings/mcp';
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  authorizeConnection,
  connectionAllowed,
} from '../connections/records';
import { auditLog, operatorApps, setUpApp, sharedAppDrift, updateSharedApp } from '../operator';
import {
  CLI_CLIENT_PATH,
  RESOURCE_PATH,
  WEB_CLIENT_PATH,
  cliDocument,
  resourceDocument,
  webDocument,
} from '../auth/metadata';

import { runnerPackage } from '../runners/package';

const pagesRoutes = [
  route('GET', '/runner/:file', runnerPackage),
  route('GET', MCP_CLIENT_PATH, oauthClientDocument),
  route('GET', WEB_CLIENT_PATH, webDocument, { guard: metadataAllowed }),
  route('GET', CLI_CLIENT_PATH, cliDocument, { guard: metadataAllowed }),
  route('GET', RESOURCE_PATH, resourceDocument, { guard: metadataAllowed }),
  route('GET', '/health', (req, ctx) => health(ctx)),
  route('GET', new URL(CONFIG_SCHEMA_URL).pathname, configSchemaDocument),
  route('GET', '/', home, { guard: pageSession }),
  route('GET', '/login', signIn, { guard: signInAllowed }),
  ...mount('/login', loginPage, signInAllowed).filter(entry => entry.method !== 'GET'),
  route('POST', '/dash/token', dashboardToken, { guard: dashboardTokenAllowed }),
  ...mount('/dash/:org/operator', dashboard, operatorPageAllowed),
  ...mount('/dash', dashboard, dashboardAllowed),
];

const authRoutes = [
  route('GET', '/api/auth/capabilities', (req, ctx) => json({ wular: ctx.auth?.issuer ?? null })),
  ...mount('/api/auth', (req, ctx) => ctx.auth!.handler(req), apiAllowed),
  route('GET', '/me', meRoute, { guard: accountAllowed }),
];

const callbacksRoutes = [
  ...group('/tasks', [
    route('GET', '/:id/messages', readMessages, { guard: inboxGuard }),
    route('POST', '/:id/ack', ackMessages, { guard: inboxGuard }),
    route('POST', '/:id/heartbeat', heartbeat, { guard: inboxGuard }),
    route('POST', '/:id/logs', reportLogs, { guard: logsGuard }),
    route('POST', '/:id/result', reportResult, { guard: secretsGuard }),
    route('POST', '/:id/credential', refreshCredential, { guard: secretsGuard }),
    route('POST', '/:id/connection', taskConnection, { guard: taskGuard }),
    route('POST', '/:id/reply', sendReply, { guard: taskGuard }),
    route('POST', '/:id/react', sendReaction, { guard: taskGuard }),
    route('GET', '/:id/history', listHistory, { guard: taskGuard }),
    route('GET', '/:id/history/:conversation', readHistory, { guard: taskGuard }),
    route('POST', '/:id/history', saveHistory, { guard: secretsGuard }),
    route('GET', '/:id', readContext, { guard: contextGuard }),
  ]),
  ...group('/logins', [
    route('GET', '/:id/input', takeLoginInput, { guard: loginGuard }),
    route('GET', '/:id', readLoginEngine, { guard: loginGuard }),
    route('POST', '/:id', reportLogin, { guard: loginGuard }),
  ]),
  ...group('/runners', [route('POST', '/register', registerRunner)]),
];

const provisionRoutes = [
  ...group('/create', [
    route('GET', '/:id', createPage, { guard: createAllowed }),
    route('POST', '/:id', createStart, { guard: createAllowed }),
    route('GET', '/:id/callback', completeCreate, { guard: createAllowed }),
    route('POST', '/:id/callback', completeCreateForm, { guard: createAllowed }),
  ]),
  ...group('/install', [
    route('GET', '/:id', installPage, { guard: installAllowed }),
    route('POST', '/:id', installPage, { guard: installAllowed }),
    route('GET', '/:id/callback', completeInstall, { guard: installAllowed }),
    route('POST', '/:id/callback', completeInstall, { guard: installAllowed }),
  ]),
];

const connectRoutes = group('/connect', [
  route('GET', '/:integration', startOAuth, { guard: oauthAllowed }),
  route('GET', '/:integration/callback', completeOAuth, { guard: oauthAllowed }),
]);

const known = (req: Request, ctx: ServerContext, params: Params) =>
  ctx.integrations[params['*']!] ? ctx : notFound();

const hooksRoutes = group('/hooks', [
  route('POST', '/*', (req, ctx, params) => hook(req, ctx, params['*']!), { guard: known }),
]);

const platformRoutes = [...hooksRoutes, ...provisionRoutes, ...connectRoutes];

const usageRoutes = [
  route(
    'GET',
    '/metrics',
    async (req, ctx) => json(await metrics(ctx), 200, { 'cache-control': 'no-store' }),
    { guard: adminOnly },
  ),
  route('GET', '/usage', readUsage, { approvalPolicy: 'allow' }),
  route('GET', '/usage/totals', readUsageTotals, { approvalPolicy: 'allow' }),
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
    route('GET', '/engines/status', async (req, ctx) => json(await engineStatus(ctx))),
    route('POST', '/engines/:engine/login', signInEngine),
    route('POST', '/engines/:engine/logout', signOutEngine),
  ],
  engineAllowed,
);

const appsRoutes = [
  route('POST', '/apps/:id/install', (req, ctx, params, url) =>
    adminInstallLink(req, ctx, params.id!, url.searchParams.get('back')),
  ),
  route('POST', '/apps/create/:integration', adminCreateTransaction),
  route('GET', '/apps', listApps),
  route('DELETE', '/apps/:id', removeApp),
  route('GET', '/apps/:id/drift', readDrift),
  route('POST', '/apps/:id/update', updateApp),
  route('GET', '/installations', listInstallations),
  route('DELETE', '/installations/:id', uninstallApp, {
    guard: (req, ctx) => requireWorkspaceAdmin(ctx, 'Only an owner or admin can uninstall an app.'),
  }),
  route('GET', '/connections', listConnections, {
    guard: connectionAllowed,
    approvalPolicy: 'allow',
  }),
  route('POST', '/connections', createConnection, { guard: connectionAllowed }),
  route('PATCH', '/connections/:id', updateConnection, { guard: connectionAllowed }),
  route('DELETE', '/connections/:id', deleteConnection, { guard: connectionAllowed }),
  route('POST', '/connections/:id/authorize', authorizeConnection, { guard: connectionAllowed }),
  route('GET', '/integrations', (req, ctx, params, url) => integrationCatalog(ctx, url)),
  route('GET', '/repositories', (req, ctx) => adminRepositories(ctx)),
  route('POST', '/repositories/refresh', (req, ctx) => adminRepositories(ctx, true)),
];

const agentsRoutes = [
  route('GET', '/agents/import', previewImport),
  route('POST', '/agents/import', importAgent),
  route('GET', '/agents', listAgents, { approvalPolicy: 'allow' }),
  route('PATCH', '/agents/:slug/settings', updateSettings, {
    guard: agentSettingsAllowed,
    approvalPolicy: 'ask',
    change: 'agent-settings',
  }),
  route('GET', '/agents/:slug/versions', listVersions),
  route('GET', '/agents/:slug/versions/:version', readVersion, { approvalPolicy: 'allow' }),
  route('GET', '/agents/:slug', readAgent, { approvalPolicy: 'allow' }),
  route('DELETE', '/agents/:slug', deleteAgent, {
    guard: (req, ctx) => requireWorkspaceAdmin(ctx, 'Only an owner or admin can delete an agent.'),
  }),
  route('PUT', '/agents/:slug', publish, { approvalPolicy: 'ask', change: 'agent-version' }),
];

const credentialsRoutes = [
  route('GET', '/credentials', listCredentials, { approvalPolicy: 'allow' }),
  route('POST', '/credentials', createCredential, { guard: credentialAllowed }),
  route('DELETE', '/credentials/:name', deleteCredential),
  route('POST', '/logins', createLogin, { guard: loginAllowed }),
  route('GET', '/logins/:id', readLogin, { guard: loginAllowed }),
  route('POST', '/logins/:id', answerLogin, { guard: loginAllowed }),
  route('DELETE', '/logins/:id', cancelLogin, { guard: loginAllowed }),
];

const runnersRoutes = [
  route('GET', '/runners', listRunners, { approvalPolicy: 'allow' }),
  route('POST', '/runners', createRunner),
  route('POST', '/runners/pair', pairRunner),
  route('POST', '/runners/:id/test', checkRunner),
  route('PATCH', '/runners/:id', updateRunner, {
    approvalPolicy: 'ask',
    change: 'runner-default',
  }),
  route('DELETE', '/runners/:id', deleteRunner),
];

const tasksRoutes = [
  route('GET', '/composer', composerOptions),
  route('GET', '/tasks', listTasks, { approvalPolicy: 'allow' }),
  route('POST', '/tasks', adminCreate, { guard: taskCreateAllowed, approvalPolicy: 'allow' }),
  route('GET', '/tasks/:id', readTask, { guard: taskAccess(), approvalPolicy: 'allow' }),
  route('DELETE', '/tasks/:id', removeTask, { guard: taskAccess() }),
  route('GET', '/tasks/:id/logs', taskLogs, { guard: taskAccess(), approvalPolicy: 'allow' }),
  route('GET', '/tasks/:id/stream', taskStream, { guard: taskAccess(), approvalPolicy: 'allow' }),
  route('POST', '/tasks/:id/steer', steerTask, {
    guard: taskAccess(true),
    approvalPolicy: 'allow',
  }),
  route('POST', '/tasks/:id/ask', askTask, { guard: taskAccess(true), approvalPolicy: 'allow' }),
  route('POST', '/tasks/:id/approve', approveTask, {
    guard: taskAccess(true),
    approvalPolicy: 'allow',
  }),
  route('POST', '/tasks/:id/requests/:approval', decideRequest, { guard: taskAccess() }),
  route('GET', '/approvals/pending', (req, ctx) => listPendingApprovals(ctx), { guard: adminOnly }),
  route('POST', '/tasks/:id/cancel', cancelTask, { guard: taskAccess(), approvalPolicy: 'allow' }),
  route('POST', '/tasks/:id/archive', archiveTask, {
    guard: taskAccess(),
    approvalPolicy: 'allow',
  }),
  route('GET', '/events', taskEvents, { approvalPolicy: 'allow' }),
];

const configRoutes = [
  route('GET', '/config', readConfig),
  route('PATCH', '/config', patchConfiguration),
];

const modelsRoutes = [
  route('POST', '/models/probe', (req, ctx) => probe(req, ctx)),
  route('GET', '/models', listModels, { approvalPolicy: 'allow' }),
  route('POST', '/models', createModel),
  route('DELETE', '/models/:name', deleteModel),
  route('PATCH', '/models/:name', updateModel, {
    approvalPolicy: 'ask',
    change: 'model-update',
  }),
  route('POST', '/models/:name/alias', aliasModel, {
    approvalPolicy: 'ask',
    change: 'model-alias',
  }),
  route('POST', '/models/:name/disable', disableModel, {
    approvalPolicy: 'ask',
    change: 'model-disable',
  }),
  route('POST', '/models/:name/enable', enableModel, {
    approvalPolicy: 'ask',
    change: 'model-enable',
  }),
];

const mcpRoutes = [
  route('GET', '/mcp-registry', (req, ctx, params, url) => mcpRegistry(req, ctx, url)),
];

const operatorRoutes = group(
  '/operator',
  [
    route('GET', '/apps', operatorApps),
    route('POST', '/apps/:integration', setUpApp),
    route('GET', '/apps/:integration/drift', sharedAppDrift),
    route('POST', '/apps/:integration/update', updateSharedApp),
    route('GET', '/audit', auditLog),
  ],
  operatorOnly,
);

const flowsRoutes = [
  route('GET', '/flows', listFlows),
  route('GET', '/pulls', listPulls),
  route('POST', '/flows/:name/run', runFlow),
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
  ...operatorRoutes,
]);
const adminRoutes = adminTable.map(entry => ({ ...entry, guard: adminGuard(entry.guard, entry) }));

export const routes = [
  route(
    'GET',
    '/connections/oauth/callback',
    (req, ctx, params, url) => oauthCallback(req, ctx, url),
    { guard: connectionOAuthAllowed },
  ),
  ...callbacksRoutes,
  ...adminRoutes,
  ...authRoutes,
  ...platformRoutes,
  ...pagesRoutes,
];
