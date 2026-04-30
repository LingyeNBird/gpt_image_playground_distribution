# ---- Frontend build ----
FROM node:20-alpine AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Backend build ----
FROM golang:1.22-alpine AS backend
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/gip-server .

# ---- Runtime ----
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
ENV DATA_DIR=/data
ENV STATIC_DIR=/app/dist
ENV ADDR=:8080
COPY --from=frontend /app/dist /app/dist
COPY --from=backend /out/gip-server /app/gip-server
VOLUME ["/data"]
EXPOSE 8080
CMD ["/app/gip-server"]
