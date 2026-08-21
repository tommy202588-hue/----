# 群晖 DSM Docker 部署

该方案只把 Web 容器发布到 NAS 的 `5111` 端口。API 容器仅存在于 Docker 内部网络，不映射到 NAS 或公网。

## 1. 准备部署目录

在群晖共享文件夹中建立目录：

```text
/volume1/docker/x-tapnow
```

将项目上传到该目录，把 `.env.deploy.example` 复制为 `.env`，然后修改：

- `PUBLIC_ORIGINS`：最终 HTTPS 地址，例如 `https://canvas.example.com`。
- `ALLOWED_UPSTREAM_HOSTS`：允许用户配置的 AI API 域名。
- `ALLOWED_DOWNLOAD_HOSTS`：允许服务器下载图片的供应商或 CDN 域名。
- `UPLOAD_PROXY_TARGET`：可选的完整 HTTPS 上传接口；留空时禁用 `/api/upload`。

不要在 `.env` 中填写共享 API Key 或 Token。每位网页用户在自己的浏览器中填写凭据。

## 2. 构建并启动

临时开启 DSM SSH，连接 NAS 后执行：

```bash
cd /volume1/docker/x-tapnow
sudo docker-compose config
sudo docker-compose up -d --build
sudo docker-compose ps
```

如果系统使用新版命令，将 `docker-compose` 换成 `docker compose`。

完成后先在局域网访问：

```text
http://192.168.0.103:5111
```

## 3. 配置 DSM 反向代理

打开“控制面板 > 登录门户 > 高级 > 反向代理服务器”，新建规则：

- 来源协议：`HTTPS`
- 来源主机名：`canvas.example.com`
- 来源端口：`443`
- 目的地协议：`HTTP`
- 目的地主机名：`127.0.0.1`
- 目的地端口：`5111`

为同一个子域名绑定 HTTPS 证书，并确保 DNS 指向当前已经能从公网访问 NAS 的入口。

Nginx 配置已经信任当前 NAS 地址 `192.168.0.103` 和标准 Docker 网桥，用于获取真实访客 IP。如果 NAS 地址发生变化，需要同步修改 `deploy/nginx.conf` 中对应的 `set_real_ip_from`，然后重新构建。

不要向公网开放 DSM `5000/5001`、API `5112`、Docker 管理端口或 SSH。网站只需要公网 HTTPS `443`；部署完成后应再次关闭 SSH。

## 4. 更新与诊断

```bash
cd /volume1/docker/x-tapnow
sudo docker-compose up -d --build
sudo docker-compose ps
sudo docker-compose logs --tail=100 web api
```

健康检查地址：

```text
http://192.168.0.103:5111/healthz
https://canvas.example.com/healthz
```

自定义供应商返回 `403 target_not_allowed` 时，只把该供应商的准确域名加入对应白名单并重建容器。不要配置覆盖整个公共域名后缀的通配规则。
