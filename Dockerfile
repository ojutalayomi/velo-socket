# Build stage
FROM node:22-alpine AS build
WORKDIR /app

# Install all dependencies (including devDependencies for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled output and static assets
COPY --from=build /app/dist ./dist
COPY public/ ./public/

EXPOSE 8080
CMD ["node", "dist/app.js"]
