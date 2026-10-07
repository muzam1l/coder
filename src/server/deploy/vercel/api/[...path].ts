import { server } from '@wular/coder';
import { waitUntil } from '@vercel/functions';

const handler = server.handler(process.env);
const route = (request: Request) => handler(request, waitUntil);

export const GET = route;
export const POST = route;
export const PUT = route;
export const PATCH = route;
export const DELETE = route;
export const HEAD = route;
export const OPTIONS = route;
