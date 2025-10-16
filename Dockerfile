# Stage 1: Builder - Install dependencies and prepare the app
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package.json files first to leverage Docker cache
COPY download/Player/package.json download/Player/package-lock.json ./download/Player/

# Install root dependencies

# Install agent dependencies
WORKDIR /app/download/Player
RUN npm install

# Go back to the root and copy the rest of the application source code
WORKDIR /app
# [修复] 将 "COPY docker ." 修改为 "COPY . ."
COPY . .

# ---

# Stage 2: Final - Create the final, lean image
# Use the official Playwright image to ensure all system dependencies for browsers are present.
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

# Set working directory
WORKDIR /app

# Copy installed dependencies and source code from the builder stage
COPY --from=builder /app/download/Player/node_modules ./download/Player/node_modules
COPY --from=builder /app .

# Expose the ports the application runs on
# 9528 for HTTP (Web App & Media Proxy)
# 9527 for WebSocket
EXPOSE 9528
EXPOSE 9527

# Command to run the application
CMD ["node", "download/Player/agent.js"]