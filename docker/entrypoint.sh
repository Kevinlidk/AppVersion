#!/bin/sh
# 启动前把镜像内源码同步到数据卷挂载点(保留宿主 data/ 数据):
#   /opt/appversion-src  镜像内只读源码
#   /opt/appversion      运行时目录(通常被 ./appversion/ 绑定挂载)
# 升级镜像后重启容器,代码自动更新;应用数据都在 data/ 子目录,不受影响。
set -e

SRC=/opt/appversion-src
DST=/opt/appversion

mkdir -p "$DST"
cp -a "$SRC/." "$DST/"

cd "$DST"
exec node docker/server.mjs
