FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# Mount a persistent disk at /var/data so clients and data survive deploys.
ENV DATA_DIR=/var/data/data CLIENTS_DIR=/var/data/clients PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
