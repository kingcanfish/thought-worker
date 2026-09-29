# 自建服务器：一个容器同时负责接收 webhook 和提供静态站点；构建由宿主机 cron 触发：
#   docker exec thought-worker node dist/node/build/main.js
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:node

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production STORAGE=fs DATA_DIR=/data SITE_DIR=/data/site PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/node ./dist/node
COPY migrations ./migrations
COPY public ./public
COPY site.env ./
# 不用 root 跑；/data 归 node 用户，命名卷会继承这个属主
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/node/adapters/node/server.js"]
