# ---------- 构建 / 验收阶段（compose verify 服务使用此 target） ----------
FROM node:20-alpine AS builder
WORKDIR /app

# 优先复制依赖清单，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# 构建产物到 dist（verify 服务会再次执行 test+build+smoke 并以退出码报告）
RUN npm run build

# ---------- 静态站点运行阶段（compose web 服务） ----------
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
