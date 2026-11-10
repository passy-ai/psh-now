# syntax=docker/dockerfile:1

# Same shape as the other services on the box: alpine base, dependencies in their
# own stage, a non-root user in the runtime image, and one explicit port.
#
# ---- deps: install once, cached on the package files ----
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----
FROM oven/bun:1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV HOSTNAME="0.0.0.0"

# The app never needs root: nothing it does touches the image, and it binds 3000
# rather than a privileged port.
RUN addgroup --system --gid 1001 psh \
 && adduser --system --uid 1001 --ingroup psh psh

COPY --chown=psh:psh --from=deps /app/node_modules ./node_modules
COPY --chown=psh:psh package.json bun.lock drizzle.config.ts tsconfig.json ./
COPY --chown=psh:psh src ./src
COPY --chown=psh:psh drizzle ./drizzle
COPY --chown=psh:psh public ./public
COPY --chown=psh:psh website ./website
COPY --chown=psh:psh cli ./cli
COPY --chown=psh:psh skills ./skills
COPY --chown=psh:psh install.sh ./install.sh
# MIT requires the licence to travel with the image, and /license serves it.
COPY --chown=psh:psh LICENSE THIRD_PARTY.md ./

USER psh
EXPOSE 3000

# Apply migrations on boot, then run the gateway. Postgres may still be starting,
# so retry before giving up rather than exiting on the first refusal.
CMD ["sh", "-c", "for i in 1 2 3 4 5 6 7 8 9 10; do bun src/db/migrate.ts && break; echo \"migrate retry $i…\"; sleep 2; done; exec bun src/index.ts"]

# Probe loopback by address, not by name. Inside the alpine runtime the `bun -e`
# probe did not resolve `localhost`, so the healthcheck failed while the server
# was up and listening on 0.0.0.0:3000 — Swarm then killed a healthy task every
# ~85 seconds and the domain never kept a backend. src/index.ts probes
# 127.0.0.1 for the same reason. The probe now also says *why* it failed
# instead of exiting silently.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>{if(!r.ok)console.error('health: HTTP '+r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error('health: '+e);process.exit(1)})"]
