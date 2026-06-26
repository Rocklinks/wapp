FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY . .

RUN mkdir -p /data/sessions /data/uploads /data/exports

ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "server.js"]
