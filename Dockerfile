# Multi-stage production image for the analytics platform.

# ---- Stage 1: build ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies (including dev) for the build.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources to dist/.
COPY . .
RUN npm run build

# Drop dev dependencies for the runtime layer.
RUN npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy only what the runtime needs.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Run as the built-in non-root user shipped by the node image.
USER node

EXPOSE 3000
CMD ["node", "dist/main.js"]
