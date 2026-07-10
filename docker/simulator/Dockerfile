FROM node:20-slim
WORKDIR /sim
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY sim.js ./
CMD ["node", "sim.js"]
