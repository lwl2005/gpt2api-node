# 使用 Node.js 18 LTS 版本
FROM node:18-alpine

# 设置工作目录与生产环境
WORKDIR /app
ENV NODE_ENV=production

# 仅复制依赖清单并安装生产依赖，减少镜像层体积
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# 仅复制运行时必须文件，避免将本地数据库/文档等无关内容打进镜像
COPY src ./src
COPY public ./public
COPY models.json ./models.json

# 创建数据库目录（可由外部卷挂载覆盖）
RUN mkdir -p /app/database

# 暴露端口
EXPOSE 3000

# 启动命令
CMD ["npm", "start"]
