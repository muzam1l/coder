# Coder on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/muzam1l/coder&root-directory=src/server/deploy/vercel&project-name=coder&stores=%5B%7B%22type%22%3A%22postgres%22%7D%5D&env=SERVER_ENCRYPTION_KEY&envDescription=SERVER_ENCRYPTION_KEY%20encrypts%20stored%20credentials%20and%20derives%20the%20sign-in%20keys%2C%20from%20openssl%20rand%20-base64%2032)

One click deploys a Coder server with its Postgres provisioned alongside it: the address platforms deliver events to, plus the pages `coder server app create <integration>` opens. The function runs on Bun, tasks run in Vercel Sandbox, and the public URL is the deployment's own.

The button provisions Postgres and asks for `SERVER_ENCRYPTION_KEY` (encrypts stored credentials and derives the sign-in keys), from `openssl rand -base64 32`. Sign-in with Wular is automatic; then run `coder auth login --server <url>`. Tasks are kicked after requests through Vercel's `waitUntil`; there is no worker process or Dockerfile. Optional: `PUBLIC_URL` for a custom domain and `AUTH_WULAR_URL` for a self-hosted issuer. The provisioned store's `POSTGRES_URL` (or a `DATABASE_URL` you set) is the database; run `coder server migrate` against it once.

Deploying by hand: this directory is the Vercel project root. Every route goes through the catch-all handler.
