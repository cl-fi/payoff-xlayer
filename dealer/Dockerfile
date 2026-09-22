FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dealer/requirements.txt dealer/requirements.txt
RUN python3 -m venv /opt/theta && /opt/theta/bin/pip install --no-cache-dir -r dealer/requirements.txt
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/package.json
COPY web/package.json web/package.json
COPY dealer/package.json dealer/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @payoff/self-dealer && npm cache clean --force
COPY sdk sdk
COPY dealer/src dealer/src
COPY dealer/theta dealer/theta
RUN chmod -R a+rX /app && mkdir -p /var/lib/payoff-dealer && chown node:node /var/lib/payoff-dealer
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8081 THETA_PYTHON=/opt/theta/bin/python
USER node
WORKDIR /app/dealer
EXPOSE 8081
CMD ["node", "src/main.mjs"]
