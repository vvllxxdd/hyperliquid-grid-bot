# Use slim Node.js 20 LTS image
FROM node:20-slim

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install --ignore-scripts

# Copy the rest of the app
COPY . .

# Build the TypeScript code
RUN npm run build

# Set environment to production
ENV NODE_ENV=production

# Run the bot
CMD ["node", "dist/index.js"]