export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function htmlResponse(body: string, status = 200): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
