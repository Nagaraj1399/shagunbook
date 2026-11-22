FROM node:20-alpine
WORKDIR /app
COPY package.json server.js flags.local.json ./
COPY public ./public
ENV PORT=8080 DB_PATH=/data/data.json
RUN mkdir -p /data
EXPOSE 8080
CMD ["node", "server.js"]
