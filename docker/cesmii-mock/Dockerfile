FROM node:20-slim
WORKDIR /mock
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY server.js ./
EXPOSE 4000
CMD ["node", "server.js"]
