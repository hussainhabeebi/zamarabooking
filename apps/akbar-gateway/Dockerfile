# Build dist first using the repository-pinned pnpm and the supplied build script.
# Docker context: repository root. No whole-repository or secret-file COPY.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3002
WORKDIR /app
COPY --chown=node:node apps/akbar-gateway/package.json ./package.json
COPY --chown=node:node apps/akbar-gateway/src ./src
COPY --chown=node:node apps/akbar-gateway/dist ./dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:3002/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","src/server.mjs"]
