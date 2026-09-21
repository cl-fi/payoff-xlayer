FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts --workspace @payoff/rfq-gateway --include-workspace-root
COPY sdk sdk
COPY gateway/tsconfig.json gateway/tsconfig.json
COPY gateway/src gateway/src
RUN npm run build:gateway

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @payoff/rfq-gateway && npm cache clean --force
COPY --from=build /app/sdk ./sdk
COPY --from=build /app/gateway/dist ./gateway/dist
USER node
WORKDIR /app/gateway
EXPOSE 8080
CMD ["node", "dist/main.js"]
