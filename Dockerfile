FROM node:22-alpine

# 源码先复制到不可变的镜像内目录,由 entrypoint 在启动时同步到数据卷挂载点
# (用户的 compose 把 ./appversion/ 绑定挂载到 /opt/appversion/,bind mount
#  首次会以宿主空目录遮蔽镜像内文件,所以代码必须在启动时同步过去,
#  而宿主 data/ 数据目录在源码中不存在、不会被触碰)
COPY . /opt/appversion-src
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=80 \
    NODE_ENV=production

WORKDIR /opt/appversion
EXPOSE 80

HEALTHCHECK --interval=60s --timeout=10s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/session" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
