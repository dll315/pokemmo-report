FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# 零依赖：只拷源码，不跑 npm install
COPY package.json ./
# 版本戳：没有这个文件，容器里跑起来的站点报不出自己是哪一版（server.js 读 /app/BUILDINFO）
COPY BUILDINFO ./
COPY server.js ./
COPY src ./src
COPY public ./public
COPY tools ./tools
COPY data ./data

# .dockerignore 已排除 db.json / config.json，容器里只带静态参考表

# 图鉴图已经随仓库发布（public/assets/sprites，0.36MB），默认这步不用开。
# 只有想要第五世代动图（多 17MB）或想换一批图时才打开，失败不影响网站可用。
ARG SPRITE_BASE=https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white
ARG MIRROR_SPRITES=0
RUN if [ "$MIRROR_SPRITES" = "1" ]; then \
      SPRITE_BASE="$SPRITE_BASE" node tools/mirror-sprites.js --only-universe --with-animated \
      || echo "!! 图鉴图镜像失败，网站照常运行（用仓库自带的那批）"; \
    fi

EXPOSE 3580
VOLUME ["/app/data"]

HEALTHCHECK --interval=90s --timeout=15s --start-period=120s \
  CMD wget -q -O /dev/null http://127.0.0.1:3580/api/board || exit 1

CMD ["node", "server.js", "--host=0.0.0.0"]
