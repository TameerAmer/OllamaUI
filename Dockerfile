# -----------------------------
# 1. Build Stage
# -----------------------------
FROM node:20-alpine AS builder

# Set working directory
WORKDIR /app

# Install dependencies first (better cache)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Set build-time variable (defaults to localhost)
ARG OLLAMA_URL=http://localhost:11434
ENV OLLAMA_URL=${OLLAMA_URL}

# Copy source code
COPY . .

# Build Next.js app
RUN npm run build

# -----------------------------
# 2. Runtime Stage
# -----------------------------
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV OLLAMA_URL=http://localhost:11434
ENV PORT=3000

# Install only production deps (lighter image)
COPY package.json package-lock.json ./
RUN npm ci --only=production --legacy-peer-deps

# Copy only what's needed to run
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Expose port
EXPOSE 3000

# Run Next.js
CMD ["npm", "start"]
