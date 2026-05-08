# ---- Frontend build ----
FROM node:20-alpine AS frontend
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- Backend build ----
FROM golang:1.22-alpine AS backend
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY VERSION.backend VERSION.frontend /src/
RUN BACKEND_VERSION=$(tr -d '[:space:]' < /src/VERSION.backend) \
  && FRONTEND_VERSION=$(tr -d '[:space:]' < /src/VERSION.frontend) \
  && CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-s -w -X main.backendVersion=${BACKEND_VERSION} -X main.frontendVersion=${FRONTEND_VERSION}" \
    -o /out/gip-server .

# ---- Runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
ENV DATA_DIR=/data
ENV STATIC_DIR=/app/dist
ENV ADDR=:8080
COPY --from=frontend /app/dist /app/dist
COPY --from=backend /out/gip-server /app/gip-server
EXPOSE 8080
CMD ["/app/gip-server"]
