# GPT Image Playground Distribution

这是 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 的前后端分离分发版。它在原有图片生成/编辑 Web UI 基础上增加了 Go 后端、登录注册、管理员分发管理、用户额度、腾讯云 COS 存储桶模式和 Docker 持久化部署。

## 主要变化

- **必须登录访问**：普通用户可自行注册用户名和密码；管理员使用管理员密钥登录。
- **上游 API 只在后端保存**：普通用户前端看不到 API URL / API Key，生成请求统一经由 Go 后端转发。
- **管理员分发管理**：用户管理、在线状态、生成中任务数、额度、禁用/封禁、失败日志。
- **两种分发模式**：
  - **直传模式**：后端直接把生成结果返回给用户前端。
  - **存储桶模式**：后端上传结果到腾讯云 COS，只返回临时链接；用户关闭页面后任务仍可继续执行。
- **持久化配置**：用户、设置、管理员密钥、失败日志等保存在 `/data`，Docker Compose 默认挂载到宿主机 `./data`。
- **GHCR 镜像发布**：GitHub Actions 负责构建并推送 Docker 镜像，本地不需要构建发布镜像。

> 当前后端生成代理优先支持 `Images API`。管理员设置中保留了 `Responses API` 选项，但后端会提示暂未实现。

## 快速部署

### 1. 使用 Docker Compose

仓库内已提供 `docker-compose.yml`：

```yaml
services:
  gpt-image-playground:
    image: ghcr.io/lingyenbird/gpt_image_playground_distribution:latest
    build:
      context: .
      dockerfile: Dockerfile
    container_name: gpt-image-playground
    ports:
      - "58946:8080"
    volumes:
      - ./data:/data
    restart: unless-stopped
```

启动：

```bash
docker compose up -d
```

访问：

```text
http://localhost:58946/
```

### 2. 首次获取管理员密钥

首次启动时，如果 `./data/admin-key.enc` 不存在，后端会生成管理员密钥，并在 Docker 日志中输出一次明文：

```bash
docker logs gpt-image-playground
```

也可以使用 Taskfile：

```bash
task admin-key
```

日志示例：

```text
IMPORTANT: initial admin key: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
IMPORTANT: encrypted admin key saved to /data/admin-key.enc
```

请保存该密钥。密钥会加密写入 `./data/admin-key.enc`；只要保留 `./data` 目录，重建容器不会丢失。

## 管理员使用流程

1. 打开 `http://localhost:58946/`。
2. 选择 **管理员** 登录方式，输入管理员密钥。
3. 进入 **分发管理**：
   - **用户管理**：添加用户、禁用用户、封禁用户、设置额度、设置直传/存储桶权限、查看在线状态和失败日志。
   - **存储设置**：添加腾讯云 COS 存储桶配置，并查看桶内图片数量。
   - **上游设置**：配置上游 API URL、API Key、模型、超时和兼容模式。

普通用户注册后默认额度为 `0`，需要管理员在用户管理里分配额度。

## 用户使用流程

1. 打开 `http://localhost:58946/`。
2. 注册或登录普通用户账号。
3. 管理员分配额度后即可生成图片。
4. 右上角设置仅显示分发模式：
   - 如果管理员开启了直传模式，可以选择直传。
   - 如果管理员开启了存储桶模式，可以选择存储桶。

普通用户无法看到或修改上游 API URL / API Key。

## Taskfile 常用命令

项目使用 [Task](https://taskfile.dev/) 管理常用命令。

```bash
task --list
```

### 本地运行与维护

```bash
# 安装依赖
task deps

# 运行前端测试 + Go 后端测试
task test

# 本地构建并启动 Compose 服务（调试用）
task up

# 查看运行状态
task ps

# 查看日志
task logs

# 拉取 GHCR 最新镜像
task pull

# 拉取最新镜像并重建服务
task redeploy

# 停止服务（保留 ./data）
task down
```

### 发布 Docker 镜像

发布镜像不在本地构建，而是触发 GitHub Actions 在 GitHub 侧构建并推送到 GHCR。

```bash
# 触发 GitHub Actions 构建并推送 GHCR
task docker:publish

# 触发后等待运行完成
task docker:publish-watch
```

可选的本地 Docker 构建仅用于调试：

```bash
task docker:build-local
```

## GitHub Actions / GHCR

工作流文件：

```text
.github/workflows/docker.yml
```

触发方式：

- push 到 `main`
- push `v*` tag
- 手动 `workflow_dispatch`
- `task docker:publish`

镜像地址：

```text
ghcr.io/lingyenbird/gpt_image_playground_distribution:latest
```

## 持久化数据

默认 Compose 挂载：

```text
./data:/data
```

后端会在 `/data` 中保存：

- `state.json`：用户、额度、上游设置、存储桶配置、任务状态、失败日志等。
- `server.key`：用于加密管理员密钥的本地密钥。
- `admin-key.enc`：加密后的管理员密钥。

> 重要：请备份 `./data`。删除该目录会导致用户、设置和管理员密钥丢失。

## 技术栈

- 前端：React 19 + TypeScript + Vite + Tailwind CSS + Zustand
- 后端：Go
- 存储：文件型 JSON 持久化（适合 10 人以内轻量使用）
- 对象存储：腾讯云 COS
- 容器：Docker / Docker Compose
- 镜像仓库：GitHub Container Registry

## 安全说明

- API Key 仅保存在后端持久化文件中，不会下发给普通用户前端。
- 普通用户看到的错误信息会脱敏 URL / API Key；管理员失败日志保存完整上下文用于排查。
- 存储桶模式返回的是腾讯云 COS 临时链接，请合理设置临时链接有效期。

## License

本项目基于上游项目 MIT License 改造。详见 [LICENSE](LICENSE)。
