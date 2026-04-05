# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Install wget for health checks and bash for debugging (optional)
RUN apk add --no-cache wget bash

# Set working directory
WORKDIR /app

# Copy server package files
COPY server/package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy server files
COPY server/ ./

# Copy web app (frontend) - server expects it in parent directory
COPY web-app-public/ /web-app-public/

# Create data directory for SQLite database (in parent directory)
RUN mkdir -p /data && chmod 777 /data

# Switch to non-root user for security (commented out temporarily for debugging)
# USER node

# Expose port
EXPOSE 3000

# Health check - use 127.0.0.1 instead of localhost to force IPv4
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Start the application
CMD ["npm", "start"]
